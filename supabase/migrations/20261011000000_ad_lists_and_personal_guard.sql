-- Ad lists + "personal stays personal".
-- Safe to run twice. Run in the Supabase SQL editor on the VVStudios project.
--
-- 1. Ad lists: one list per ad, filled automatically with the leads that came in through that ad.
--    The Lists page gets Auto / Ads / Manual tabs; the Ads tab reads these.
-- 2. Personal guard: once the owner marks a chat as personal (or any other "not a customer" type), nothing in the
--    system can flip it back (ad referral, history sync, analyser), and the chat is pulled out of every list and any
--    running campaign.

-- ── 1. Ad lists ──────────────────────────────────────────────────────────────────────────────────────────────────

alter table public.lists add column if not exists ad_id text;

alter table public.lists drop constraint if exists lists_type_check;
alter table public.lists
  add constraint lists_type_check check (type = any (array['auto'::text, 'manual'::text, 'ad'::text]));

create unique index if not exists lists_business_ad_uidx
  on public.lists (business_id, ad_id) where ad_id is not null;

-- The base view gains the ad columns at the end (existing columns keep their order, so replacing is safe).
create or replace view public.v_list_summary_base as
 select li.id as list_id,
    li.business_id,
    li.name,
    li.type,
    li.rule_id,
    li.archived,
    li.disabled_at,
    count(lm.lead_id) as total_contacts,
    0::numeric as est_pipeline_value,
    count(lm.lead_id) filter (where lead_status(lm.lead_id) = 'ready'::text) as ready_count,
    count(lm.lead_id) filter (where lead_status(lm.lead_id) = 'in_campaign'::text) as in_campaign_count,
    count(lm.lead_id) filter (where lead_status(lm.lead_id) = 'opted_out'::text) as opted_out_count,
    li.ad_id,
    coalesce(
      (select aa.ad_headline from public.ad_attributions aa where aa.business_id = li.business_id and aa.ad_id = li.ad_id and aa.ad_headline is not null limit 1),
      (select c.ad_headline from public.contacts c where c.business_id = li.business_id and coalesce(c.original_ad_id, c.ad_id) = li.ad_id and c.ad_headline is not null order by c.ad_attributed_at desc nulls last limit 1)
    ) as ad_headline,
    coalesce(
      (select aa.ad_thumbnail_url from public.ad_attributions aa where aa.business_id = li.business_id and aa.ad_id = li.ad_id and aa.ad_thumbnail_url is not null limit 1),
      (select c.ad_thumbnail_url from public.contacts c where c.business_id = li.business_id and coalesce(c.original_ad_id, c.ad_id) = li.ad_id and c.ad_thumbnail_url is not null order by c.ad_attributed_at desc nulls last limit 1)
    ) as ad_thumbnail_url,
    coalesce(
      (select aa.ad_platform from public.ad_attributions aa where aa.business_id = li.business_id and aa.ad_id = li.ad_id and aa.ad_platform is not null limit 1),
      (select c.ad_platform from public.contacts c where c.business_id = li.business_id and coalesce(c.original_ad_id, c.ad_id) = li.ad_id and c.ad_platform is not null order by c.ad_attributed_at desc nulls last limit 1)
    ) as ad_platform
   from public.lists li
     left join public.list_members lm on lm.list_id = li.id
  group by li.id;

create or replace view public.v_list_summary with (security_invoker = false) as
 select list_id,
    business_id,
    name,
    type,
    rule_id,
    archived,
    disabled_at,
    total_contacts,
    est_pipeline_value,
    ready_count,
    in_campaign_count,
    opted_out_count,
    ad_id,
    ad_headline,
    ad_thumbnail_url,
    ad_platform
   from public.v_list_summary_base
  where (select auth.role()) = 'service_role'::text or business_id in (select public.my_business_ids());

-- Makes sure every ad that brought in leads has its own list and that each list holds exactly the right leads.
-- p_business_id null = every business (the engine's background tick). Safe to call as often as you like.
create or replace function public.sync_ad_lists(p_business_id text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  t_created int := 0; t_added int := 0; t_removed int := 0; t_renamed int := 0;
begin
  -- Signed-in owners may only sync their own business; the engine (service role) and the SQL editor may sync any.
  if auth.role() is not null and auth.role() <> 'service_role' then
    if p_business_id is null or p_business_id not in (select public.my_business_ids()) then
      raise exception 'not allowed';
    end if;
  end if;

  with ads as (
    select c.business_id,
           coalesce(c.original_ad_id, c.ad_id) as ad_key,
           (array_agg(c.ad_headline order by c.ad_attributed_at desc nulls last) filter (where nullif(trim(c.ad_headline), '') is not null))[1] as headline
      from public.contacts c
     where c.is_ad_lead
       and coalesce(c.original_ad_id, c.ad_id) is not null
       and coalesce(c.lead_type, 'business') not in ('personal', 'vendor', 'staff', 'junk')
       and (p_business_id is null or c.business_id = p_business_id)
     group by 1, 2
  ), ins as (
    insert into public.lists (business_id, name, type, ad_id)
    select a.business_id, coalesce(nullif(trim(a.headline), ''), 'Ad ' || right(a.ad_key, 6)), 'ad', a.ad_key
      from ads a
    on conflict (business_id, ad_id) where ad_id is not null do nothing
    returning 1
  )
  select count(*) into t_created from ins;

  -- A list that was named before we knew the ad's headline picks the headline up once we do.
  with fixed as (
    update public.lists l
       set name = h.headline
      from (
        select c.business_id, coalesce(c.original_ad_id, c.ad_id) as ad_key,
               (array_agg(trim(c.ad_headline) order by c.ad_attributed_at desc nulls last) filter (where nullif(trim(c.ad_headline), '') is not null))[1] as headline
          from public.contacts c
         where c.is_ad_lead and coalesce(c.original_ad_id, c.ad_id) is not null
         group by 1, 2
      ) h
     where l.type = 'ad' and l.business_id = h.business_id and l.ad_id = h.ad_key
       and h.headline is not null
       and l.name = 'Ad ' || right(l.ad_id, 6)
       and (p_business_id is null or l.business_id = p_business_id)
    returning 1
  )
  select count(*) into t_renamed from fixed;

  with ins as (
    insert into public.list_members (list_id, lead_id)
    select l.id, c.id
      from public.lists l
      join public.contacts c on c.business_id = l.business_id and c.is_ad_lead and coalesce(c.original_ad_id, c.ad_id) = l.ad_id
     where l.type = 'ad' and not l.archived
       and coalesce(c.lead_type, 'business') not in ('personal', 'vendor', 'staff', 'junk')
       and (p_business_id is null or l.business_id = p_business_id)
    on conflict do nothing
    returning 1
  )
  select count(*) into t_added from ins;

  with del as (
    delete from public.list_members lm
     using public.lists l
     where lm.list_id = l.id and l.type = 'ad' and not l.archived
       and (p_business_id is null or l.business_id = p_business_id)
       and not exists (
         select 1 from public.contacts c
          where c.id = lm.lead_id and c.business_id = l.business_id and c.is_ad_lead
            and coalesce(c.original_ad_id, c.ad_id) = l.ad_id
            and coalesce(c.lead_type, 'business') not in ('personal', 'vendor', 'staff', 'junk')
       )
    returning 1
  )
  select count(*) into t_removed from del;

  return jsonb_build_object('created', t_created, 'renamed', t_renamed, 'added', t_added, 'removed', t_removed);
end
$fn$;

grant execute on function public.sync_ad_lists(text) to authenticated, service_role;

-- ── 2. Personal stays personal ───────────────────────────────────────────────────────────────────────────────────

-- A chat the owner has labelled (lead_type_source = 'manual', or an old "personal" with no source) keeps that label no
-- matter what writes to it later: an ad referral, a history sync, the analyser. The owner changing it from the app stamps
-- lead_type_classified_at, which is how a real change is told apart from an automatic overwrite.
create or replace function public.contacts_guard_manual_type()
returns trigger
language plpgsql
set search_path to 'public'
as $fn$
begin
  if new.lead_type is distinct from old.lead_type
     and (old.lead_type_source = 'manual' or (old.lead_type = 'personal' and old.lead_type_source is null))
     and new.lead_type_classified_at is not distinct from old.lead_type_classified_at then
    new.lead_type := old.lead_type;
  end if;
  return new;
end
$fn$;

drop trigger if exists trg_contacts_guard_manual_type on public.contacts;
create trigger trg_contacts_guard_manual_type
  before update of lead_type on public.contacts
  for each row execute function public.contacts_guard_manual_type();

-- The moment a chat becomes a non-customer it leaves every list and any campaign it was in.
create or replace function public.contacts_drop_non_customer()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
begin
  if new.lead_type in ('personal', 'vendor', 'staff', 'junk') and new.lead_type is distinct from old.lead_type then
    delete from public.list_members where lead_id = new.id;
    update public.campaign_enrollments set status = 'exited'
     where lead_id = new.id and status in ('pending', 'active', 'awaiting_opt_in');
    update public.follow_up_queue set status = 'cancelled', skip_reason = 'not_a_customer'
     where contact_id = new.id and status in ('pending', 'ready_to_send');
  end if;
  return null;
end
$fn$;

drop trigger if exists trg_contacts_drop_non_customer on public.contacts;
create trigger trg_contacts_drop_non_customer
  after update of lead_type on public.contacts
  for each row execute function public.contacts_drop_non_customer();

-- One-time tidy: chats that are already non-customers but still sit in a list or an open campaign.
delete from public.list_members lm using public.contacts c
 where c.id = lm.lead_id and c.lead_type in ('personal', 'vendor', 'staff', 'junk');

update public.campaign_enrollments ce set status = 'exited'
  from public.contacts c
 where c.id = ce.lead_id and c.lead_type in ('personal', 'vendor', 'staff', 'junk')
   and ce.status in ('pending', 'active', 'awaiting_opt_in');

update public.follow_up_queue q set status = 'cancelled', skip_reason = 'not_a_customer'
  from public.contacts c
 where c.id = q.contact_id and c.lead_type in ('personal', 'vendor', 'staff', 'junk')
   and q.status in ('pending', 'ready_to_send');

-- Build the ad lists now so the Ads tab is full the first time it is opened.
select public.sync_ad_lists(null);
