alter table public.campaign_steps
    add column if not exists media jsonb;

comment on column public.campaign_steps.media is
    'Optional outbound WhatsApp media: {type, url, mime_type, file_name, caption}';

create or replace view public.v_campaign_step_summary as
select
    cst.id as step_id,
    cst.campaign_id,
    cst.step_number,
    cst.content,
    cst.delay_hours,
    cst.condition,
    count(cse.id) filter (where cse.sent_at is not null) as sent_count,
    count(cse.id) filter (where cse.replied_at is not null) as replied_count,
    count(cse.id) filter (where cse.opted_out_at is not null) as opt_outs,
    cst.media
from public.campaign_steps cst
left join public.campaign_step_events cse on cse.step_id = cst.id
group by cst.id;

insert into storage.buckets (id, name, public)
values ('customer_images', 'customer_images', true)
on conflict (id) do update set public = true;

drop policy if exists customer_images_authenticated_read on storage.objects;
create policy customer_images_authenticated_read
    on storage.objects
    for select
    to authenticated
    using (
        bucket_id = 'customer_images'
        and (storage.foldername(name))[1] = (
            select businesses.business_id::text
            from public.businesses
            where businesses.user_id = auth.uid()
        )
    );

drop policy if exists customer_images_authenticated_insert on storage.objects;
create policy customer_images_authenticated_insert
    on storage.objects
    for insert
    to authenticated
    with check (
        bucket_id = 'customer_images'
        and (storage.foldername(name))[1] = (
            select businesses.business_id::text
            from public.businesses
            where businesses.user_id = auth.uid()
        )
    );

drop policy if exists customer_images_authenticated_update on storage.objects;
create policy customer_images_authenticated_update
    on storage.objects
    for update
    to authenticated
    using (
        bucket_id = 'customer_images'
        and (storage.foldername(name))[1] = (
            select businesses.business_id::text
            from public.businesses
            where businesses.user_id = auth.uid()
        )
    )
    with check (
        bucket_id = 'customer_images'
        and (storage.foldername(name))[1] = (
            select businesses.business_id::text
            from public.businesses
            where businesses.user_id = auth.uid()
        )
    );