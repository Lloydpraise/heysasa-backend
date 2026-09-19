-- Splits "did they act on this message's call-to-action" (action) from
-- generic tone (positive/negative/neutral), and adds opt_out as an
-- informational label on the step event itself.
--
-- Note: opt_out here is informational only — it does NOT flip
-- contacts.do_not_contact or cancel the campaign enrollment. That
-- side effect stays owned solely by optInClassifier.js (runOptInClassifier),
-- which already does it reliably and is the one place that should ever
-- change subscription state. Two independent AI calls reaching different
-- conclusions and fighting over do_not_contact would be worse than one
-- classifier's opt_out label sometimes lagging the other by a poll cycle.

do $$
begin
    if exists (
        select 1 from pg_constraint where conname = 'campaign_step_events_reply_intent_check'
    ) then
        alter table public.campaign_step_events
            drop constraint campaign_step_events_reply_intent_check;
    end if;

    alter table public.campaign_step_events
        add constraint campaign_step_events_reply_intent_check
        check (reply_intent is null or reply_intent in ('action', 'positive', 'negative', 'opt_out', 'neutral'));
end $$;

comment on column public.campaign_step_events.reply_intent is
    'action/positive/negative/opt_out/neutral read on the lead''s reply or reaction to this step. '
    '"action" means the lead directly acted on this step''s call-to-action (highest-priority signal). '
    'opt_out here is informational only — see optInClassifier.js for the actual subscription-state change. '
    'Null until classified.';

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
    count(cse.id) filter (where cse.reply_intent = 'action') as action_count,
    count(cse.id) filter (where cse.reply_intent = 'positive') as positive_count,
    count(cse.id) filter (where cse.reply_intent = 'negative') as negative_count,
    count(cse.id) filter (where cse.opted_out_at is not null) as opt_outs,
    cst.media
from public.campaign_steps cst
left join public.campaign_step_events cse on cse.step_id = cst.id
group by cst.id;
