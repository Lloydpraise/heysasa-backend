-- Accounts, part 2 of 4: put every existing row on its business's account.
-- Today no business has more than one WhatsApp number, so each business's rows go to its one (primary) account.
-- Triggers are paused per table while it is filled, so "updated_at" stamps, list syncs and the like don't fire on
-- what is only a bookkeeping change. Businesses without an account (no WhatsApp history) keep account_id null.
-- system_logs is not back-filled (it is a log; new rows get the account from the trigger).
-- The business catalog stays business-level (shared by every account): hand-added products, knowledge files,
-- follow-up materials and chat tools. Only products discovered from a number's chats move to that account.

do $$
declare
  t text;
begin
  foreach t in array array[
    'contacts','conversations','messages','customer_profiles','customer_notes','contact_activity_patterns',
    'sentiment_snapshots','lead_ai_state','lead_calls','lead_meeting_reminders',
    'lead_meetings','lead_stage_changes','lead_stage_requests','lead_tasks','lead_timeline',
    'follow_up_queue','follow_up_send_events','follow_up_outcomes','followup_ai_turns','followup_billing_events',
    'followup_nudge_log','followup_ai_skills','campaigns','lists','segmentation_rules',
    'auto_campaign_configs','ad_attributions','ad_playbooks','ad_playbook_items','chat_flows','chat_ai_skills',
    'chat_ai_turns','chat_ai_outbox','chat_ai_daily_chats','chat_test_feedback','handoff_events',
    'product_mentions','conversions','daily_send_counters','enrichment_runs','business_setup',
    'persona_packs','ai_usage_log','balance_transactions','ba_conversations','ba_actions'
  ] loop
    execute format('alter table public.%I disable trigger user', t);
    execute format(
      'update public.%I x set account_id = a.id from public.accounts a
        where a.business_id = x.business_id and a.is_primary and x.account_id is null', t);
    execute format('alter table public.%I enable trigger user', t);
  end loop;
end $$;

-- Tables that reach their business through a parent row.
alter table public.campaign_enrollments disable trigger user;
update public.campaign_enrollments e set account_id = c.account_id
  from public.campaigns c where c.id = e.campaign_id and e.account_id is null and c.account_id is not null;
alter table public.campaign_enrollments enable trigger user;

alter table public.conversation_enrichment disable trigger user;
update public.conversation_enrichment e set account_id = c.account_id
  from public.contacts c where c.id = e.contact_id and e.account_id is null and c.account_id is not null;
alter table public.conversation_enrichment enable trigger user;

alter table public.waitlist_leads disable trigger user;
update public.waitlist_leads w set account_id = c.account_id
  from public.contacts c where c.id = w.contact_id and w.account_id is null and c.account_id is not null;
alter table public.waitlist_leads enable trigger user;

alter table public.products disable trigger user;
update public.products p set account_id = a.id
  from public.accounts a
 where a.business_id = p.business_id and a.is_primary and p.account_id is null
   and p.source in ('chat', 'image', 'chat_image');
alter table public.products enable trigger user;
