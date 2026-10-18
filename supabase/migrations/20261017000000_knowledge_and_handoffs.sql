-- Knowledge (file search) for the chat AI and the follow-up AI, and handoff alerts.
-- Safe to re-run. Needs the `vector` extension (already on VVStudios) and billing v2.
--
-- KNOWLEDGE
--   knowledge_sources  one row per thing the owner uploads or pastes (a PDF, an image, a clip, a note), with what it is,
--                      when the AI should use it, and which AI uses it (chat / follow-up / both).
--   knowledge_chunks   the searchable text of each source, cut into pieces and stored as vectors.
--   match_knowledge_chunks()   the file-search function both AIs call.
--   business-knowledge (storage, private)   the original files, kept first, then analysed by the backend.
--
-- HANDOFFS
--   handoff_events     one row per handoff, with who should be told. The backend sends the WhatsApp DM from the HeySasa
--                      number and marks the row. Home reads the open ones from conversations.handover_*.
--   The rules themselves (who gets which case) live in businesses.chat_ai_settings.handoff (jsonb), written by the
--   backend route PUT /handoff/config and read by the chat AI.

create extension if not exists vector;

-- ── Knowledge ───────────────────────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.knowledge_sources (
  id uuid primary key default gen_random_uuid(),
  business_id text not null,
  title text not null check (char_length(title) between 1 and 120),
  use_case text not null default '' check (char_length(use_case) <= 600),
  kind text not null default 'other' check (kind in ('procedure', 'catalogue', 'policy', 'product_info', 'faq', 'other')),
  file_type text not null default 'text' check (file_type in ('pdf', 'image', 'audio', 'video', 'document', 'text')),
  used_by text not null default 'both' check (used_by in ('chat', 'followup', 'both')),
  is_active boolean not null default true,
  status text not null default 'processing' check (status in ('processing', 'ready', 'failed')),
  status_detail text,
  storage_path text,
  file_name text,
  mime_type text,
  size_bytes bigint,
  raw_text text,                                      -- only for pasted notes, so they can be edited
  summary text,                                       -- a short plain-words summary made during analysis
  chunk_count integer not null default 0,
  content_chars integer not null default 0,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  processed_at timestamptz
);
create index if not exists idx_knowledge_sources_business on public.knowledge_sources (business_id, created_at desc);

create table if not exists public.knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.knowledge_sources (id) on delete cascade,
  business_id text not null,
  chunk_index integer not null,
  page integer,
  content text not null,
  embedding vector(1536),
  created_at timestamptz not null default now()
);
-- No vector index on purpose: every search is for one business (a few thousand rows at most), and an approximate index
-- filtered by business can return too few rows. The exact scan is fast at this size.
create index if not exists idx_knowledge_chunks_business on public.knowledge_chunks (business_id);
create index if not exists idx_knowledge_chunks_source on public.knowledge_chunks (source_id, chunk_index);

alter table public.knowledge_sources enable row level security;
alter table public.knowledge_chunks enable row level security;

-- The owner can read their own sources (the dashboard lists them). Every write goes through the backend.
drop policy if exists knowledge_sources_owner_read on public.knowledge_sources;
create policy knowledge_sources_owner_read on public.knowledge_sources for select
  using (business_id in (select b.business_id from public.businesses b where b.user_id = auth.uid()));

-- File search. p_bot: 'chat' or 'followup' keeps only sources that bot may use ('both' always passes); null keeps all.
create or replace function public.match_knowledge_chunks(
  p_business_id text, p_embedding vector(1536), p_count integer default 4, p_threshold double precision default 0.25,
  p_bot text default null, p_source_id uuid default null
) returns table (
  chunk_id uuid, source_id uuid, title text, use_case text, file_type text, page integer, content text, similarity double precision
)
language sql stable as $$
  select c.id, s.id, s.title, s.use_case, s.file_type, c.page, c.content, 1 - (c.embedding <=> p_embedding) as similarity
  from public.knowledge_chunks c
  join public.knowledge_sources s on s.id = c.source_id
  where c.business_id = p_business_id
    and s.status = 'ready'
    and s.is_active
    and c.embedding is not null
    and (p_bot is null or s.used_by in ('both', p_bot))
    and (p_source_id is null or s.id = p_source_id)
    and 1 - (c.embedding <=> p_embedding) > p_threshold
  order by c.embedding <=> p_embedding
  limit greatest(1, least(p_count, 12));
$$;

-- Analysis of an uploaded file is an AI run like any other, so it is billed (multiplier editable in /admin).
insert into public.billing_runners (runner_id, label, user_label, multiplier_key) values
  ('knowledge_analysis', 'Knowledge analysis (files)', 'Knowledge files', 'ai_multiplier_default')
on conflict (runner_id) do nothing;

-- The chat AI's two new tools. file_search is shown only to businesses that have at least one active source.
insert into public.chat_ai_tools (name, description, parameters, kind, target, phase) values
('file_search',
 'Search the files this business uploaded (procedures, price lists, policies, brochures). Your instructions list each file and when to use it. When the situation matches one, search it before you answer, and answer from what it says. Never guess what a file says.',
 '{"type":"object","properties":{"query":{"type":"string","description":"What you need to find, in plain words."},"source_id":{"type":"string","description":"Optional. Limit the search to one file by its id from the list."}},"required":["query"],"additionalProperties":false}',
 'builtin', 'file_search', 'lookup'),
('send_knowledge_image',
 'Send the customer an image from the business files (for example a price list, a size chart or a brochure page). Only for files marked as images. Use file_search first so you know which one fits.',
 '{"type":"object","properties":{"source_id":{"type":"string","description":"The id of an image file from the list."},"caption":{"type":"string","description":"Optional short caption."}},"required":["source_id"],"additionalProperties":false}',
 'builtin', 'send_knowledge_image', 'send')
on conflict (name, coalesce(business_id, '')) do nothing;

-- The original files. Private: the dashboard reads them with a signed link, the AI sends images with a short-lived one.
insert into storage.buckets (id, name, public, file_size_limit)
values ('business-knowledge', 'business-knowledge', false, 52428800)
on conflict (id) do nothing;

drop policy if exists business_knowledge_owner_insert on storage.objects;
create policy business_knowledge_owner_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'business-knowledge' and exists (
    select 1 from public.businesses b where b.user_id = auth.uid() and b.business_id = (storage.foldername(name))[1]));
drop policy if exists business_knowledge_owner_read on storage.objects;
create policy business_knowledge_owner_read on storage.objects for select to authenticated
  using (bucket_id = 'business-knowledge' and exists (
    select 1 from public.businesses b where b.user_id = auth.uid() and b.business_id = (storage.foldername(name))[1]));
drop policy if exists business_knowledge_owner_delete on storage.objects;
create policy business_knowledge_owner_delete on storage.objects for delete to authenticated
  using (bucket_id = 'business-knowledge' and exists (
    select 1 from public.businesses b where b.user_id = auth.uid() and b.business_id = (storage.foldername(name))[1]));

-- ── Handoffs ────────────────────────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.handoff_events (
  id uuid primary key default gen_random_uuid(),
  business_id text not null,
  conversation_id text,
  contact_id bigint,
  contact_name text,
  contact_phone text,
  reason text,
  urgency text not null default 'normal' check (urgency in ('low', 'normal', 'high')),
  summary text,
  rule_id text,
  rule_label text,
  source text not null default 'ai',                  -- 'ai' (the AI chose it) or 'rule' (a safety check gave the chat away)
  recipients jsonb not null default '[]'::jsonb,       -- [{ "name": "...", "phone": "2547..." }], decided when the handoff happened
  notify_status text not null default 'pending' check (notify_status in ('pending', 'sent', 'partial', 'failed', 'skipped')),
  notify_attempts integer not null default 0,
  notify_error text,
  notified_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_handoff_events_pending on public.handoff_events (created_at) where notify_status = 'pending';
create index if not exists idx_handoff_events_business on public.handoff_events (business_id, created_at desc);

alter table public.handoff_events enable row level security;
drop policy if exists handoff_events_owner_read on public.handoff_events;
create policy handoff_events_owner_read on public.handoff_events for select
  using (business_id in (select b.business_id from public.businesses b where b.user_id = auth.uid()));

-- The handoff tool can now name the owner's case (rule_id), so the right person is told. Optional: without it the
-- default people (the owner) are told, exactly as before. Only the shared tool row is changed.
update public.chat_ai_tools
set parameters = jsonb_set(parameters, '{properties,rule_id}',
  '{"type":"string","description":"Optional. The rule_id of the matching case in HANDOFF CASES, when one applies."}'::jsonb)
where name = 'handoff' and business_id is null and not (parameters->'properties' ? 'rule_id');
