-- Closes the campaign feedback loop: campaign_step_events.message_id has
-- always existed but was never populated (postSend.js hardcoded null), so
-- there was no join from a sent step to its actual message row, and no
-- columns to record a reaction against a step. Adds what's missing and a
-- read view for the dashboard.a

alter table public.campaign_step_events
    add column if not exists reacted_at timestamptz,
    add column if not exists reaction_emoji text;

comment on column public.campaign_step_events.reacted_at is
    'When the lead reacted (emoji) to this step''s outbound WhatsApp message.';
comment on column public.campaign_step_events.reaction_emoji is
    'The emoji used in the reaction, if any.';

-- message_id already exists on this table (populated as null up to now).
-- Make sure it's actually wired to messages.id so the join below is real,
-- and that losing a message row doesn't take the step event with it.
do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conname = 'campaign_step_events_message_id_fkey'
    ) then
        alter table public.campaign_step_events
            add constraint campaign_step_events_message_id_fkey
            foreign key (message_id) references public.messages(id)
            on delete set null;
    end if;
end $$;

create index if not exists idx_campaign_step_events_message_id
    on public.campaign_step_events (message_id);

-- Per-message, per-contact, per-campaign feedback: sent -> delivery/read
-- status (from messages, already populated by processMessageStatusUpdate)
-- -> replied_at -> reacted_at/reaction_emoji, all in one row.
create or replace view public.v_campaign_message_feedback as
select
    cse.id as step_event_id,
    cse.enrollment_id,
    ce.campaign_id,
    ce.lead_id as contact_id,
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
    cse.opted_out_at
from public.campaign_step_events cse
join public.campaign_enrollments ce on ce.id = cse.enrollment_id
join public.campaign_steps cst on cst.id = cse.step_id
left join public.messages m on m.id = cse.message_id;
