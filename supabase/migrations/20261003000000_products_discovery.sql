-- Products: discovered vs approved, evidence, image reads, AI visibility.
-- Safe to re-run. Run in the Supabase SQL editor BEFORE the product discovery worker.
--
-- What this does
--  1. status gets a third value, 'dismissed' (so the worker never re-suggests a rejected product),
--     and the default flips from 'discovered' to 'approved' (owner-created rows are approved).
--  2. Every existing row is backfilled to 'approved'. They were only 'discovered' because of the old
--     column default, and nothing ever approved them.
--  3. New product columns: ai_visible, aliases, dedupe_key, evidence counters, observed prices.
--  4. New tables: product_mentions (proof for each discovered product) and product_image_reads
--     (each distinct chat image is read once, never twice).
--  5. Row level security: owner can select/insert/update/delete own products. The old policies broke
--     for a user who owns more than one business and there was no delete policy.
--  6. The vectorize and polish triggers (both call paid edge functions) fire only for APPROVED
--     products, so discovered suggestions cost nothing until the owner approves them.
--  6b. category + category_source so the AI knows which products go together.
--  7. product-images storage bucket for photos recovered from chats.

-- 1. status ---------------------------------------------------------------------------------------
alter table public.products drop constraint if exists products_status_check;
alter table public.products
  add constraint products_status_check check (status in ('discovered', 'approved', 'dismissed'));
alter table public.products alter column status set default 'approved';

-- 3. new columns (added before the backfill so discovered_at can tell old rows from new ones) -----
alter table public.products add column if not exists ai_visible         boolean     not null default true;
alter table public.products add column if not exists aliases            text[]      not null default '{}';
alter table public.products add column if not exists dedupe_key         text;
alter table public.products add column if not exists discovered_at      timestamptz;
alter table public.products add column if not exists approved_at        timestamptz;
alter table public.products add column if not exists dismissed_at       timestamptz;
alter table public.products add column if not exists mention_count      integer     not null default 0;
alter table public.products add column if not exists last_mentioned_at  timestamptz;
alter table public.products add column if not exists price_source       text;
alter table public.products add column if not exists observed_prices    jsonb       not null default '[]'::jsonb;
alter table public.products add column if not exists discovery_run_id   uuid;
alter table public.products add column if not exists discovery_confidence numeric(3,2);
alter table public.products add column if not exists discovery_meta     jsonb       not null default '{}'::jsonb;
alter table public.products add column if not exists category            text;
alter table public.products add column if not exists category_source     text;   -- ai | owner | import

comment on column public.products.status is 'discovered = found in chats or images, waiting for the owner; approved = live catalog the AI may use; dismissed = rejected, never re-suggested.';
comment on column public.products.ai_visible is 'Owner switch: false hides an approved product from the analyser, persona pack and chat AI. Independent of is_visible, which belongs to the storefront.';
comment on column public.products.aliases is 'Other names customers and the owner use for this product. Used for matching chat mentions.';
comment on column public.products.dedupe_key is 'Normalised title used by the discovery worker to avoid duplicates.';
comment on column public.products.category is 'Short shelf label (e.g. Lash extensions). Lets the AI know which products go together. Suggested by discovery, editable by the owner.';
comment on column public.products.price_source is 'owner | import | chat | image | unknown';
comment on column public.products.observed_prices is 'Prices seen in chats and images: [{"price":2500,"count":4,"last_seen":"..."}]. Never overwrites price on an approved product.';

-- 2. backfill: everything that existed before this migration was created by the owner ------------
update public.products
   set status = 'approved',
       approved_at = coalesce(created_at, now())
 where status = 'discovered'
   and discovered_at is null;

create index if not exists idx_products_category on public.products (business_id, category) where category is not null;
create index if not exists idx_products_biz_status on public.products (business_id, status);
create index if not exists idx_products_dedupe on public.products (business_id, dedupe_key) where dedupe_key is not null;

-- stamp approved_at / dismissed_at whenever status changes, so the app never has to
create or replace function public.products_status_stamp() returns trigger
language plpgsql as $$
begin
  if new.status is distinct from old.status then
    if new.status = 'approved' then
      new.approved_at := now();
      new.dismissed_at := null;
    elsif new.status = 'dismissed' then
      new.dismissed_at := now();
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists products_status_stamp on public.products;
create trigger products_status_stamp before update of status on public.products
  for each row execute function public.products_status_stamp();

-- 6. paid edge-function triggers: approved products only ------------------------------------------
drop trigger if exists on_product_created on public.products;
create trigger on_product_created after insert on public.products
  for each row when (new.status = 'approved')
  execute function public.handle_new_product_vectorization();

drop trigger if exists on_product_created_polish on public.products;
create trigger on_product_created_polish after insert on public.products
  for each row when (new.status = 'approved')
  execute function public.trigger_polish_product();

-- a discovered product that the owner approves gets the same treatment a manual add gets
drop trigger if exists on_product_approved on public.products;
create trigger on_product_approved after update of status on public.products
  for each row when (old.status is distinct from 'approved' and new.status = 'approved')
  execute function public.handle_new_product_vectorization();

drop trigger if exists on_product_approved_polish on public.products;
create trigger on_product_approved_polish after update of status on public.products
  for each row when (old.status is distinct from 'approved' and new.status = 'approved')
  execute function public.trigger_polish_product();

-- 4a. evidence: why the worker thinks the business sells this ------------------------------------
create table if not exists public.product_mentions (
  id             uuid primary key default gen_random_uuid(),
  business_id    text not null,
  product_id     text not null references public.products(id) on delete cascade,
  run_id         uuid,
  kind           text not null check (kind in ('text', 'image')),
  source_ref     text not null,          -- messages.id for text, image key for an image
  message_id     uuid,
  contact_id     bigint,
  quote          text,                   -- redacted owner line or caption
  observed_name  text,
  observed_price numeric,
  image_url      text,
  send_count     integer not null default 1,
  contact_count  integer not null default 1,
  observed_at    timestamptz,
  created_at     timestamptz not null default now(),
  unique (product_id, kind, source_ref)
);
create index if not exists idx_product_mentions_biz on public.product_mentions (business_id, product_id);
alter table public.product_mentions enable row level security;
drop policy if exists product_mentions_owner_select on public.product_mentions;
create policy product_mentions_owner_select on public.product_mentions
  for select to authenticated
  using (business_id in (select b.business_id from public.businesses b where b.user_id = auth.uid()));

-- 4b. every distinct chat image is read once ------------------------------------------------------
create table if not exists public.product_image_reads (
  business_id   text not null,
  image_key     text not null,           -- WhatsApp file hash, storage url or thumbnail hash
  image_type    text,                    -- product_photo | price_list | menu | poster | other | private
  items         jsonb not null default '[]'::jsonb,
  image_url     text,
  low_res       boolean not null default false,
  source        text,                    -- storage | whatsapp | thumbnail
  send_count    integer,
  contact_count integer,
  status        text not null default 'read' check (status in ('read', 'unreachable', 'failed')),
  error         text,
  read_at       timestamptz not null default now(),
  primary key (business_id, image_key)
);
alter table public.product_image_reads enable row level security;   -- no policies: service role only

-- 5. row level security on products --------------------------------------------------------------
drop policy if exists business_select_products on public.products;
drop policy if exists business_insert_products on public.products;
drop policy if exists business_update_products on public.products;
drop policy if exists business_delete_products on public.products;

create policy business_select_products on public.products for select to authenticated
  using (business_id in (select b.business_id from public.businesses b where b.user_id = auth.uid()));
create policy business_insert_products on public.products for insert to authenticated
  with check (business_id in (select b.business_id from public.businesses b where b.user_id = auth.uid()));
create policy business_update_products on public.products for update to authenticated
  using (business_id in (select b.business_id from public.businesses b where b.user_id = auth.uid()))
  with check (business_id in (select b.business_id from public.businesses b where b.user_id = auth.uid()));
create policy business_delete_products on public.products for delete to authenticated
  using (business_id in (select b.business_id from public.businesses b where b.user_id = auth.uid()));

-- 7. storage for product photos -------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-images', 'product-images', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists product_images_owner_insert on storage.objects;
create policy product_images_owner_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'product-images' and exists (
    select 1 from public.businesses b
     where b.user_id = auth.uid() and b.business_id = (storage.foldername(objects.name))[1]));
drop policy if exists product_images_owner_update on storage.objects;
create policy product_images_owner_update on storage.objects for update to authenticated
  using (bucket_id = 'product-images' and exists (
    select 1 from public.businesses b
     where b.user_id = auth.uid() and b.business_id = (storage.foldername(objects.name))[1]))
  with check (bucket_id = 'product-images' and exists (
    select 1 from public.businesses b
     where b.user_id = auth.uid() and b.business_id = (storage.foldername(objects.name))[1]));
drop policy if exists product_images_owner_delete on storage.objects;
create policy product_images_owner_delete on storage.objects for delete to authenticated
  using (bucket_id = 'product-images' and exists (
    select 1 from public.businesses b
     where b.user_id = auth.uid() and b.business_id = (storage.foldername(objects.name))[1]));
