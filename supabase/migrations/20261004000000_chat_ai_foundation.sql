-- Chat AI foundation (phase 1).
-- Everything here is inert: the master switch starts OFF and the daily cap starts at 0,
-- so applying this migration changes nothing for any business until the owner opts in.

-- ── 1. Business settings ────────────────────────────────────────────────────
alter table public.businesses
  add column if not exists chat_ai_enabled boolean not null default false,
  add column if not exists chat_ai_daily_cap integer not null default 0 check (chat_ai_daily_cap >= 0),
  add column if not exists chat_ai_model text not null default 'gpt-5-mini',
  add column if not exists chat_ai_human_pause_minutes integer not null default 60 check (chat_ai_human_pause_minutes >= 0),
  add column if not exists chat_ai_settings jsonb not null default '{}'::jsonb;

-- ── 2. Conversation fields: handoff (for the dashboard home view) + reply lock ─
-- handover_flag / handover_reason already exist. These make a handoff a proper record.
alter table public.conversations
  add column if not exists handover_at timestamptz,
  add column if not exists handover_urgency text check (handover_urgency in ('low', 'normal', 'high')),
  add column if not exists handover_source text check (handover_source in ('ai', 'rule', 'owner')),
  add column if not exists handover_resolved_at timestamptz,
  add column if not exists chat_ai_locked_until timestamptz,
  add column if not exists chat_ai_lock_token text;

create index if not exists idx_conversations_open_handovers
  on public.conversations (business_id, handover_at desc)
  where handover_flag = true and handover_resolved_at is null;

-- ── 3. Daily chat cap ───────────────────────────────────────────────────────
-- One row per (business, day, conversation) the first time the AI replies in that chat that day.
create table if not exists public.chat_ai_daily_chats (
  business_id text not null,
  day date not null,
  conversation_id text not null,
  claimed_at timestamptz not null default now(),
  primary key (business_id, day, conversation_id)
);
alter table public.chat_ai_daily_chats enable row level security;

-- Atomically decides whether the AI may reply in this chat today.
-- A chat that already has a slot today is always allowed (it is a chat in progress).
-- A new chat gets a slot only while fewer than p_cap chats have been served today.
-- "Today" is the business's own day, so the cap resets at its midnight, not UTC's.
create or replace function public.chat_ai_claim_slot(p_business_id text, p_conversation_id text, p_cap integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tz text;
  v_day date;
  v_used integer;
begin
  select coalesce(nullif(timezone, ''), 'Africa/Nairobi') into v_tz from businesses where business_id = p_business_id;
  begin
    v_day := (now() at time zone coalesce(v_tz, 'Africa/Nairobi'))::date;
  exception when others then
    v_day := (now() at time zone 'Africa/Nairobi')::date;
  end;

  -- Serialise claims per business so two new chats cannot both take the last slot.
  perform pg_advisory_xact_lock(hashtext('chat_ai_slot:' || p_business_id));

  if exists (select 1 from chat_ai_daily_chats where business_id = p_business_id and day = v_day and conversation_id = p_conversation_id) then
    select count(*) into v_used from chat_ai_daily_chats where business_id = p_business_id and day = v_day;
    return jsonb_build_object('allowed', true, 'new_chat', false, 'used', v_used, 'cap', p_cap);
  end if;

  select count(*) into v_used from chat_ai_daily_chats where business_id = p_business_id and day = v_day;
  if p_cap is null or v_used >= p_cap then
    return jsonb_build_object('allowed', false, 'new_chat', true, 'used', v_used, 'cap', coalesce(p_cap, 0));
  end if;

  insert into chat_ai_daily_chats (business_id, day, conversation_id) values (p_business_id, v_day, p_conversation_id);
  return jsonb_build_object('allowed', true, 'new_chat', true, 'used', v_used + 1, 'cap', p_cap);
end;
$$;

-- ── 4. Per-conversation reply lock (one AI turn at a time per chat) ─────────
-- Returns a token if the lock was taken, null if another turn is running.
-- The lock expires on its own so a crashed turn can never freeze a chat.
create or replace function public.chat_ai_acquire_lock(p_conversation_id text, p_seconds integer default 120)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token text := gen_random_uuid()::text;
  v_rows integer;
begin
  update conversations
     set chat_ai_locked_until = now() + make_interval(secs => p_seconds),
         chat_ai_lock_token = v_token
   where id = p_conversation_id
     and (chat_ai_locked_until is null or chat_ai_locked_until < now());
  get diagnostics v_rows = row_count;
  if v_rows = 0 then return null; end if;
  return v_token;
end;
$$;

create or replace function public.chat_ai_release_lock(p_conversation_id text, p_token text)
returns void
language sql
security definer
set search_path = public
as $$
  update conversations
     set chat_ai_locked_until = null, chat_ai_lock_token = null
   where id = p_conversation_id and chat_ai_lock_token = p_token;
$$;

revoke all on function public.chat_ai_claim_slot(text, text, integer) from public, anon, authenticated;
revoke all on function public.chat_ai_acquire_lock(text, integer) from public, anon, authenticated;
revoke all on function public.chat_ai_release_lock(text, text) from public, anon, authenticated;

-- ── 5. Turn log: what the AI saw, did and said (feeds the QC reviewer) ──────
create table if not exists public.chat_ai_turns (
  id uuid primary key default gen_random_uuid(),
  business_id text not null,
  conversation_id text,
  contact_id bigint,
  trigger_message_id text,          -- whatsapp_message_id of the customer message that started this turn
  mode text not null default 'live' check (mode in ('live', 'simulation')),
  status text not null check (status in ('skipped', 'running', 'replied', 'handoff', 'error')),
  skip_reason text,
  model text,
  flow_id uuid,
  skills_loaded text[] not null default '{}',
  input jsonb,                      -- customer message + the context the AI was given
  steps jsonb not null default '[]'::jsonb,   -- ordered tool calls and their results
  thoughts text,                    -- reasoning summary the model returned
  reply text,
  holding_message text,
  tokens_in integer,
  tokens_cached integer,
  tokens_out integer,
  cost_usd numeric(12, 6),
  duration_ms integer,
  error text,
  qc_status text check (qc_status in ('pending', 'ok', 'flagged')),
  qc_score integer,
  qc_flags jsonb,
  qc_notes text,
  qc_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_chat_ai_turns_business_time on public.chat_ai_turns (business_id, created_at desc);
create index if not exists idx_chat_ai_turns_conversation on public.chat_ai_turns (conversation_id, created_at desc);
create index if not exists idx_chat_ai_turns_qc_pending on public.chat_ai_turns (created_at) where qc_status = 'pending';
create index if not exists idx_chat_ai_turns_flagged on public.chat_ai_turns (business_id, created_at desc) where qc_status = 'flagged';

alter table public.chat_ai_turns enable row level security;
-- Owners may read their own business's turns (for the review list). Only the backend writes.
drop policy if exists chat_ai_turns_owner_select on public.chat_ai_turns;
create policy chat_ai_turns_owner_select on public.chat_ai_turns for select to authenticated
  using (business_id in (select b.business_id from public.businesses b where b.user_id = auth.uid()));
