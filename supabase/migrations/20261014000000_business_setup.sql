-- Onboarding setup state: one row per business. The setup runner (src/setup) writes it, Home reads it
-- through GET /setup/status. Nothing else reads or writes this table, so it is safe to run on its own.
create table if not exists public.business_setup (
  business_id        text primary key,
  status             text not null default 'idle'
                       check (status in ('idle','waiting_history','running','home_ready','finishing','done','failed')),
  phase              text,
  bundles_done       integer not null default 0,
  bundles_total      integer not null default 0,
  contacts_total     integer not null default 0,
  thin               boolean not null default false,   -- history had (almost) no chats
  answers            jsonb   not null default '{}'::jsonb,
  error              text,
  started_at         timestamptz,
  home_ready_at      timestamptz,
  finished_at        timestamptz,
  ready_message_sent_at timestamptz,                   -- reserved for the "Aha! set up is done" WhatsApp message
  updated_at         timestamptz not null default now()
);

alter table public.business_setup enable row level security;
-- No policies on purpose: only the backend (service role) touches this table.
