-- M3: check a number exists on WhatsApp before sending, and record why a send failed.
-- Safe to run twice.

-- 1. What we know about each contact's number. null = never checked.
alter table public.contacts
  add column if not exists wa_exists boolean,
  add column if not exists wa_checked_at timestamptz;

-- 2. Why the last send attempt failed (one plain label), so the console and daily summary can count reasons.
alter table public.follow_up_queue
  add column if not exists failure_class text;

-- 3. Numbers that already failed with "exists: false" are now known not to be on WhatsApp,
--    so they are never tried again.
update public.contacts c
   set wa_exists = false, wa_checked_at = now()
 where c.wa_exists is null
   and exists (select 1 from public.follow_up_queue q
                where q.contact_id = c.id and q.status = 'failed'
                  and q.last_dispatch_error like '%"exists":false%');

update public.follow_up_queue
   set failure_class = 'not_on_whatsapp'
 where status = 'failed' and failure_class is null and last_dispatch_error like '%"exists":false%';

-- 4. Campaign enrolments stuck behind a permanently failed message never advance and never finish.
--    Close those that are stuck on a "not on WhatsApp" number.
update public.campaign_enrollments e
   set status = 'exited'
 where e.status in ('pending', 'active')
   and exists (select 1 from public.follow_up_queue q
                where q.campaign_id = e.campaign_id and q.contact_id = e.lead_id
                  and q.status = 'failed' and q.failure_class = 'not_on_whatsapp');
