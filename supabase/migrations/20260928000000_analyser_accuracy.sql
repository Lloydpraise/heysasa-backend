-- Analyser v2: separation metadata, analysis versioning, evidence, run counts.
-- Additive only. Safe to run more than once.

alter table public.contacts
  add column if not exists lead_type_source        text,          -- 'llm' | 'ad' | 'state' | 'manual'
  add column if not exists lead_type_reason        text,
  add column if not exists lead_type_confidence    numeric,
  add column if not exists lead_type_classified_at timestamptz,
  add column if not exists analysis_version        integer,       -- which analyser rules produced the scores
  add column if not exists intent_evidence         text;          -- verbatim customer quote behind the intent

alter table public.enrichment_runs
  add column if not exists classify_counts jsonb;

create index if not exists contacts_business_lead_type_idx
  on public.contacts (business_id, lead_type);

-- Close out runs that were killed mid-flight and are stuck on "running".
update public.enrichment_runs
   set status = 'failed',
       finished_at = coalesce(finished_at, now()),
       fatal_error = coalesce(fatal_error, 'stale: process ended without finishing')
 where status = 'running'
   and started_at < now() - interval '6 hours';
