-- Campaign feedback pipes: sent -> delivered -> read -> responded, per campaign.
--
-- What was broken (found by comparing the code with live data):
--   1. Delivery/read receipts never reached campaign messages. Evolution's messages.update payload
--      carries the WhatsApp message id as `keyId`; the handler only looked at `key.id`, skipped every
--      update silently, and still logged "ok". Only "sent" and an inferred "read" ever existed.
--   2. Replies were lost. Uploaded/manual-list contacts are stored as one contact (bare phone, no
--      WhatsApp id) and the person's real chat arrives as a second contact (254...@s.whatsapp.net).
--      The reply landed on the chat contact, the enrolment sat on the uploaded one, so nothing matched.
--      Replies after a campaign finished (enrolment "completed") were ignored as well.
--   3. 119 of 246 campaign sends had no link to their message row (older sends), so they were
--      excluded from every count.
--   4. The campaign summary only knew sent + replied; delivered/read did not exist, and "responded"
--      ignored reactions.
--
-- This migration is additive and safe to run more than once.

-- ---------------------------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------------------------

alter table public.messages
    add column if not exists delivered_at timestamptz;

comment on column public.messages.delivered_at is
    'When WhatsApp confirmed the message reached the lead''s phone (DELIVERY_ACK). Set by apply_message_receipt.';

-- Last 9 digits of the phone, so "712844472", "+254 712 844 472" and "254712844472" are the same person.
-- Used to connect an uploaded contact with the contact created by their real WhatsApp chat.
alter table public.contacts
    add column if not exists phone_key text generated always as (
        case
            when length(regexp_replace(coalesce(phone, ''), '\D', '', 'g')) >= 9
                then right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 9)
        end
    ) stored;

create index if not exists idx_contacts_business_phone_key
    on public.contacts (business_id, phone_key)
    where phone_key is not null;

-- ---------------------------------------------------------------------------------------------
-- 2. Functions
-- ---------------------------------------------------------------------------------------------

-- 0 unknown/pending, 1 sent, 2 delivered, 3 read. A receipt can only move a message forward.
create or replace function public.message_receipt_rank(p_status text)
returns integer
language sql
immutable
as $$
    select case lower(coalesce(p_status, ''))
        when 'sent' then 1
        when 'server_ack' then 1
        when 'delivered' then 2
        when 'delivery_ack' then 2
        when 'read' then 3
        when 'played' then 3
        else 0
    end
$$;

-- Applies one WhatsApp receipt to our outbound message. Statuses are stored in plain words
-- (sent / delivered / read, and ERROR for a failure); out-of-order receipts never move a message backwards.
-- Deliberately does not touch is_read: on outbound rows that flag drives the unread-count trigger.
create or replace function public.apply_message_receipt(
    p_business_id text,
    p_whatsapp_message_id text,
    p_status text,
    p_at timestamptz default now()
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
    v_rank integer := public.message_receipt_rank(p_status);
    v_state text;
    v_rows integer := 0;
begin
    if p_whatsapp_message_id is null or p_business_id is null then
        return 0;
    end if;

    if upper(coalesce(p_status, '')) = 'ERROR' then
        -- 'ERROR' is the spelling v_lead_summary already maps to "failed".
        update public.messages
        set status = 'ERROR'
        where business_id = p_business_id
          and whatsapp_message_id = p_whatsapp_message_id
          and direction = 'out'
          and public.message_receipt_rank(status) < 2;
        get diagnostics v_rows = row_count;
        return v_rows;
    end if;

    if v_rank < 1 then
        return 0;
    end if;

    v_state := case v_rank when 1 then 'sent' when 2 then 'delivered' else 'read' end;

    update public.messages
    set status = case when public.message_receipt_rank(status) >= v_rank then status else v_state end,
        delivered_at = case when v_rank >= 2 then coalesce(delivered_at, p_at) else delivered_at end,
        read_at = case when v_rank >= 3 then coalesce(read_at, p_at) else read_at end
    where business_id = p_business_id
      and whatsapp_message_id = p_whatsapp_message_id
      and direction = 'out';
    get diagnostics v_rows = row_count;
    return v_rows;
end;
$$;

-- A lead wrote to us. Finds the campaign message this answers and marks it replied.
--   * matches the lead by contact id OR by phone, so uploaded + chat contacts count as one person
--   * looks at every campaign send in the last p_window, even if the enrolment has finished
--   * answers the most recent send only, and only once (a second text is the same conversation)
-- A reply proves the message was delivered and read, so those are filled in too.
create or replace function public.attribute_campaign_reply(
    p_business_id text,
    p_contact_id bigint,
    p_at timestamptz default now(),
    p_window interval default interval '7 days'
)
returns table (step_event_id uuid, enrollment_id uuid, lead_id bigint, campaign_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_key text;
    v_event record;
begin
    select k.phone_key into v_key
    from public.contacts k
    where k.id = p_contact_id and k.business_id = p_business_id;

    select cse.id as sid, cse.enrollment_id as eid, ce.lead_id as lid, ce.campaign_id as cid,
           cse.replied_at as replied_at, cse.message_id as mid
    into v_event
    from public.campaign_step_events cse
    join public.campaign_enrollments ce on ce.id = cse.enrollment_id
    join public.campaigns camp on camp.id = ce.campaign_id and camp.business_id = p_business_id
    where cse.sent_at is not null
      and cse.sent_at <= p_at
      and cse.sent_at > p_at - p_window
      and (
          ce.lead_id = p_contact_id
          or (v_key is not null and exists (
                select 1 from public.contacts k
                where k.id = ce.lead_id and k.business_id = p_business_id and k.phone_key = v_key))
      )
    order by cse.sent_at desc
    limit 1;

    if not found or v_event.replied_at is not null then
        return;
    end if;

    update public.campaign_step_events set replied_at = p_at where id = v_event.sid;

    update public.messages m
    set status = case when public.message_receipt_rank(m.status) >= 3 then m.status else 'read' end,
        delivered_at = coalesce(m.delivered_at, p_at),
        read_at = coalesce(m.read_at, p_at)
    where m.id = v_event.mid and m.direction = 'out';

    update public.campaign_enrollments set last_reply_at = p_at where id = v_event.eid;

    return query select v_event.sid, v_event.eid, v_event.lid, v_event.cid;
end;
$$;

-- A lead reacted (emoji) to one of our messages. Returns how many campaign messages it matched
-- (0 means it was a reaction to something that was not a campaign send).
create or replace function public.attribute_campaign_reaction(
    p_business_id text,
    p_reacted_whatsapp_message_id text,
    p_emoji text,
    p_intent text,
    p_at timestamptz default now()
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
    v_rows integer := 0;
begin
    -- An empty emoji is the lead removing their reaction.
    if p_reacted_whatsapp_message_id is null or coalesce(p_emoji, '') = '' then
        return 0;
    end if;

    with hit as (
        update public.campaign_step_events cse
        set reacted_at = p_at,
            reaction_emoji = p_emoji,
            reply_intent = coalesce(cse.reply_intent, p_intent)
        from public.messages m
        where m.id = cse.message_id
          and m.business_id = p_business_id
          and m.whatsapp_message_id = p_reacted_whatsapp_message_id
        returning cse.id, cse.enrollment_id, cse.message_id
    ),
    enrol as (
        update public.campaign_enrollments ce
        set last_reply_at = p_at
        from hit
        where ce.id = hit.enrollment_id
        returning ce.id
    ),
    msg as (
        update public.messages m
        set status = case when public.message_receipt_rank(m.status) >= 3 then m.status else 'read' end,
            delivered_at = coalesce(m.delivered_at, p_at),
            read_at = coalesce(m.read_at, p_at)
        from hit
        where m.id = hit.message_id
        returning m.id
    )
    select count(*) into v_rows from hit;

    return v_rows;
end;
$$;

-- These run with elevated rights; only the backend (service role) may call them.
revoke execute on function public.apply_message_receipt(text, text, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.attribute_campaign_reply(text, bigint, timestamptz, interval) from public, anon, authenticated;
revoke execute on function public.attribute_campaign_reaction(text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.apply_message_receipt(text, text, text, timestamptz) to service_role;
grant execute on function public.attribute_campaign_reply(text, bigint, timestamptz, interval) to service_role;
grant execute on function public.attribute_campaign_reaction(text, text, text, text, timestamptz) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. Repair existing data
-- ---------------------------------------------------------------------------------------------

-- 3a. Older sends that were never linked to their message row.
with candidate as (
    select distinct on (cse.id) cse.id as event_id, m.id as message_id
    from public.campaign_step_events cse
    join public.campaign_enrollments ce on ce.id = cse.enrollment_id
    join public.messages m
      on m.contact_id = ce.lead_id
     and m.direction = 'out'
     and m.agent_role = 'follow_up_ai'
     and m.created_at = cse.sent_at
    where cse.message_id is null
      and cse.sent_at is not null
    order by cse.id, m.created_at
)
update public.campaign_step_events cse
set message_id = candidate.message_id
from candidate
where cse.id = candidate.event_id
  and not exists (select 1 from public.campaign_step_events o where o.message_id = candidate.message_id);

-- 3b. Replies that were never attributed: the first inbound message (not a reaction) after a send, before the
-- lead's next campaign message and within 7 days, from the same person (same contact or same phone).
with ev as (
    select cse.id, cse.sent_at, ce.lead_id, camp.business_id, ct.phone_key,
           lead(cse.sent_at) over (partition by cse.enrollment_id order by cse.sent_at) as next_sent
    from public.campaign_step_events cse
    join public.campaign_enrollments ce on ce.id = cse.enrollment_id
    join public.campaigns camp on camp.id = ce.campaign_id
    join public.contacts ct on ct.id = ce.lead_id
    where cse.sent_at is not null
),
first_reply as (
    select ev.id, min(m.created_at) as at
    from ev
    join public.messages m
      on m.business_id = ev.business_id
     and m.direction = 'in'
     and coalesce(m.type, '') <> 'reaction'
     and m.created_at > ev.sent_at
     and m.created_at < least(coalesce(ev.next_sent, 'infinity'::timestamptz), ev.sent_at + interval '7 days')
     and (
         m.contact_id = ev.lead_id
         or (ev.phone_key is not null and exists (
                select 1 from public.contacts k
                where k.id = m.contact_id and k.business_id = ev.business_id and k.phone_key = ev.phone_key))
     )
    group by ev.id
)
update public.campaign_step_events cse
set replied_at = first_reply.at
from first_reply
where cse.id = first_reply.id
  and cse.replied_at is null;

update public.campaign_enrollments ce
set last_reply_at = latest.at
from (
    select cse.enrollment_id, max(least(cse.replied_at, coalesce(cse.reacted_at, cse.replied_at))) as at
    from public.campaign_step_events cse
    where cse.replied_at is not null or cse.reacted_at is not null
    group by cse.enrollment_id
) latest
where ce.id = latest.enrollment_id
  and (ce.last_reply_at is null or ce.last_reply_at < latest.at);

-- 3c. A reply or reaction proves the campaign message was delivered and read. Receipts for older sends are gone
-- (WhatsApp does not resend them), so this is the most that can be said about history.
update public.messages m
set status = case when public.message_receipt_rank(m.status) >= 3 then m.status else 'read' end,
    delivered_at = coalesce(m.delivered_at, cse.replied_at, cse.reacted_at),
    read_at = coalesce(m.read_at, cse.replied_at, cse.reacted_at)
from public.campaign_step_events cse
where cse.message_id = m.id
  and m.direction = 'out'
  and (cse.replied_at is not null or cse.reacted_at is not null);

-- ---------------------------------------------------------------------------------------------
-- 4. Views (new columns are appended; existing columns keep their names and order)
-- ---------------------------------------------------------------------------------------------

create or replace view public.v_campaign_message_feedback_base as
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
    cse.opted_out_at,
    c.name as contact_name,
    c.phone as contact_phone,
    cse.reply_intent,
    least(cse.replied_at, cse.reacted_at) as responded_at,
    (m.id is not null and (
        cse.replied_at is not null or cse.reacted_at is not null
        or m.delivered_at is not null or m.read_at is not null
        or public.message_receipt_rank(m.status) >= 2
    )) as was_delivered,
    (m.id is not null and (
        cse.replied_at is not null or cse.reacted_at is not null
        or m.read_at is not null
        or public.message_receipt_rank(m.status) >= 3
    )) as was_read,
    case
        when m.id is null then null
        when cse.replied_at is not null or cse.reacted_at is not null
             or m.read_at is not null or public.message_receipt_rank(m.status) >= 3 then 'read'
        when m.delivered_at is not null or public.message_receipt_rank(m.status) >= 2 then 'delivered'
        when upper(coalesce(m.status, '')) in ('ERROR', 'FAILED') then 'failed'
        else 'sent'
    end as delivery_state
from public.campaign_step_events cse
join public.campaign_enrollments ce on ce.id = cse.enrollment_id
join public.campaign_steps cst on cst.id = cse.step_id
join public.contacts c on c.id = ce.lead_id
left join public.messages m on m.id = cse.message_id;

create or replace view public.v_campaign_message_feedback
with (security_invoker = false) as
select
    step_event_id,
    enrollment_id,
    campaign_id,
    contact_id,
    step_id,
    step_number,
    message_id,
    whatsapp_message_id,
    delivery_status,
    is_read,
    sent_at,
    replied_at,
    reacted_at,
    reaction_emoji,
    opted_out_at,
    contact_name,
    contact_phone,
    reply_intent,
    responded_at,
    was_delivered,
    was_read,
    delivery_state
from public.v_campaign_message_feedback_base
where (select auth.role()) = 'service_role'
   or campaign_id in (
       select c.id from public.campaigns c
       where c.business_id in (select public.my_business_ids())
   );

create or replace view public.v_campaign_step_summary_base as
select
    cst.id as step_id,
    cst.campaign_id,
    cst.step_number,
    cst.content,
    cst.delay_hours,
    cst.condition,
    count(distinct cse.id) filter (where cse.sent_at is not null and cse.message_id is not null) as sent_count,
    count(distinct cse.id) filter (where cse.replied_at is not null and cse.sent_at is not null and cse.message_id is not null) as replied_count,
    count(distinct cse.id) filter (where cse.opted_out_at is not null) as opt_outs,
    cst.media,
    count(distinct cse.id) filter (where feedback.reacted_at is not null) as reacted_count,
    count(distinct cse.id) filter (where feedback.reply_intent = 'positive') as positive_count,
    count(distinct cse.id) filter (where feedback.reply_intent = 'negative') as negative_count,
    count(distinct cse.id) filter (where feedback.reply_intent = 'action') as action_count,
    count(distinct cse.id) filter (where feedback.was_delivered and cse.sent_at is not null and cse.message_id is not null) as delivered_count,
    count(distinct cse.id) filter (where feedback.was_read and cse.sent_at is not null and cse.message_id is not null) as read_count,
    count(distinct cse.id) filter (where feedback.responded_at is not null and cse.sent_at is not null and cse.message_id is not null) as responded_count
from public.campaign_steps cst
left join public.campaign_step_events cse on cse.step_id = cst.id
left join public.v_campaign_message_feedback feedback on feedback.step_event_id = cse.id
group by cst.id;

create or replace view public.v_campaign_step_summary
with (security_invoker = false) as
select
    step_id,
    campaign_id,
    step_number,
    content,
    delay_hours,
    condition,
    sent_count,
    replied_count,
    opt_outs,
    media,
    reacted_count,
    positive_count,
    negative_count,
    action_count,
    delivered_count,
    read_count,
    responded_count
from public.v_campaign_step_summary_base
where (select auth.role()) = 'service_role'
   or campaign_id in (
       select c.id from public.campaigns c
       where c.business_id in (select public.my_business_ids())
   );

-- Same revenue de-duplication as before. response_rate now counts replies AND reactions.
create or replace view public.v_campaign_summary_base as
with campaign_revenue_rows as (
    select distinct ce.campaign_id, conv.id as conversion_id, conv.deal_value
    from public.campaign_enrollments ce
    join public.campaigns c on c.id = ce.campaign_id
    join public.conversions conv
      on conv.contact_id = ce.lead_id
     and conv.converted_at >= c.created_at
),
campaign_revenue as (
    select campaign_id, sum(deal_value) as realized_revenue
    from campaign_revenue_rows
    group by campaign_id
)
select
    c.id as campaign_id,
    c.business_id,
    c.name,
    c.status,
    c.list_id,
    li.name as list_name,
    c.sequence_mode,
    c.gateway_type,
    c.daily_cap,
    coalesce(dsc.sent_today, 0) as sent_today,
    count(distinct ce.id) as enrolled_count,
    count(distinct cse.id) filter (where cse.sent_at is not null and cse.message_id is not null) as sent_count,
    count(distinct cse.id) filter (where cse.replied_at is not null and cse.sent_at is not null and cse.message_id is not null) as replies_count,
    round(
        100.0 * count(distinct cse.id) filter (where fb.responded_at is not null and cse.sent_at is not null and cse.message_id is not null)
        / nullif(count(distinct cse.id) filter (where cse.sent_at is not null and cse.message_id is not null), 0),
        1
    ) as response_rate,
    coalesce(cr.realized_revenue, 0::numeric) as realized_revenue,
    c.ai_rewrite_enabled,
    c.auto_approve,
    c.whatsapp_instances,
    count(distinct cse.enrollment_id) filter (where cse.sent_at is not null and cse.message_id is not null) as reached_count,
    count(distinct cse.id) filter (where fb.was_delivered and cse.sent_at is not null and cse.message_id is not null) as delivered_count,
    count(distinct cse.id) filter (where fb.was_read and cse.sent_at is not null and cse.message_id is not null) as read_count,
    count(distinct cse.id) filter (where fb.responded_at is not null and cse.sent_at is not null and cse.message_id is not null) as responded_count,
    count(distinct ce.id) filter (where fb.responded_at is not null and cse.sent_at is not null and cse.message_id is not null) as responded_leads
from public.campaigns c
join public.lists li on li.id = c.list_id
left join public.campaign_enrollments ce on ce.campaign_id = c.id
left join public.campaign_step_events cse on cse.enrollment_id = ce.id
left join public.v_campaign_message_feedback_base fb on fb.step_event_id = cse.id
left join campaign_revenue cr on cr.campaign_id = c.id
left join public.daily_send_counters dsc
  on dsc.business_id = c.business_id
 and dsc.send_date = current_date
group by c.id, li.name, dsc.sent_today, cr.realized_revenue;

create or replace view public.v_campaign_summary
with (security_invoker = false) as
select
    campaign_id,
    business_id,
    name,
    status,
    list_id,
    list_name,
    sequence_mode,
    gateway_type,
    daily_cap,
    sent_today,
    enrolled_count,
    sent_count,
    replies_count,
    response_rate,
    realized_revenue,
    ai_rewrite_enabled,
    auto_approve,
    whatsapp_instances,
    reached_count,
    delivered_count,
    read_count,
    responded_count,
    responded_leads
from public.v_campaign_summary_base
where (select auth.role()) = 'service_role'
   or business_id in (select public.my_business_ids());

-- One row per lead who responded (replied or reacted) to a campaign: who, how, when, and which contact
-- holds their real WhatsApp chat (so "open chat" shows the conversation, not an empty uploaded row).
create or replace view public.v_campaign_responders_base as
select
    fb.campaign_id,
    camp.name as campaign_name,
    camp.business_id,
    fb.contact_id as enrolled_contact_id,
    coalesce(chat.id, fb.contact_id) as chat_contact_id,
    coalesce(nullif(chat.name, ''), nullif(ec.name, ''), chat.phone, ec.phone) as contact_name,
    coalesce(chat.phone, ec.phone) as contact_phone,
    min(fb.responded_at) as first_responded_at,
    max(fb.responded_at) as last_responded_at,
    count(*) as responses,
    bool_or(fb.replied_at is not null) as replied,
    bool_or(fb.reacted_at is not null) as reacted,
    (array_agg(fb.step_number order by fb.responded_at desc))[1] as last_step_number,
    (array_agg(fb.reaction_emoji order by fb.responded_at desc))[1] as last_reaction_emoji,
    (array_agg(fb.reply_intent order by fb.responded_at desc))[1] as last_reply_intent
from public.v_campaign_message_feedback_base fb
join public.campaigns camp on camp.id = fb.campaign_id
join public.contacts ec on ec.id = fb.contact_id
left join lateral (
    select k.id, k.name, k.phone
    from public.contacts k
    where k.business_id = camp.business_id
      and (k.id = ec.id or (ec.phone_key is not null and k.phone_key = ec.phone_key))
      and exists (select 1 from public.conversations cv where cv.contact_id = k.id)
    order by (k.id = ec.id) desc, k.last_inbound_at desc nulls last
    limit 1
) chat on true
where fb.responded_at is not null
  and fb.sent_at is not null
  and fb.message_id is not null
group by fb.campaign_id, camp.name, camp.business_id, fb.contact_id, chat.id, chat.name, chat.phone, ec.name, ec.phone;

create or replace view public.v_campaign_responders
with (security_invoker = false) as
select
    campaign_id,
    campaign_name,
    business_id,
    enrolled_contact_id,
    chat_contact_id,
    contact_name,
    contact_phone,
    first_responded_at,
    last_responded_at,
    responses,
    replied,
    reacted,
    last_step_number,
    last_reaction_emoji,
    last_reply_intent
from public.v_campaign_responders_base
where (select auth.role()) = 'service_role'
   or business_id in (select public.my_business_ids());

revoke all on public.v_campaign_responders_base from anon, authenticated;
revoke all on public.v_campaign_responders from anon;
revoke all on public.v_campaign_responders from authenticated;
grant select on public.v_campaign_responders to authenticated;
