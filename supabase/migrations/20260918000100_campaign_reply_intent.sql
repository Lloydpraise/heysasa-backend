-- Adds sentiment on top of the raw engagement signal from the previous
-- migration: replied_at/reacted_at tell us *that* a lead responded,
-- reply_intent tells us whether that response was worth acting on.
--
-- Populated two ways (both write the same column, never conflicting since
-- a step event is either a reaction OR a text reply):
--   - Reactions: classified instantly, locally, via an emoji map in
--     dbService.js (recordCampaignStepReaction) — no AI call needed.
--   - Text replies: classified by campaignReplyIntentClassifier.js on a
--     poll cycle in followup-engine, same pattern as optInClassifier.js.

alter table public.campaign_step_events
    add column if not exists reply_intent text;

do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'campaign_step_events_reply_intent_check'
    ) then
        alter table public.campaign_step_events
            add constraint campaign_step_events_reply_intent_check
            check (reply_intent is null or reply_intent in ('positive', 'negative', 'neutral'));
    end if;
end $$;

comment on column public.campaign_step_events.reply_intent is
    'positive/negative/neutral read on the lead''s reply or reaction to this step. Null until classified.';

-- Re-created with lead identity (name/phone) and reply_intent so the
-- dashboard can list "who responded" and open their chat directly,
-- without a second round-trip to contacts.
create or replace view public.v_campaign_message_feedback as
select
    cse.id as step_event_id,
    cse.enrollment_id,
    ce.campaign_id,
    ce.lead_id as contact_id,
    c.name as contact_name,
    c.phone as contact_phone,
    cse.step_id,
    cst.step_number,
    cse.message_id,
    m.whatsapp_message_id,
    m.status as delivery_status,
    m.is_read,
    cse.sent_at,
    cse.replied_at,
    cse.reacted_at,
    cse.reaction_emoji,
    cse.reply_intent,
    cse.opted_out_at
from public.campaign_step_events cse
join public.campaign_enrollments ce on ce.id = cse.enrollment_id
join public.campaign_steps cst on cst.id = cse.step_id
join public.contacts c on c.id = ce.lead_id
left join public.messages m on m.id = cse.message_id;

-- Adds reacted_count and positive_count alongside the existing
-- sent/replied/opt_out counts, so the campaign runner's per-step card can
-- show engagement strength, not just a raw response rate.
create or replace view public.v_campaign_step_summary as
select
    cst.id as step_id,
    cst.campaign_id,
    cst.step_number,
    cst.content,
    cst.delay_hours,
    cst.condition,
    count(cse.id) filter (where cse.sent_at is not null) as sent_count,
    count(cse.id) filter (where cse.replied_at is not null) as replied_count,
    count(cse.id) filter (where cse.reacted_at is not null) as reacted_count,
    count(cse.id) filter (where cse.reply_intent = 'positive') as positive_count,
    count(cse.id) filter (where cse.reply_intent = 'negative') as negative_count,
    count(cse.id) filter (where cse.opted_out_at is not null) as opt_outs,
    cst.media
from public.campaign_steps cst
left join public.campaign_step_events cse on cse.step_id = cst.id
group by cst.id;
