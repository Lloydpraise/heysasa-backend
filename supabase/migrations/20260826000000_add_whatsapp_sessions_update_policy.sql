alter table public.whatsapp_sessions enable row level security;

 drop policy if exists whatsapp_sessions_update_own_business on public.whatsapp_sessions;

create policy whatsapp_sessions_update_own_business
    on public.whatsapp_sessions
    for update
    to authenticated
    using (
        exists (
            select 1
            from public.businesses
            where businesses.business_id = whatsapp_sessions.business_id
              and businesses.owner_user_id = auth.uid()
        )
    )
    with check (
        exists (
            select 1
            from public.businesses
            where businesses.business_id = whatsapp_sessions.business_id
              and businesses.owner_user_id = auth.uid()
        )
    );
