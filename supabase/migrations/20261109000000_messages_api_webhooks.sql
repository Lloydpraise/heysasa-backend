-- Messages API + status webhooks: another app (Lashtribe first) decides WHAT to send and WHEN; HeySasa only sends it
-- and reports back. See MESSAGES_API.md.
--
--   * POST /v1/messages writes a business_events row with event_type 'message': the caller's own text, and an image /
--     video / document link in `media`. The same engine (eventSender.js) sends it, with the same antiban, number check,
--     billing and do-not-contact rules as every other event.
--   * Everything that happens to that row is written to webhook_deliveries by the triggers below, and the engine posts
--     each one, signed, to the key's webhook_url (webhookDispatcher.js), retrying with back-off.
--       message.sent / message.failed / message.skipped / message.cancelled   the row's own status
--       message.delivered / message.read                                      WhatsApp receipts (messages.status)
--       message.received                                                      the person wrote back (within 30 days)
--       contact.opted_out                                                     they wrote STOP (contact -> do_not_contact)
--
-- Needs 20261030000000_events_api.sql first. Safe to re-run. Only the service role touches these tables.

alter table public.api_keys
  add column if not exists webhook_url    text check (webhook_url is null or webhook_url ~ '^https://'),
  add column if not exists webhook_secret text;

alter table public.business_events
  add column if not exists media        jsonb,          -- { type: image|video|document, url, caption?, file_name?, mime_type? }
  add column if not exists delivered_at timestamptz,
  add column if not exists read_at      timestamptz,
  add column if not exists replied_at   timestamptz;

-- an image or video alone, with no words, is a valid message
alter table public.business_events alter column message set default '';

create table if not exists public.webhook_deliveries (
  id               uuid primary key default gen_random_uuid(),
  business_id      text not null references public.businesses(business_id) on delete cascade,
  api_key_id       uuid not null references public.api_keys(id) on delete cascade,
  event_id         uuid references public.business_events(id) on delete set null,
  kind             text not null,
  payload          jsonb not null,
  status           text not null default 'pending' check (status in ('pending', 'delivered', 'failed')),
  attempts         integer not null default 0,
  next_attempt_at  timestamptz not null default now(),
  response_status  integer,
  last_error       text,
  created_at       timestamptz not null default now(),
  delivered_at     timestamptz
);
create index if not exists webhook_deliveries_due_idx on public.webhook_deliveries (next_attempt_at) where status = 'pending';
create index if not exists webhook_deliveries_key_idx on public.webhook_deliveries (api_key_id, created_at desc);
alter table public.webhook_deliveries enable row level security;
revoke all on public.webhook_deliveries from anon, authenticated;

-- the inbound-reply lookup: the latest API message sent to this contact
create index if not exists business_events_contact_sent_idx
  on public.business_events (contact_id, sent_at desc) where api_key_id is not null and status = 'sent';
create index if not exists business_events_wamid_idx
  on public.business_events (whatsapp_message_id) where whatsapp_message_id is not null;

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'webhook_deliveries') then
    alter publication supabase_realtime add table public.webhook_deliveries;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- one door: queue a callback for an event, if its key has a webhook
-- ---------------------------------------------------------------------
create or replace function public.queue_partner_webhook(p_event public.business_events, p_kind text, p_extra jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_url text;
begin
  if p_event.api_key_id is null then return; end if;
  select webhook_url into v_url from public.api_keys where id = p_event.api_key_id and revoked_at is null;
  if coalesce(v_url, '') = '' then return; end if;
  insert into public.webhook_deliveries (business_id, api_key_id, event_id, kind, payload)
  values (p_event.business_id, p_event.api_key_id, p_event.id, p_kind, jsonb_build_object(
    'type', p_kind,
    'created_at', now(),
    'data', jsonb_build_object(
      'id', p_event.id,
      'event', p_event.event_type,
      'external_id', p_event.external_id,
      'phone', '+' || p_event.phone,
      'status', case when p_kind in ('message.delivered', 'message.read') then split_part(p_kind, '.', 2) else p_event.status end,
      'error', case when p_event.status in ('failed', 'skipped', 'cancelled') then p_event.last_error end,
      'metadata', coalesce(p_event.payload -> 'metadata', '{}'::jsonb),
      'sent_at', p_event.sent_at,
      'delivered_at', p_event.delivered_at,
      'read_at', p_event.read_at
    ) || coalesce(p_extra, '{}'::jsonb)
  ));
exception when others then
  raise warning 'partner webhook not queued: %', sqlerrm;   -- a callback problem must never block a send or a receipt
end $$;
revoke all on function public.queue_partner_webhook(public.business_events, text, jsonb) from public, anon, authenticated;

-- 1. the event's own outcome
create or replace function public._business_events_webhook_trg() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.queue_partner_webhook(new, 'message.' || new.status);
  return new;
end $$;
drop trigger if exists business_events_webhook on public.business_events;
create trigger business_events_webhook after update of status on public.business_events
  for each row when (new.status is distinct from old.status and new.status in ('sent', 'failed', 'skipped', 'cancelled') and new.api_key_id is not null)
  execute function public._business_events_webhook_trg();

-- 2. WhatsApp receipts (apply_message_receipt moves messages.status: sent -> delivered -> read, or ERROR)
create or replace function public._messages_receipt_webhook_trg() returns trigger
language plpgsql security definer set search_path = public as $$
declare e public.business_events;
begin
  select * into e from public.business_events
    where whatsapp_message_id = new.whatsapp_message_id and business_id = new.business_id and api_key_id is not null
    limit 1;
  if e.id is null then return new; end if;
  if new.status = 'ERROR' then
    update public.business_events set status = 'failed', last_error = 'whatsapp_delivery_error' where id = e.id and status = 'sent';
    -- the status trigger above sends message.failed
  elsif new.status in ('delivered', 'read') then
    update public.business_events
       set delivered_at = coalesce(delivered_at, new.delivered_at, now()),
           read_at = case when new.status = 'read' then coalesce(read_at, new.read_at, now()) else read_at end
     where id = e.id
     returning * into e;
    perform public.queue_partner_webhook(e, 'message.' || new.status);
  end if;
  return new;
exception when others then
  raise warning 'receipt webhook: %', sqlerrm;
  return new;
end $$;
drop trigger if exists messages_receipt_webhook on public.messages;
create trigger messages_receipt_webhook after update of status on public.messages
  for each row when (new.agent_role = 'events_api' and new.direction = 'out' and new.status is distinct from old.status)
  execute function public._messages_receipt_webhook_trg();

-- 3. the person wrote back (or asked us to stop)
create or replace function public._messages_reply_webhook_trg() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  e public.business_events;
  v_text text := btrim(coalesce(new.content ->> 'text', new.content ->> 'caption', ''));
  v_stop boolean;
begin
  if new.contact_id is null then return new; end if;
  select * into e from public.business_events
    where contact_id = new.contact_id and api_key_id is not null and status = 'sent' and sent_at > now() - interval '30 days'
    order by sent_at desc limit 1;
  if e.id is null then return new; end if;

  update public.business_events set replied_at = coalesce(replied_at, now()) where id = e.id returning * into e;
  perform public.queue_partner_webhook(e, 'message.received', jsonb_build_object(
    'reply', jsonb_build_object('text', left(v_text, 2000), 'type', coalesce(new.type, new.content ->> 'type', 'text'), 'received_at', new.created_at)
  ));

  v_stop := lower(regexp_replace(v_text, '[^[:alpha:] ]', '', 'g')) in ('stop', 'unsubscribe', 'stop all', 'stop messages', 'acha', 'cancel', 'opt out', 'optout');
  if v_stop then
    update public.contacts set do_not_contact = true where id = new.contact_id;
    update public.business_events set status = 'cancelled', last_error = 'opted_out'
      where contact_id = new.contact_id and status = 'scheduled';
    perform public.queue_partner_webhook(e, 'contact.opted_out', jsonb_build_object('reply', jsonb_build_object('text', left(v_text, 200))));
  end if;
  return new;
exception when others then
  raise warning 'reply webhook: %', sqlerrm;
  return new;
end $$;
drop trigger if exists messages_reply_webhook on public.messages;
create trigger messages_reply_webhook after insert on public.messages
  for each row when (new.direction = 'in' and new.contact_id is not null)
  execute function public._messages_reply_webhook_trg();
