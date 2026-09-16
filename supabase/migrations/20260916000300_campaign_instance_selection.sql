alter table public.campaigns
    add column if not exists whatsapp_instance_name text;

alter table public.campaigns
    add column if not exists failure_reason text;

alter table public.campaigns
    add column if not exists failed_at timestamptz;

comment on column public.campaigns.whatsapp_instance_name is
    'Explicit Evolution instance used by this campaign. Required while the campaign is active.';

alter table public.follow_up_queue
    add column if not exists assigned_instance_name text;

comment on column public.follow_up_queue.assigned_instance_name is
    'Snapshot of the campaign Evolution instance selected when this queue item was created.';

alter table public.campaigns
    drop constraint if exists campaigns_status_check;

alter table public.campaigns
    add constraint campaigns_status_check
    check (status = any (array['active', 'paused', 'completed', 'failed']));

create index if not exists campaigns_whatsapp_instance_name_idx
    on public.campaigns (whatsapp_instance_name)
    where whatsapp_instance_name is not null;

create index if not exists follow_up_queue_assigned_instance_name_idx
    on public.follow_up_queue (assigned_instance_name)
    where assigned_instance_name is not null;

update public.campaigns
     set status = 'failed',
             failure_reason = 'campaign_instance_required',
             failed_at = now()
 where status = 'active'
     and whatsapp_instance_name is null;
