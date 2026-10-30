-- Events API: a client's website tells HeySasa that something happened (an abandoned cart, a paid order) and HeySasa
-- sends the customer a WhatsApp message for it. See EVENTS_API.md.
--
--   api_keys         one secret key per website (only its SHA-256 hash is stored; the key is shown once)
--   event_templates  the business's own wording, delay and switch per event type (built-in defaults live in code)
--   business_events  every event received, with the rendered message and its delivery status
--
-- The follow-up engine sends business_events rows (sender-baileys/eventSender.js). It is woken by a realtime INSERT on
-- business_events plus one timer for the earliest delayed row, so nothing polls the database while idle.
-- Only the service role touches these tables: the dashboard goes through the backend.

create table if not exists public.api_keys (
  id            uuid primary key default gen_random_uuid(),
  business_id   text not null references public.businesses(business_id) on delete cascade,
  account_id    uuid references public.accounts(id) on delete cascade,
  label         text not null default 'Website',
  key_prefix    text not null,
  key_hash      text not null unique,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
create index if not exists api_keys_business_idx on public.api_keys (business_id) where revoked_at is null;

create table if not exists public.event_templates (
  id                   uuid primary key default gen_random_uuid(),
  business_id          text not null references public.businesses(business_id) on delete cascade,
  event_type           text not null check (event_type ~ '^[a-z0-9_]+(\.[a-z0-9_]+)*$' and length(event_type) <= 60),
  enabled              boolean not null default true,
  body                 text not null check (length(body) between 1 and 1000),
  delay_minutes        integer not null default 0 check (delay_minutes between 0 and 10080),
  respect_quiet_hours  boolean not null default false,
  -- For the official WhatsApp Business API later: the approved template's name and language. Unused until then.
  waba_template_name   text,
  waba_language        text,
  updated_at           timestamptz not null default now(),
  unique (business_id, event_type)
);

create table if not exists public.business_events (
  id                   uuid primary key default gen_random_uuid(),
  business_id          text not null references public.businesses(business_id) on delete cascade,
  account_id           uuid references public.accounts(id) on delete set null,
  api_key_id           uuid references public.api_keys(id) on delete set null,
  event_type           text not null,
  external_id          text,
  phone                text not null,
  name                 text,
  payload              jsonb not null default '{}'::jsonb,
  contact_id           bigint references public.contacts(id) on delete set null,
  conversation_id      text,
  message              text not null,
  respect_quiet_hours  boolean not null default false,
  status               text not null default 'scheduled'
                       check (status in ('scheduled', 'sending', 'sent', 'failed', 'cancelled', 'skipped')),
  send_at              timestamptz not null default now(),
  attempts             integer not null default 0,
  last_error           text,
  failure_class        text,
  whatsapp_message_id  text,
  claimed_at           timestamptz,
  sent_at              timestamptz,
  created_at           timestamptz not null default now()
);
-- The same event sent twice (a retry on the website's side) is one event.
create unique index if not exists business_events_idempotency_idx
  on public.business_events (business_id, event_type, external_id) where external_id is not null;
create index if not exists business_events_due_idx on public.business_events (send_at) where status = 'scheduled';
create index if not exists business_events_business_idx on public.business_events (business_id, created_at desc);
create index if not exists business_events_contact_idx on public.business_events (contact_id, status);
-- The antiban reloads the last hour of sends per number after a restart.
create index if not exists business_events_sent_idx on public.business_events (business_id, sent_at) where status = 'sent';

alter table public.api_keys enable row level security;
alter table public.event_templates enable row level security;
alter table public.business_events enable row level security;
revoke all on public.api_keys, public.event_templates, public.business_events from anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'business_events') then
    alter publication supabase_realtime add table public.business_events;
  end if;
end $$;
