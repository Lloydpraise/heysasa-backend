-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- FOLLOW-UP AI
--
-- The second AI system on a business, next to the chat AI. It writes follow-ups, builds the follow-up campaign for every
-- ad, picks send times and, just before a message goes out, checks it is still the right message. Billed at the chat AI
-- multiplier (ai_multiplier_chat).
--
-- What this migration adds
--   1. Settings on businesses (AI scheduling mode, minimum gap, silence gate, approval default)
--   2. A few columns on campaigns / campaign_steps / campaign_enrollments / follow_up_queue / chat_flows
--   3. Skills (platform defaults + per business overrides), ad playbooks and their items, per-lead state, decision log
--   4. Row-level security, realtime, a health view
--   5. followup_ai_activate_playbook(): turns an approved playbook into a chat flow + a campaign (only unsent steps change)
--   6. Three tools the chat AI can call: hold_followups, schedule_followup, get_followup_plan
--   7. Billing runners for the four Follow-up AI jobs
--
-- Safe to run twice.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

-- ── 1. Business settings ───────────────────────────────────────────────────────────────────────────────────────────
alter table public.businesses
  add column if not exists followup_ai_scheduling text not null default 'off',
  add column if not exists followup_min_gap_hours integer not null default 20,
  add column if not exists followup_silence_hours integer not null default 12,
  add column if not exists followup_approval_default text not null default 'granular';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'businesses_followup_ai_scheduling_check') then
    alter table public.businesses add constraint businesses_followup_ai_scheduling_check
      check (followup_ai_scheduling in ('off', 'draft', 'auto'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'businesses_followup_min_gap_hours_check') then
    alter table public.businesses add constraint businesses_followup_min_gap_hours_check
      check (followup_min_gap_hours between 1 and 168);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'businesses_followup_silence_hours_check') then
    alter table public.businesses add constraint businesses_followup_silence_hours_check
      check (followup_silence_hours between 2 and 168);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'businesses_followup_approval_default_check') then
    alter table public.businesses add constraint businesses_followup_approval_default_check
      check (followup_approval_default in ('granular', 'all'));
  end if;
end $$;

comment on column public.businesses.followup_ai_scheduling is
  'May the Follow-up AI schedule a follow-up on its own? off = never, draft = it schedules, the owner approves the message, auto = it schedules and sends.';
comment on column public.businesses.followup_min_gap_hours is
  'Minimum hours between two Follow-up AI messages to the same lead (all AI-managed campaigns and AI-scheduled follow-ups).';
comment on column public.businesses.followup_silence_hours is
  'Hours of silence from the lead (after any message from them) before the next AI-managed step may go out.';

-- ── 2. Columns on existing tables ──────────────────────────────────────────────────────────────────────────────────
alter table public.campaigns
  add column if not exists ai_managed boolean not null default false,
  add column if not exists ad_id text,
  add column if not exists flow_id uuid,
  add column if not exists playbook_id uuid,
  add column if not exists min_gap_hours integer;

alter table public.campaign_steps
  add column if not exists touchpoint_type text,
  add column if not exists klt_phase text,
  add column if not exists playbook_item_id uuid;

alter table public.campaign_enrollments
  add column if not exists step_order integer[],
  add column if not exists schedule_reason text,
  add column if not exists last_reply_at timestamptz,
  add column if not exists last_director_at timestamptz;

alter table public.follow_up_queue
  add column if not exists ai_intent text;

alter table public.chat_flows
  add column if not exists source text,
  add column if not exists playbook_id uuid;

create index if not exists idx_campaigns_ad_managed on public.campaigns (business_id, ad_id) where ai_managed;

-- ── 3a. Skills ─────────────────────────────────────────────────────────────────────────────────────────────────────
-- Platform defaults are written by the engine on start (src/followupAi/defaultSkills.js); a business row with the same key
-- overrides the default, and enabled = false switches a default off for that business.
create table if not exists public.followup_ai_default_skills (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{1,48}$'),
  title text not null,
  summary text not null,
  instructions text not null,
  used_by text[] not null default '{author,director,writer}',
  sort_order integer not null default 100,
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists public.followup_ai_skills (
  business_id text not null,
  key text not null check (key ~ '^[a-z][a-z0-9_]{1,48}$'),
  title text not null,
  summary text not null default '',
  instructions text not null default '',
  used_by text[] not null default '{author,director,writer}',
  enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (business_id, key)
);

-- ── 3b. Ad playbooks ───────────────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.ad_playbooks (
  id uuid primary key default gen_random_uuid(),
  business_id text not null,
  ad_id text not null,
  status text not null default 'pending'
    check (status in ('pending', 'generating', 'review', 'active', 'failed', 'needs_data', 'paused')),
  -- what the ad looked like when we read it (the owner's edits never overwrite these)
  auto_headline text,
  auto_body text,
  auto_thumbnail_url text,
  -- the owner's corrections; when set they win over the auto values
  override_headline text,
  override_body text,
  images jsonb not null default '[]'::jsonb,       -- [{url, source: 'meta'|'upload'|'contact', label}]
  chosen_image_url text,
  data_quality text not null default 'unknown' check (data_quality in ('unknown', 'good', 'weak', 'missing')),
  data_issues text[] not null default '{}',
  version integer not null default 1,
  flow_id uuid,
  campaign_id uuid,
  regenerate_requested_at timestamptz,
  last_generated_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, ad_id)
);
create index if not exists idx_ad_playbooks_business on public.ad_playbooks (business_id, status);

create table if not exists public.ad_playbook_items (
  id uuid primary key default gen_random_uuid(),
  playbook_id uuid not null references public.ad_playbooks (id) on delete cascade,
  business_id text not null,
  kind text not null check (kind in ('flow', 'step')),
  position integer not null default 0,              -- steps: 1..n in sending order. flow: 0
  klt_phase text check (klt_phase in ('know', 'like', 'trust')),
  touchpoint_type text,                              -- e.g. soft_checkin, social_proof, value_tip, offer, founder_story
  title text,
  content text not null default '',                  -- flow: the instructions. step: the message
  goal text,                                         -- flow: the goal
  skill_keys text[] not null default '{}',
  delay_hours integer not null default 24,           -- steps: wait after the previous step (the scheduler never goes below the minimum gap)
  media jsonb,                                       -- same shape as campaign_steps.media
  media_source text,                                 -- 'ad_image' | 'testimonial' | 'material' | 'owner' | null
  status text not null default 'draft'
    check (status in ('draft', 'approved', 'rejected', 'needs_media', 'applied', 'superseded')),
  qc_passed boolean,
  qc_notes text,
  rationale text,
  edited_by_owner boolean not null default false,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_ad_playbook_items_playbook on public.ad_playbook_items (playbook_id, kind, position)
  where status <> 'superseded';

-- ── 3c. Per-lead state + decision log ──────────────────────────────────────────────────────────────────────────────
create table if not exists public.lead_ai_state (
  business_id text not null,
  contact_id bigint not null,
  hold_until timestamptz,
  hold_reason text,
  last_feedback text,                                -- 'negative' | 'positive' | 'opt_out' | null
  negative_count integer not null default 0,
  last_turn_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (business_id, contact_id)
);

create table if not exists public.followup_ai_turns (
  id uuid primary key default gen_random_uuid(),
  business_id text not null,
  contact_id bigint,
  campaign_id uuid,
  queue_id uuid,
  kind text not null check (kind in ('author', 'director', 'writer', 'feedback', 'schedule', 'intake', 'qc')),
  decision text,                                     -- send | rewrite | reorder | reschedule | skip | stop | authored | failed | negative | opt_out ...
  reason text,
  step_number integer,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_followup_ai_turns_business on public.followup_ai_turns (business_id, created_at desc);
create index if not exists idx_followup_ai_turns_contact on public.followup_ai_turns (contact_id, created_at desc);

-- ── 4. Row-level security ──────────────────────────────────────────────────────────────────────────────────────────
alter table public.followup_ai_default_skills enable row level security;
alter table public.followup_ai_skills enable row level security;
alter table public.ad_playbooks enable row level security;
alter table public.ad_playbook_items enable row level security;
alter table public.lead_ai_state enable row level security;
alter table public.followup_ai_turns enable row level security;

do $$
declare t text;
begin
  -- the owner can read everything about their own business and edit skills, playbooks and items
  foreach t in array array['followup_ai_skills', 'ad_playbooks', 'ad_playbook_items'] loop
    execute format('drop policy if exists %I on public.%I', t || '_owner_all', t);
    execute format($p$create policy %I on public.%I for all to authenticated
      using (business_id in (select public.my_business_ids()))
      with check (business_id in (select public.my_business_ids()))$p$, t || '_owner_all', t);
  end loop;

  -- read only for the owner: the engine writes these
  foreach t in array array['lead_ai_state', 'followup_ai_turns'] loop
    execute format('drop policy if exists %I on public.%I', t || '_owner_read', t);
    execute format($p$create policy %I on public.%I for select to authenticated
      using (business_id in (select public.my_business_ids()))$p$, t || '_owner_read', t);
  end loop;

  drop policy if exists followup_ai_default_skills_read on public.followup_ai_default_skills;
  create policy followup_ai_default_skills_read on public.followup_ai_default_skills for select to authenticated using (true);
end $$;

-- ── 4b. Realtime: the engine reacts to new ads and to owner edits at once ─────────────────────────────────────────────
do $$
declare table_name text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;
  foreach table_name in array array['ad_attributions', 'ad_playbooks', 'ad_playbook_items'] loop
    if to_regclass('public.' || table_name) is not null
       and not exists (
         select 1 from pg_publication_tables
         where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = table_name
       ) then
      execute format('alter publication supabase_realtime add table public.%I', table_name);
    end if;
  end loop;
end $$;

-- ── 4c. An owner edit of the ad (headline, text, chosen image) asks for the follow-ups to be rewritten ───────────────
create or replace function public.ad_playbooks_touch()
returns trigger
language plpgsql
set search_path to 'public'
as $fn$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE'
     and (new.override_headline is distinct from old.override_headline
       or new.override_body is distinct from old.override_body
       or new.chosen_image_url is distinct from old.chosen_image_url)
     and new.regenerate_requested_at is not distinct from old.regenerate_requested_at then
    new.regenerate_requested_at := now();
  end if;
  return new;
end
$fn$;

drop trigger if exists trg_ad_playbooks_touch on public.ad_playbooks;
create trigger trg_ad_playbooks_touch
  before update on public.ad_playbooks
  for each row execute function public.ad_playbooks_touch();

-- ── 4d. Health view (is the system working?) ───────────────────────────────────────────────────────────────────────
create or replace view public.v_followup_ai_health with (security_invoker = true) as
select business_id,
       kind,
       coalesce(decision, '-') as decision,
       count(*) as turns,
       max(created_at) as last_at
  from public.followup_ai_turns
 where created_at > now() - interval '30 days'
 group by business_id, kind, decision;

-- ── 5. Activate a playbook ─────────────────────────────────────────────────────────────────────────────────────────
-- The owner approved items one by one (or all at once). This turns what is approved into the live thing:
--   * the chat flow for the ad (chat_flows, triggered on the ad id)
--   * the follow-up campaign on the ad's list, steps numbered 1..n with content, media, gaps and KLT phase
-- Steps that have already been sent to someone are history and are never touched. Only unsent steps are replaced, and
-- leads already part-way through carry on with the new steps after the ones they have received.
create or replace function public.followup_ai_activate_playbook(p_playbook_id uuid, p_instance text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  pb public.ad_playbooks%rowtype;
  v_flow_item public.ad_playbook_items%rowtype;
  v_list uuid;
  v_flow uuid;
  v_campaign uuid;
  v_instance text;
  v_name text;
  v_headline text;
  v_sent_max integer := 0;
  v_count integer := 0;
  v_skipped_media integer := 0;
  v_other_campaigns integer := 0;
  v_item record;
begin
  select * into pb from public.ad_playbooks where id = p_playbook_id for update;
  if not found then raise exception 'playbook not found'; end if;

  if auth.role() is not null and auth.role() <> 'service_role' then
    if pb.business_id not in (select public.my_business_ids()) then raise exception 'not allowed'; end if;
  end if;

  v_headline := coalesce(nullif(trim(pb.override_headline), ''), nullif(trim(pb.auto_headline), ''), 'Ad ' || right(pb.ad_id, 6));
  v_name := left(v_headline, 70) || ' – follow-up';

  select count(*) into v_count from public.ad_playbook_items
   where playbook_id = pb.id and kind = 'step' and status in ('approved', 'applied');
  select * into v_flow_item from public.ad_playbook_items
   where playbook_id = pb.id and kind = 'flow' and status in ('approved', 'applied') order by version desc limit 1;
  if v_count = 0 and v_flow_item.id is null then
    raise exception 'nothing approved yet';
  end if;

  select count(*) into v_skipped_media from public.ad_playbook_items
   where playbook_id = pb.id and kind = 'step' and status = 'needs_media';

  -- ── the ad's list ──
  select id into v_list from public.lists where business_id = pb.business_id and ad_id = pb.ad_id and type = 'ad' limit 1;
  if v_list is null then
    perform public.sync_ad_lists(pb.business_id);
    select id into v_list from public.lists where business_id = pb.business_id and ad_id = pb.ad_id and type = 'ad' limit 1;
  end if;
  if v_list is null then raise exception 'this ad has no list yet (no lead has come from it)'; end if;

  -- ── chat flow ──
  if v_flow_item.id is not null then
    v_flow := pb.flow_id;
    if v_flow is not null and not exists (select 1 from public.chat_flows where id = v_flow and business_id = pb.business_id) then
      v_flow := null;
    end if;
    if v_flow is null then
      insert into public.chat_flows (business_id, name, enabled, priority, trigger, goal, instructions, skill_keys, source, playbook_id)
      values (pb.business_id, left('Ad: ' || v_headline, 80), true, 150, jsonb_build_object('ad_ids', jsonb_build_array(pb.ad_id)),
              v_flow_item.goal, v_flow_item.content, coalesce(v_flow_item.skill_keys, '{}'), 'followup_ai', pb.id)
      returning id into v_flow;
    else
      update public.chat_flows
         set goal = v_flow_item.goal, instructions = v_flow_item.content, skill_keys = coalesce(v_flow_item.skill_keys, '{}'),
             name = left('Ad: ' || v_headline, 80), enabled = true, updated_at = now()
       where id = v_flow;
    end if;
    update public.ad_playbook_items set status = 'superseded', updated_at = now()
     where playbook_id = pb.id and kind = 'flow' and status = 'applied' and id <> v_flow_item.id;
    update public.ad_playbook_items set status = 'applied', updated_at = now() where id = v_flow_item.id;
  end if;

  -- ── campaign ──
  v_campaign := pb.campaign_id;
  if v_campaign is not null and not exists (select 1 from public.campaigns where id = v_campaign and business_id = pb.business_id) then
    v_campaign := null;
  end if;

  if v_count > 0 then
    if v_campaign is null then
      v_instance := coalesce(nullif(trim(p_instance), ''),
        (select s.instance_name from public.whatsapp_sessions s where s.business_id = pb.business_id and s.status = 'connected' order by s.instance_name limit 1));

      insert into public.campaigns (business_id, list_id, name, whatsapp_instance_name, sequence_mode, smart_timing, status,
                                    gateway_type, daily_cap, ai_rewrite_enabled, auto_approve, ai_managed, ad_id, flow_id, playbook_id)
      values (pb.business_id, v_list, v_name, v_instance, 'linear', true, 'active',
              'Baileys', 40, false, false, true, pb.ad_id, v_flow, pb.id)
      returning id into v_campaign;
    else
      update public.campaigns
         set name = v_name, ai_managed = true, ad_id = pb.ad_id, flow_id = coalesce(v_flow, flow_id), playbook_id = pb.id,
             status = case when status in ('paused', 'completed') and failure_reason is null then 'active' else status end
       where id = v_campaign;
    end if;

    -- unsent steps go; sent ones stay as history
    select coalesce(max(cs.step_number), 0) into v_sent_max
      from public.campaign_steps cs
     where cs.campaign_id = v_campaign
       and exists (select 1 from public.campaign_step_events e where e.step_id = cs.id and e.sent_at is not null);

    delete from public.campaign_steps where campaign_id = v_campaign and step_number > v_sent_max;

    -- newly approved steps replace the ones that were live before
    if exists (select 1 from public.ad_playbook_items where playbook_id = pb.id and kind = 'step' and status = 'approved') then
      update public.ad_playbook_items set status = 'superseded', updated_at = now()
       where playbook_id = pb.id and kind = 'step' and status = 'applied';
    end if;
    select count(*) into v_count from public.ad_playbook_items
     where playbook_id = pb.id and kind = 'step' and status in ('approved', 'applied');

    insert into public.campaign_steps (campaign_id, step_number, content, media, delay_hours, condition, touchpoint_type, klt_phase, playbook_item_id)
    select v_campaign, v_sent_max + row_number() over (order by i.position, i.created_at), i.content, i.media,
           greatest(coalesce(i.delay_hours, 24), 0), null, i.touchpoint_type, i.klt_phase, i.id
      from public.ad_playbook_items i
     where i.playbook_id = pb.id and i.kind = 'step' and i.status in ('approved', 'applied')
     order by i.position, i.created_at;

    update public.ad_playbook_items set status = 'applied', updated_at = now()
     where playbook_id = pb.id and kind = 'step' and status = 'approved';

    -- leads part-way through keep what they have received and continue with the new steps
    if v_sent_max > 0 then
      update public.campaign_enrollments e
         set step_order = (
               case when e.step_order is not null
                    then e.step_order[1:greatest(e.current_step, 0)]
                    else array(select g from generate_series(1, greatest(e.current_step, 0)) g) end
             ) || array(select g from generate_series(v_sent_max + 1, v_sent_max + v_count) g)
       where e.campaign_id = v_campaign and e.status in ('pending', 'active');
    end if;

    select count(*) into v_other_campaigns
      from public.campaigns c
     where c.list_id = v_list and c.id <> v_campaign and c.status = 'active';
  end if;

  update public.ad_playbooks
     set status = 'active', flow_id = v_flow, campaign_id = v_campaign, updated_at = now()
   where id = pb.id;

  return jsonb_build_object(
    'ok', true, 'flow_id', v_flow, 'campaign_id', v_campaign, 'steps', v_count,
    'steps_waiting_for_media', v_skipped_media, 'other_active_campaigns_on_list', v_other_campaigns,
    'instance', v_instance
  );
end
$fn$;

revoke all on function public.followup_ai_activate_playbook(uuid, text) from public;
grant execute on function public.followup_ai_activate_playbook(uuid, text) to authenticated, service_role;

-- ── 6. Chat AI tools ───────────────────────────────────────────────────────────────────────────────────────────────
-- The chat AI sees the same lead the Follow-up AI works on. These three tools let it keep the two in step.
-- Each is a Postgres function with the registry signature; only the edge function (service role) may run them.

-- Put this lead's follow-ups on hold (e.g. a sale is being closed in chat, the customer asked for time).
create or replace function public.chat_tool_hold_followups(p_business_id text, p_contact_id bigint, p_conversation_id text, p_args jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_hours integer := least(greatest(coalesce(nullif(p_args ->> 'hours', '')::integer, 72), 1), 336);
  v_reason text := left(coalesce(p_args ->> 'reason', ''), 300);
  v_until timestamptz := now() + make_interval(hours => v_hours);
begin
  insert into public.lead_ai_state (business_id, contact_id, hold_until, hold_reason, updated_at)
  values (p_business_id, p_contact_id, v_until, nullif(v_reason, ''), now())
  on conflict (business_id, contact_id)
  do update set hold_until = excluded.hold_until, hold_reason = excluded.hold_reason, updated_at = now();

  insert into public.followup_ai_turns (business_id, contact_id, kind, decision, reason, details)
  values (p_business_id, p_contact_id, 'schedule', 'hold', nullif(v_reason, ''), jsonb_build_object('hours', v_hours, 'by', 'chat_ai'));

  return jsonb_build_object('ok', true, 'held_until', v_until, 'note', 'Follow-ups to this customer are paused until then.');
end
$fn$;

-- Ask for one follow-up at a time of the chat AI's choosing. The Follow-up AI writes it when the time comes, from the
-- intent given here, unless a message is supplied.
create or replace function public.chat_tool_schedule_followup(p_business_id text, p_contact_id bigint, p_conversation_id text, p_args jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_mode text;
  v_dnc boolean;
  v_step integer;
  v_hours integer := least(greatest(coalesce(nullif(p_args ->> 'hours', '')::integer, 24), 1), 336);
  v_intent text := left(coalesce(p_args ->> 'intent', ''), 500);
  v_message text := nullif(left(coalesce(p_args ->> 'message', ''), 1000), '');
  v_at timestamptz := now() + make_interval(hours => v_hours);
  v_id uuid;
begin
  select followup_ai_scheduling into v_mode from public.businesses where business_id = p_business_id;
  if v_mode is null or v_mode = 'off' then
    return jsonb_build_object('ok', false, 'error', 'The owner has not allowed the AI to schedule follow-ups. Do not promise one.');
  end if;
  if length(trim(v_intent)) < 3 then
    return jsonb_build_object('ok', false, 'error', 'Say what the follow-up is for (intent).');
  end if;

  select do_not_contact, coalesce(current_sequence_step, 0) + 1 into v_dnc, v_step
    from public.contacts where id = p_contact_id and business_id = p_business_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'Customer not found.'); end if;
  if v_dnc then return jsonb_build_object('ok', false, 'error', 'This customer asked not to be contacted.'); end if;

  -- one open AI-scheduled follow-up per customer: a newer request replaces the older one
  update public.follow_up_queue
     set status = 'cancelled', skip_reason = 'replaced_by_newer_ai_schedule'
   where business_id = p_business_id and contact_id = p_contact_id and authored_by = 'ai_scheduled'
     and status = 'pending' and campaign_id is null;

  insert into public.follow_up_queue (
    business_id, contact_id, conversation_id, sequence_step, touchpoint_type, klt_phase,
    final_message, ai_intent, authored_by, ai_rewrite_enabled, approval_status, status, scheduled_at
  ) values (
    p_business_id, p_contact_id, p_conversation_id, v_step, 'ai_scheduled', 'like',
    v_message, v_intent, 'ai_scheduled', false, 'approved', 'pending', v_at
  ) returning id into v_id;

  insert into public.followup_ai_turns (business_id, contact_id, queue_id, kind, decision, reason, details)
  values (p_business_id, p_contact_id, v_id, 'schedule', 'scheduled', v_intent, jsonb_build_object('hours', v_hours, 'by', 'chat_ai', 'mode', v_mode));

  return jsonb_build_object('ok', true, 'follow_up_id', v_id, 'around', v_at,
    'note', case when v_mode = 'draft' then 'The owner will approve the message before it is sent.' else 'It will go out around that time if the customer has not written by then.' end);
end
$fn$;

-- What follow-ups are lined up for this customer right now.
create or replace function public.chat_tool_get_followup_plan(p_business_id text, p_contact_id bigint, p_conversation_id text, p_args jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
declare
  v_hold timestamptz;
  v_campaign jsonb;
  v_next jsonb;
  v_sent jsonb;
begin
  select hold_until into v_hold from public.lead_ai_state where business_id = p_business_id and contact_id = p_contact_id;

  select jsonb_build_object('name', c.name, 'step_done', e.current_step, 'next_at', e.next_send_at, 'status', e.status)
    into v_campaign
    from public.campaign_enrollments e join public.campaigns c on c.id = e.campaign_id
   where e.lead_id = p_contact_id and e.status in ('pending', 'active') and c.business_id = p_business_id
   order by e.current_step desc limit 1;

  select coalesce(jsonb_agg(jsonb_build_object('at', q.scheduled_at, 'intent', q.ai_intent, 'status', q.status, 'approval', q.approval_status) order by q.scheduled_at), '[]'::jsonb)
    into v_next
    from public.follow_up_queue q
   where q.business_id = p_business_id and q.contact_id = p_contact_id and q.status in ('pending', 'ready_to_send') and q.scheduled_at is not null;

  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_sent from (
    select jsonb_build_object('at', m.created_at, 'text', left(coalesce(m.content ->> 'text', ''), 200)) as x
      from public.messages m
     where m.contact_id = p_contact_id and m.agent_role = 'follow_up_ai' and m.direction = 'out'
     order by m.created_at desc limit 3
  ) s;

  return jsonb_build_object('held_until', v_hold, 'campaign', v_campaign, 'queued', v_next, 'last_sent', v_sent);
end
$fn$;

revoke all on function public.chat_tool_hold_followups(text, bigint, text, jsonb) from public, authenticated;
revoke all on function public.chat_tool_schedule_followup(text, bigint, text, jsonb) from public, authenticated;
revoke all on function public.chat_tool_get_followup_plan(text, bigint, text, jsonb) from public, authenticated;
grant execute on function public.chat_tool_hold_followups(text, bigint, text, jsonb) to service_role;
grant execute on function public.chat_tool_schedule_followup(text, bigint, text, jsonb) to service_role;
grant execute on function public.chat_tool_get_followup_plan(text, bigint, text, jsonb) to service_role;

insert into public.chat_ai_tools (name, description, parameters, kind, target, phase) values
('hold_followups',
 'Pause the automatic follow-ups to this customer for a while. Use it when you are in the middle of helping them, they asked for time ("I will get back to you next week"), or a sale is being closed in this chat, so no follow-up cuts across you.',
 '{"type":"object","properties":{"hours":{"type":"integer","minimum":1,"maximum":336,"description":"How long to hold, in hours."},"reason":{"type":"string","description":"Why, in a few words."}},"required":["hours"],"additionalProperties":false}',
 'rpc', 'chat_tool_hold_followups', 'write'),
('schedule_followup',
 'Arrange one follow-up to this customer at a time you choose, for example when they said they will decide on Friday. Say what the follow-up is for; it will be written in the business voice when the time comes. Only works when the owner allows AI-scheduled follow-ups. Check get_followup_plan first so you do not stack follow-ups.',
 '{"type":"object","properties":{"hours":{"type":"integer","minimum":1,"maximum":336,"description":"Roughly how many hours from now."},"intent":{"type":"string","description":"What the follow-up should do, e.g. ask if they decided on the sandals and offer to hold their size."},"message":{"type":"string","description":"Optional exact message to send instead of letting the Follow-up AI write it."}},"required":["hours","intent"],"additionalProperties":false}',
 'rpc', 'chat_tool_schedule_followup', 'write'),
('get_followup_plan',
 'See which follow-ups are already lined up for this customer (campaign step, next time, anything on hold) and the last follow-ups they received. Call it before promising or arranging a follow-up.',
 '{"type":"object","properties":{},"additionalProperties":false}',
 'rpc', 'chat_tool_get_followup_plan', 'lookup')
on conflict do nothing;

-- ── 7. Billing: all four jobs bill at the chat AI multiplier ───────────────────────────────────────────────────────
insert into public.billing_runners (runner_id, label, user_label, multiplier_key) values
  ('followup_ai_author',   'Follow-up AI: ad playbook author',  'Follow-up AI', 'ai_multiplier_chat'),
  ('followup_ai_director', 'Follow-up AI: pre-send director',   'Follow-up AI', 'ai_multiplier_chat'),
  ('followup_ai_writer',   'Follow-up AI: message writer',      'Follow-up AI', 'ai_multiplier_chat'),
  ('followup_ai_qc',       'Follow-up AI: quality control',     'Follow-up AI', 'ai_multiplier_chat')
on conflict (runner_id) do update set multiplier_key = excluded.multiplier_key;
