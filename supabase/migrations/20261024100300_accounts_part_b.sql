-- Accounts, part 4 of 4 ("part B"). Run AFTER the account-aware backend, follow-up engine and edge functions
-- are deployed, and BEFORE any business adds a second WhatsApp account.
-- Business-level unique keys become per-account keys, and account_id becomes required where every row has one.
-- The old code's upserts on (business_id, ...) stop working after this, which is why the deploy comes first.

-- ─── Unique keys: business → account ─────────────────────────────────────────────────────────────────

alter table public.contacts drop constraint if exists unique_social_lead;
alter table public.conversations drop constraint if exists unique_business_contact;
alter table public.ad_attributions drop constraint if exists ad_attributions_business_id_ad_id_key;
alter table public.ad_playbooks drop constraint if exists ad_playbooks_business_id_ad_id_key;
alter table public.chat_ai_skills drop constraint if exists chat_ai_skills_business_id_key_key;
alter table public.lists drop constraint if exists lists_business_id_rule_id_key;
alter table public.persona_packs drop constraint if exists persona_packs_business_version_unique;
drop index if exists public.lists_business_ad_uidx;
drop index if exists public.campaigns_one_live_auto_per_rule;
drop index if exists public.persona_packs_one_active_per_business;

-- Business-wide persona packs (account_id null) still get one active pack per business.
create unique index if not exists persona_packs_one_active_business_wide on public.persona_packs (business_id)
  where is_active and account_id is null;

-- Tables keyed by (business_id, ...) get a surrogate-free key on (account_id, ...) instead.
do $$
declare
  r record;
begin
  for r in select * from (values
    ('segmentation_rules',    'segmentation_rules_pkey',    'account_id, rule_id',   'segmentation_rules_account_rule_key'),
    ('auto_campaign_configs', 'auto_campaign_configs_pkey', 'account_id, rule_id',   'auto_campaign_configs_account_rule_key'),
    ('followup_ai_skills',    'followup_ai_skills_pkey',    'account_id, key',       'followup_ai_skills_account_key_key'),
    ('daily_send_counters',   'daily_send_counters_pkey',   'account_id, send_date', 'daily_send_counters_account_date_key'),
    ('business_setup',        'business_setup_pkey',        'account_id',            'business_setup_account_key'),
    ('chat_ai_daily_chats',   'chat_ai_daily_chats_pkey',   'account_id, day, conversation_id', 'chat_ai_daily_chats_account_key')
  ) as t(tbl, old_pk, cols, idx) loop
    -- Rows of businesses that never had a WhatsApp number have no account; they can't be keyed by account.
    execute format('delete from public.%I where account_id is null', r.tbl);
    execute format('alter table public.%I drop constraint if exists %I', r.tbl, r.old_pk);
    execute format('alter table public.%I alter column account_id set not null', r.tbl);
    execute format('drop index if exists public.%I', r.idx);
    execute format('alter table public.%I add constraint %I primary key (%s)', r.tbl, r.tbl || '_pkey', r.cols);
  end loop;
end $$;

-- ─── account_id required on WhatsApp data ────────────────────────────────────────────────────────────

-- Businesses that never connected WhatsApp only have seeded defaults; their first account seeds fresh ones.
delete from public.lists l
 where l.account_id is null and l.type = 'auto'
   and not exists (select 1 from public.accounts a where a.business_id = l.business_id)
   and not exists (select 1 from public.list_members m where m.list_id = l.id);
delete from public.chat_ai_skills s
 where s.account_id is null and not exists (select 1 from public.accounts a where a.business_id = s.business_id);

-- Anything else without an account is left as it is; for every table where all rows have one, the column
-- becomes NOT NULL.
do $$
declare t text;
begin
  foreach t in array array[
    'contacts','conversations','messages','customer_profiles','customer_notes','contact_activity_patterns',
    'conversation_enrichment','sentiment_snapshots','lead_ai_state','lead_calls','lead_meeting_reminders',
    'lead_meetings','lead_stage_changes','lead_stage_requests','lead_tasks','lead_timeline',
    'follow_up_queue','follow_up_send_events','follow_up_outcomes','followup_ai_turns','followup_billing_events',
    'followup_nudge_log','campaigns','campaign_enrollments','lists',
    'ad_attributions','ad_playbooks','ad_playbook_items','chat_flows','chat_ai_skills',
    'chat_ai_turns','chat_ai_outbox','chat_test_feedback','handoff_events',
    'product_mentions','conversions','enrichment_runs','whatsapp_sessions'
  ] loop
    begin
      execute format('alter table public.%I alter column account_id set not null', t);
    exception when not_null_violation then
      raise notice 'account_id left nullable on %: some rows belong to businesses without a WhatsApp account', t;
    end;
  end loop;
end $$;

create or replace function public.accounts_part_b_applied()
returns boolean language sql immutable as $$ select true $$;
