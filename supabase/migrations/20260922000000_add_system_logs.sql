-- Persists the live debug console's events so history survives restarts
-- and deploys (the in-memory buffer alone only holds the last 5000).
create table if not exists public.system_logs (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  level text not null check (level in ('debug','info','ok','warn','error')),
  area text not null,
  event text not null,
  message text,
  business_id text,
  contact_id bigint,
  entity_id text,
  duration_ms integer,
  details jsonb
);

create index if not exists system_logs_ts_idx on public.system_logs (ts desc);
create index if not exists system_logs_area_ts_idx on public.system_logs (area, ts desc);
create index if not exists system_logs_business_ts_idx on public.system_logs (business_id, ts desc);
create index if not exists system_logs_problem_idx on public.system_logs (ts desc) where level in ('warn','error');

-- Written and read only by the backend's service-role key — never by the
-- browser — so RLS stays enabled with no public policies.
alter table public.system_logs enable row level security;
