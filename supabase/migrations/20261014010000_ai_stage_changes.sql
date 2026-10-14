-- Slice 5: the AIs can move a lead's stage, safely.
-- The chat AI asks (tool "move_lead_stage"); the follow-up engine checks the rules, applies the change through the same
-- billed path the stage classifier uses, and writes an audit row. Nothing here changes a stage by itself.

-- 1. Requests (the queue the engine reads) ------------------------------------------------------------------------
create table if not exists public.lead_stage_requests (
  id               bigserial primary key,
  business_id      text   not null,
  contact_id       bigint not null,
  conversation_id  text   not null,
  requested_stage  text   not null,
  reason           text   not null,
  actor            text   not null default 'chat_ai' check (actor in ('chat_ai', 'followup_ai', 'assistant')),
  status           text   not null default 'pending' check (status in ('pending', 'applied', 'unchanged', 'rejected')),
  reject_reason    text,
  from_stage       text,
  created_at       timestamptz not null default now(),
  processed_at     timestamptz
);
create index if not exists idx_lead_stage_requests_pending on public.lead_stage_requests (created_at) where status = 'pending';
alter table public.lead_stage_requests enable row level security;   -- service role only

-- 2. Audit: every stage an AI moved, with who and why ---------------------------------------------------------------
create table if not exists public.lead_stage_changes (
  id               bigserial primary key,
  business_id      text   not null,
  contact_id       bigint not null,
  conversation_id  text   not null,
  from_stage       text,
  to_stage         text   not null,
  actor            text   not null,
  reason           text   not null,
  request_id       bigint references public.lead_stage_requests (id) on delete set null,
  created_at       timestamptz not null default now()
);
create index if not exists idx_lead_stage_changes_contact on public.lead_stage_changes (business_id, contact_id, created_at desc);
alter table public.lead_stage_changes enable row level security;   -- service role only

-- 3. The chat AI's tool ---------------------------------------------------------------------------------------------
create or replace function public.chat_tool_move_lead_stage(p_business_id text, p_contact_id bigint, p_conversation_id text, p_args jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_stage  text := lower(btrim(coalesce(p_args ->> 'stage', '')));
  v_reason text := left(btrim(coalesce(p_args ->> 'reason', '')), 300);
begin
  if v_stage = '' or v_stage !~ '^[a-z_]{3,30}$' then
    return jsonb_build_object('ok', false, 'error', 'stage is required, for example "intent" or "negotiation".');
  end if;
  if length(v_reason) < 3 then
    return jsonb_build_object('ok', false, 'error', 'Say why in a few words (reason). The owner can see it.');
  end if;
  if p_conversation_id is null or p_contact_id is null then
    return jsonb_build_object('ok', false, 'error', 'There is no conversation to move.');
  end if;

  -- One open request per conversation: the newest one wins.
  delete from public.lead_stage_requests
   where business_id = p_business_id and conversation_id = p_conversation_id and status = 'pending';
  insert into public.lead_stage_requests (business_id, contact_id, conversation_id, requested_stage, reason, actor)
  values (p_business_id, p_contact_id, p_conversation_id, v_stage, v_reason, 'chat_ai');

  return jsonb_build_object('ok', true, 'note', 'Stage change requested. It is checked and applied within a minute. Do not tell the customer about it.');
end
$fn$;

revoke all on function public.chat_tool_move_lead_stage(text, bigint, text, jsonb) from public, authenticated;
grant execute on function public.chat_tool_move_lead_stage(text, bigint, text, jsonb) to service_role;

insert into public.chat_ai_tools (name, description, parameters, kind, target, phase) values
('move_lead_stage',
 'Move this customer to the stage their conversation has really reached, with a short reason the owner can read. Online shops: discovery, browsing, selection, intent, checkout, awaiting_payment. Services: discovery, qualified, proposal, negotiation, committed. Use it only when the customer''s own words show it (for example they chose a product, asked how to pay, or agreed to the price). Never use it for paid, fulfilled, completed or later: those come from real payments or the owner. Do not mention this to the customer.',
 '{"type":"object","properties":{"stage":{"type":"string","description":"The stage the customer has reached, e.g. intent or negotiation."},"reason":{"type":"string","description":"Why, in a few plain words, e.g. \"asked how to pay for the red dress\"."}},"required":["stage","reason"],"additionalProperties":false}',
 'rpc', 'chat_tool_move_lead_stage', 'write')
on conflict do nothing;

-- 4. Let the engine hear about new requests straight away ----------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'lead_stage_requests') then
    alter publication supabase_realtime add table public.lead_stage_requests;
  end if;
end $$;

-- 5. Setup runner: where the time goes, and the one-time starter credit --------------------------------------------
alter table public.business_setup add column if not exists timings jsonb not null default '{}'::jsonb;
alter table public.business_setup add column if not exists starter_credit_at timestamptz;
