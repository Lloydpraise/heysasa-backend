update public.campaign_enrollments ce
   set status = 'awaiting_opt_in',
       next_send_at = null
  from public.contacts c
 where c.id = ce.lead_id
   and ce.status in ('pending', 'active')
   and c.follow_up_opted_in = false
   and c.do_not_contact = false;

delete from public.follow_up_queue fq
 where fq.campaign_id is not null
   and fq.status = 'skipped'
   and fq.skip_reason = 'not_opted_in';

delete from public.follow_up_queue fq
 where fq.campaign_id is not null
   and fq.status = 'pending'
   and exists (
       select 1
         from public.contacts c
        where c.id = fq.contact_id
          and c.follow_up_opted_in = false
   );
