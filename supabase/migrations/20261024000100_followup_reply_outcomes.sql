-- A follow-up counts as "replied" when the customer writes back within 7 days. Nothing ever set this before, so every
-- outcome stayed "sent", the landing page showed 0 responses and nobody could see whether follow-ups worked.
-- The reply is matched on the contact AND on any other contact of the same business with the same number
-- (phone_key, last 9 digits), because an imported copy of a person used to receive the follow-up while their reply
-- arrived on their WhatsApp contact.

create or replace function public.mark_followup_replied()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text;
begin
  if new.direction is distinct from 'in' or new.contact_id is null then
    return new;
  end if;
  select phone_key into v_key from public.contacts where id = new.contact_id;

  update public.follow_up_outcomes o
     set outcome = 'replied',
         reply_received_at = coalesce(new.created_at, now()),
         hours_to_reply = round((extract(epoch from (coalesce(new.created_at, now()) - o.created_at)) / 3600.0)::numeric, 2)
   where o.business_id = new.business_id
     and o.outcome = 'sent'
     and o.reply_received_at is null
     and o.created_at <= coalesce(new.created_at, now())
     and o.created_at > coalesce(new.created_at, now()) - interval '7 days'
     and (o.contact_id = new.contact_id
          or (v_key is not null and o.contact_id in (
                select c.id from public.contacts c where c.business_id = new.business_id and c.phone_key = v_key)));
  return new;
end;
$$;

revoke execute on function public.mark_followup_replied() from anon, authenticated, public;

create or replace trigger messages_mark_followup_replied
after insert on public.messages
for each row execute function public.mark_followup_replied();

create index if not exists idx_follow_up_outcomes_open on public.follow_up_outcomes (business_id, contact_id, created_at)
  where outcome = 'sent' and reply_received_at is null;

-- Backfill: outcomes already sent that did get a reply within 7 days.
with first_reply as (
  select o.id, min(m.created_at) as replied_at
    from public.follow_up_outcomes o
    join public.contacts oc on oc.id = o.contact_id
    join public.contacts mc on mc.business_id = o.business_id
                           and (mc.id = o.contact_id or (oc.phone_key is not null and mc.phone_key = oc.phone_key))
    join public.messages m on m.contact_id = mc.id and m.direction = 'in'
                          and m.created_at > o.created_at and m.created_at <= o.created_at + interval '7 days'
   where o.outcome = 'sent' and o.reply_received_at is null
   group by o.id
)
update public.follow_up_outcomes o
   set outcome = 'replied',
       reply_received_at = r.replied_at,
       hours_to_reply = round((extract(epoch from (r.replied_at - o.created_at)) / 3600.0)::numeric, 2)
  from first_reply r
 where r.id = o.id;
