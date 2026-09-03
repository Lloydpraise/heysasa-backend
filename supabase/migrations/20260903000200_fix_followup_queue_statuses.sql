alter table public.follow_up_queue
    drop constraint if exists fq_status_check;

alter table public.follow_up_queue
    add constraint fq_status_check
    check (status = any (array[
        'pending',
        'ready_to_send',
        'sent',
        'failed',
        'skipped',
        'cancelled'
    ]));

alter table public.campaign_enrollments
    drop constraint if exists campaign_enrollments_status_check;

alter table public.campaign_enrollments
    add constraint campaign_enrollments_status_check
    check (status = any (array[
        'pending',
        'active',
        'awaiting_opt_in',
        'completed',
        'opted_out'
    ]));

create unique index if not exists uq_follow_up_queue_campaign_contact_step
    on public.follow_up_queue (campaign_id, contact_id, campaign_step)
    where campaign_id is not null
      and status in ('pending', 'ready_to_send', 'sent');
