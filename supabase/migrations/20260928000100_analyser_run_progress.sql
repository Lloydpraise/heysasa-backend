-- Live progress for analyser runs. Additive only; safe to run more than once.
alter table public.enrichment_runs
  add column if not exists phase          text,          -- classify | ads | structural | nlp | rollups | done
  add column if not exists progress_done  integer,
  add column if not exists progress_total integer,
  add column if not exists heartbeat_at   timestamptz,   -- last time the run reported in
  add column if not exists summary        jsonb,         -- final tallies for the run
  add column if not exists classify_counts jsonb;

create index if not exists enrichment_runs_business_started_idx
  on public.enrichment_runs (business_id, started_at desc);
