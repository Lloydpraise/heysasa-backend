-- Landing-page waitlist signups. Fields match the modal exactly: name,
-- business, industry, phone (unique, strictly validated server-side —
-- see src/utils/phone.js), optional website. utm_*/fbclid/ref_code are
-- captured silently from the URL and referral links, never shown as
-- form fields. status/notes exist now so the nurture and admin work
-- planned for this list has somewhere to live without another migration.
create table if not exists public.waitlist_leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null,
  business_name text not null,
  industry text not null,
  phone text not null unique,
  website text,
  ref_code text not null unique,
  referred_by text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  fbclid text,
  status text not null default 'new'
    check (status in ('new','welcomed','nurturing','conversation','demo_done','trial','paid','lost','opted_out')),
  notes text
);

create index if not exists waitlist_leads_status_idx on public.waitlist_leads (status, created_at desc);

-- Written and read only by the backend's service-role key — the browser
-- never talks to Supabase directly for this table.
alter table public.waitlist_leads enable row level security;
