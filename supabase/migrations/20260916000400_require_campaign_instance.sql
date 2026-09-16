alter table public.campaigns
    drop constraint if exists campaigns_active_instance_check;

alter table public.campaigns
    add constraint campaigns_active_instance_check
    check (status <> 'active' or nullif(btrim(whatsapp_instance_name), '') is not null);
