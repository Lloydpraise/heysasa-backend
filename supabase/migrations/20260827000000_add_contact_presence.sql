alter table public.contacts
    add column if not exists presence_status text,
    add column if not exists presence_updated_at timestamptz;