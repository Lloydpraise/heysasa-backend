alter table public.follow_up_queue
    drop constraint if exists fq_status_check;

alter table public.follow_up_queue
    add constraint fq_status_check
    check (status = any (array[
        'pending',
        'ready_to_send',
        'sending',
        'sent',
        'failed',
        'skipped',
        'cancelled'
    ]));
