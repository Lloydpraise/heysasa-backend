alter table public.campaign_enrollments
    drop constraint if exists campaign_enrollments_lead_id_fkey;

alter table public.campaign_enrollments
    add constraint campaign_enrollments_lead_id_fkey
    foreign key (lead_id) references public.contacts(id);

create index if not exists idx_campaign_enrollments_active_lead
    on public.campaign_enrollments (lead_id, campaign_id)
    where status in ('pending', 'active');
