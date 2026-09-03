create table if not exists public.whatsapp_connections (
    business_id text primary key references public.businesses(business_id) on delete cascade,
    evolution_instance_id text not null,
    status text not null default 'not_configured',
    qr_code text,
    pairing_code text,
    phone_number text,
    last_error text,
    connected_at timestamptz,
    disconnected_at timestamptz,
    raw_payload jsonb,
    updated_at timestamptz not null default now()
);

create unique index if not exists whatsapp_connections_instance_idx
    on public.whatsapp_connections(evolution_instance_id);