-- Accounts, part 1 of 4: the account model.
-- A business owns accounts; one account = one WhatsApp number, locked to that number. See ACCOUNTS.md.
-- Safe to run while the old backend is live: everything here is new, or a nullable column with a trigger that fills it.

-- ─── Tables ──────────────────────────────────────────────────────────────────────────────────────────

create table if not exists public.accounts (
  id                  uuid primary key default gen_random_uuid(),
  business_id         text not null references public.businesses(business_id) on delete cascade,
  label               text,
  phone_number        text,            -- digits only; set the first time the number connects, then locked
  phone_locked_at     timestamptz,
  status              text not null default 'pending'
                        check (status in ('pending', 'connected', 'disconnected', 'suspended', 'closed')),
  instance_name       text,            -- the Evolution instance serving this account now
  connected_at        timestamptz,
  disconnected_at     timestamptz,
  billing_mode        text not null default 'business' check (billing_mode in ('business', 'separate')),
  billing_contact     jsonb not null default '{}'::jsonb,
  subscription_status text not null default 'trial'
                        check (subscription_status in ('trial', 'active', 'past_due', 'suspended', 'cancelled')),
  monthly_price_kes   numeric not null default 10000,
  paid_until          timestamptz,
  settings            jsonb not null default '{}'::jsonb,   -- per-account overrides of the businesses settings columns
  connect_error       jsonb,           -- last refused connection, e.g. {code:'phone_mismatch', expected, actual, at}
  is_primary          boolean not null default false,
  created_by          uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists accounts_business_idx on public.accounts (business_id);
create unique index if not exists accounts_phone_key on public.accounts (phone_number)
  where phone_number is not null and status <> 'closed';
create unique index if not exists accounts_instance_key on public.accounts (instance_name) where instance_name is not null;
create unique index if not exists accounts_one_primary on public.accounts (business_id) where is_primary;

create table if not exists public.business_users (
  id           uuid primary key default gen_random_uuid(),
  business_id  text not null references public.businesses(business_id) on delete cascade,
  user_id      uuid references auth.users(id) on delete cascade,
  email        text,
  display_name text,
  role         text not null default 'member' check (role in ('admin', 'member')),
  status       text not null default 'invited' check (status in ('invited', 'active', 'removed')),
  invite_token text unique,
  invited_by   uuid,
  created_at   timestamptz not null default now(),
  accepted_at  timestamptz,
  updated_at   timestamptz not null default now()
);
create unique index if not exists business_users_one_per_user on public.business_users (business_id, user_id)
  where user_id is not null and status <> 'removed';
create index if not exists business_users_user_idx on public.business_users (user_id);

create table if not exists public.business_user_accounts (
  business_user_id uuid not null references public.business_users(id) on delete cascade,
  account_id       uuid not null references public.accounts(id) on delete cascade,
  created_at       timestamptz not null default now(),
  primary key (business_user_id, account_id)
);
create index if not exists business_user_accounts_account_idx on public.business_user_accounts (account_id);

-- AI credit wallet for accounts on separate billing. Business-billed accounts keep using business_balances.
create table if not exists public.account_balances (
  account_id         uuid primary key references public.accounts(id) on delete cascade,
  business_id        text not null references public.businesses(business_id) on delete cascade,
  balance_usd        numeric not null default 0,
  lifetime_spent_usd numeric not null default 0,
  updated_at         timestamptz not null default now()
);

-- The KES 10,000 monthly access fee, one row per account per month.
create table if not exists public.account_invoices (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null references public.accounts(id) on delete cascade,
  business_id  text not null references public.businesses(business_id) on delete cascade,
  bill_to      text not null default 'business' check (bill_to in ('business', 'account')),
  period_start date not null,
  period_end   date not null,
  amount_kes   numeric not null,
  status       text not null default 'due' check (status in ('due', 'paid', 'void')),
  due_at       timestamptz not null default now(),
  paid_at      timestamptz,
  reference    text,
  note         text,
  created_at   timestamptz not null default now(),
  unique (account_id, period_start)
);
create index if not exists account_invoices_business_idx on public.account_invoices (business_id, period_start desc);

insert into public.billing_prices (key, value, unit, label, description, sort)
values ('account_monthly_kes', 10000, 'KES', 'WhatsApp account access fee (monthly)', 'Charged per WhatsApp number (HeySasa account) each month, separate from AI credit.', 40),
       ('account_grace_days', 7, 'days', 'Access fee grace period', 'Days an unpaid access invoice may run before the account is suspended (when enforcement is on).', 41),
       ('enforce_account_subscription', 0, 'flag', 'Enforce access fee', '1 = suspend accounts whose access invoice is past the grace period. 0 = only mark them past due.', 42)
on conflict (key) do nothing;

-- ─── Who may see what ────────────────────────────────────────────────────────────────────────────────

-- The account the dashboard has selected, sent as the x-account-id request header. Null outside PostgREST.
create or replace function public.request_account_id()
returns uuid language plpgsql stable set search_path = '' as $$
declare v text;
begin
  v := nullif(current_setting('request.headers', true), '')::json ->> 'x-account-id';
  if v is null or v !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return null; end if;
  return v::uuid;
exception when others then return null;
end $$;

-- Businesses the signed-in user may open: owned, billed to one they own, or joined as a team member.
create or replace function public.my_business_ids()
returns setof text language sql stable security definer set search_path = '' as $$
  select b.business_id from public.businesses b where b.user_id = (select auth.uid())
  union
  select b.billing_business_id from public.businesses b
   where b.user_id = (select auth.uid()) and b.billing_business_id is not null
  union
  select bu.business_id from public.business_users bu
   where bu.user_id = (select auth.uid()) and bu.status = 'active'
$$;

-- Businesses where the signed-in user sees every account, the business-wide view, billing and the team.
create or replace function public.my_admin_business_ids()
returns setof text language sql stable security definer set search_path = '' as $$
  select b.business_id from public.businesses b where b.user_id = (select auth.uid())
  union
  select bu.business_id from public.business_users bu
   where bu.user_id = (select auth.uid()) and bu.status = 'active' and bu.role = 'admin'
$$;

-- Accounts the signed-in user may open: all accounts of businesses they administer, plus accounts assigned to them.
create or replace function public.my_account_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select a.id from public.accounts a where a.business_id in (select public.my_admin_business_ids())
  union
  select bua.account_id
    from public.business_user_accounts bua
    join public.business_users bu on bu.id = bua.business_user_id
   where bu.user_id = (select auth.uid()) and bu.status = 'active'
$$;

-- For security definer functions: the backend (service role) and the SQL editor (no user) pass; a signed-in
-- user passes for businesses / accounts they may open.
create or replace function public.can_access_business(p_business_id text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select auth.role()), '') = 'service_role' or (select auth.uid()) is null
      or p_business_id in (select public.my_business_ids())
$$;

create or replace function public.can_access_account(p_account_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select auth.role()), '') = 'service_role' or (select auth.uid()) is null
      or p_account_id in (select public.my_account_ids())
$$;

create or replace function public.is_business_admin(p_business_id text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select auth.role()), '') = 'service_role' or (select auth.uid()) is null
      or p_business_id in (select public.my_admin_business_ids())
$$;

-- The business's account when it has exactly one (closed ones don't count); otherwise null.
create or replace function public.business_only_account(p_business_id text)
returns uuid language sql stable security definer set search_path = '' as $$
  select case when count(*) = 1 then (array_agg(a.id))[1] end
    from public.accounts a where a.business_id = p_business_id and a.status <> 'closed'
$$;

-- An account's effective settings: the business columns, overridden by accounts.settings.
create or replace function public.account_settings(p_account_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select to_jsonb(b) || coalesce(a.settings, '{}'::jsonb)
         || jsonb_build_object('account_id', a.id, 'account_label', a.label, 'account_phone', a.phone_number,
                               'account_status', a.status, 'instance_name', a.instance_name,
                               'billing_mode', a.billing_mode, 'subscription_status', a.subscription_status)
    from public.accounts a join public.businesses b on b.business_id = a.business_id
   where a.id = p_account_id
$$;

revoke execute on function public.my_business_ids(), public.my_admin_business_ids(), public.my_account_ids(),
  public.can_access_business(text), public.can_access_account(uuid), public.is_business_admin(text),
  public.business_only_account(text), public.account_settings(uuid) from anon, public;
grant execute on function public.my_business_ids(), public.my_admin_business_ids(), public.my_account_ids(),
  public.can_access_business(text), public.can_access_account(uuid), public.is_business_admin(text),
  public.business_only_account(text), public.account_settings(uuid) to authenticated, service_role;
grant execute on function public.request_account_id() to authenticated, service_role;

-- ─── Locked number ───────────────────────────────────────────────────────────────────────────────────

create or replace function public.accounts_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  if new.phone_number is not null then
    new.phone_number := regexp_replace(new.phone_number, '\D', '', 'g');
    if new.phone_number = '' then new.phone_number := null; end if;
  end if;
  if tg_op = 'UPDATE' then
    if old.phone_number is not null and new.phone_number is distinct from old.phone_number
       and coalesce(current_setting('heysasa.allow_phone_change', true), '') <> 'on' then
      raise exception 'phone_locked: account % is locked to %', old.id, old.phone_number using errcode = '23514';
    end if;
    if new.business_id is distinct from old.business_id then
      raise exception 'account business cannot change' using errcode = '23514';
    end if;
  end if;
  if new.phone_number is not null and new.phone_locked_at is null then new.phone_locked_at := now(); end if;
  if new.status = 'connected' and (tg_op = 'INSERT' or old.status is distinct from 'connected') then
    new.connected_at := now();
  elsif new.status = 'disconnected' and tg_op = 'UPDATE' and old.status = 'connected' then
    new.disconnected_at := now();
  end if;
  return new;
end $$;

drop trigger if exists trg_accounts_guard on public.accounts;
create trigger trg_accounts_guard before insert or update on public.accounts
  for each row execute function public.accounts_guard();

-- ─── account_id on every WhatsApp-scoped table ──────────────────────────────────────────────────────

do $$
declare t text;
begin
  foreach t in array array[
    -- strict: always one account
    'contacts','conversations','messages','customer_profiles','customer_notes','contact_activity_patterns',
    'conversation_enrichment','sentiment_snapshots','lead_ai_state','lead_calls','lead_meeting_reminders',
    'lead_meetings','lead_stage_changes','lead_stage_requests','lead_tasks','lead_timeline',
    'follow_up_queue','follow_up_send_events','follow_up_outcomes','followup_ai_turns','followup_billing_events',
    'followup_nudge_log','followup_ai_skills','campaigns','campaign_enrollments','lists','segmentation_rules',
    'auto_campaign_configs','ad_attributions','ad_playbooks','ad_playbook_items','chat_flows','chat_ai_skills',
    'chat_ai_turns','chat_ai_outbox','chat_ai_daily_chats','chat_test_feedback','handoff_events',
    'product_mentions','conversions','daily_send_counters','enrichment_runs','whatsapp_sessions','business_setup',
    -- may be business-level (account_id null = the business catalog / default / not tied to one number)
    'persona_packs','products','knowledge_sources','knowledge_chunks','followup_materials','chat_ai_tools',
    'waitlist_leads','ai_usage_log','balance_transactions','system_logs','ba_conversations','ba_actions'
  ] loop
    execute format('alter table public.%I add column if not exists account_id uuid references public.accounts(id)', t);
    if t <> 'system_logs' then
      execute format('create index if not exists %I on public.%I (account_id)', t || '_account_idx', t);
    end if;
  end loop;
end $$;

-- Fills account_id on insert when the writer did not: parent row first, then the dashboard's selected account,
-- then the business's only account. TG_ARGV[0] = 'strict' refuses a row it cannot place when the business has
-- several accounts; other tables then keep it business-level (null).
create or replace function public.fill_account_id()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  j jsonb := to_jsonb(new);
  v uuid;
  v_biz text := j ->> 'business_id';
  v_owner text;
begin
  if new.account_id is not null then
    if v_biz is not null then
      select a.business_id into v_owner from accounts a where a.id = new.account_id;
      if v_owner is distinct from v_biz then
        raise exception 'account % does not belong to business %', new.account_id, v_biz using errcode = '23503';
      end if;
    end if;
    return new;
  end if;

  if j ->> 'contact_id' is not null then
    select c.account_id into v from contacts c where c.id = (j ->> 'contact_id')::bigint;
  end if;
  if v is null and j ->> 'lead_id' is not null then
    select c.account_id into v from contacts c where c.id = (j ->> 'lead_id')::bigint;
  end if;
  if v is null and j ->> 'campaign_id' is not null then
    select c.account_id into v from campaigns c where c.id = (j ->> 'campaign_id')::uuid;
  end if;
  if v is null and j ->> 'enrollment_id' is not null then
    select e.account_id into v from campaign_enrollments e where e.id = (j ->> 'enrollment_id')::uuid;
  end if;
  if v is null and j ->> 'conversation_id' is not null and tg_table_name not in ('ba_actions', 'ba_conversations') then
    select c.account_id into v from conversations c where c.id = j ->> 'conversation_id';
  end if;
  if v is null and j ->> 'list_id' is not null then
    select l.account_id into v from lists l where l.id = (j ->> 'list_id')::uuid;
  end if;
  if v is null and j ->> 'playbook_id' is not null then
    select p.account_id into v from ad_playbooks p where p.id = (j ->> 'playbook_id')::uuid;
  end if;
  if v is null and tg_table_name = 'knowledge_chunks' and j ->> 'source_id' is not null then
    select s.account_id into v from knowledge_sources s where s.id = (j ->> 'source_id')::uuid;
    if v is null then return new; end if;   -- a chunk of a business-level source stays business-level
  end if;

  if v is null and v_biz is not null then
    v := request_account_id();
    if v is not null and not exists (select 1 from accounts a where a.id = v and a.business_id = v_biz) then v := null; end if;
  end if;

  -- The business catalog (hand-added products, knowledge files, follow-up materials, chat tools) is shared by every
  -- account unless the dashboard was looking at one account when it was added.
  if v is null and (tg_table_name in ('knowledge_sources', 'followup_materials', 'chat_ai_tools')
                    or (tg_table_name = 'products' and coalesce(j ->> 'source', 'manual') not in ('chat', 'image', 'chat_image'))) then
    return new;
  end if;

  if v is null and v_biz is not null then
    v := business_only_account(v_biz);
    if v is null and tg_nargs > 0 and tg_argv[0] = 'strict'
       and exists (select 1 from accounts a where a.business_id = v_biz and a.status <> 'closed') then
      raise exception 'account_id_required: % for business % has several WhatsApp accounts', tg_table_name, v_biz
        using errcode = '23502';
    end if;
  end if;

  new.account_id := v;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'contacts','conversations','messages','customer_profiles','customer_notes','contact_activity_patterns',
    'conversation_enrichment','sentiment_snapshots','lead_ai_state','lead_calls','lead_meeting_reminders',
    'lead_meetings','lead_stage_changes','lead_stage_requests','lead_tasks','lead_timeline',
    'follow_up_queue','follow_up_send_events','follow_up_outcomes','followup_ai_turns','followup_billing_events',
    'followup_nudge_log','followup_ai_skills','campaigns','campaign_enrollments','lists','segmentation_rules',
    'auto_campaign_configs','ad_attributions','ad_playbooks','ad_playbook_items','chat_flows','chat_ai_skills',
    'chat_ai_turns','chat_ai_outbox','chat_ai_daily_chats','chat_test_feedback','handoff_events',
    'product_mentions','conversions','daily_send_counters','enrichment_runs','whatsapp_sessions','business_setup'
  ] loop
    execute format('drop trigger if exists trg_fill_account_id on public.%I', t);
    execute format('create trigger trg_fill_account_id before insert on public.%I for each row execute function public.fill_account_id(%L)', t, 'strict');
  end loop;
  foreach t in array array[
    'persona_packs','products','knowledge_sources','knowledge_chunks','followup_materials','chat_ai_tools',
    'waitlist_leads','ai_usage_log','balance_transactions','system_logs','ba_conversations','ba_actions'
  ] loop
    execute format('drop trigger if exists trg_fill_account_id on public.%I', t);
    execute format('create trigger trg_fill_account_id before insert on public.%I for each row execute function public.fill_account_id()', t);
  end loop;
end $$;

-- ─── One account per business that already uses WhatsApp ────────────────────────────────────────────

with latest_session as (
  select distinct on (s.business_id) s.business_id, s.instance_name, s.status, s.phone_number
    from public.whatsapp_sessions s
   order by s.business_id, (s.status = 'connected') desc, s.updated_at desc nulls last
), latest_send as (
  select distinct on (e.business_id) e.business_id, e.instance_name
    from public.follow_up_send_events e where e.instance_name is not null
   order by e.business_id, e.created_at desc
), candidates as (
  select b.business_id, b.name,
         coalesce(ls.instance_name, se.instance_name, nullif(b.evolution_instance_id, '')) as instance_name,
         ls.status as session_status,
         case when regexp_replace(coalesce(ls.phone_number, ''), '\D', '', 'g') ~ '^\d{8,15}$'
              then regexp_replace(ls.phone_number, '\D', '', 'g') end as phone
    from public.businesses b
    left join latest_session ls on ls.business_id = b.business_id
    left join latest_send se on se.business_id = b.business_id
   where ls.business_id is not null
      or exists (select 1 from public.contacts c where c.business_id = b.business_id)
)
insert into public.accounts (business_id, label, phone_number, status, instance_name, is_primary,
                             subscription_status, paid_until)
select c.business_id, coalesce(nullif(c.name, ''), c.business_id), c.phone,
       case when c.session_status = 'connected' then 'connected' when c.instance_name is null then 'pending' else 'disconnected' end,
       c.instance_name, true, 'trial', '2026-11-24T00:00:00+03'::timestamptz
  from candidates c
 where not exists (select 1 from public.accounts a where a.business_id = c.business_id);

update public.whatsapp_sessions s set account_id = a.id
  from public.accounts a where a.business_id = s.business_id and a.is_primary and s.account_id is null;

-- ─── Keep accounts in step with WhatsApp connections ───────────────────────────────────────────────

-- A connection for a business that has no account yet opens one (the old backend never creates accounts).
create or replace function public.whatsapp_sessions_ensure_account()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.account_id is null and new.business_id is not null
     and not exists (select 1 from accounts a where a.business_id = new.business_id and a.status <> 'closed') then
    -- A business's first number, connected through the existing flow, starts on a 30-day trial.
    insert into accounts (business_id, label, status, instance_name, is_primary, subscription_status, paid_until)
    select b.business_id, coalesce(nullif(b.name, ''), b.business_id), 'pending', new.instance_name,
           not exists (select 1 from accounts x where x.business_id = b.business_id and x.is_primary),
           'trial', now() + interval '30 days'
      from businesses b where b.business_id = new.business_id
    returning id into new.account_id;
  end if;
  return new;
end $$;

drop trigger if exists trg_ensure_account on public.whatsapp_sessions;
create trigger trg_ensure_account before insert on public.whatsapp_sessions
  for each row execute function public.whatsapp_sessions_ensure_account();

-- Session state -> account state. A deleted or dropped session leaves the account in place, disconnected.
-- The phone number is only ever filled in here, never changed (a mismatch is the backend's job to refuse).
create or replace function public.whatsapp_sessions_sync_account()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  r record := coalesce(new, old);
  v_phone text;
begin
  if r.account_id is null then return null; end if;
  if tg_op = 'DELETE' then
    update accounts set status = 'disconnected'
     where id = old.account_id and status = 'connected'
       and not exists (select 1 from whatsapp_sessions s where s.account_id = old.account_id and s.status = 'connected');
    return null;
  end if;
  v_phone := regexp_replace(coalesce(new.phone_number, ''), '\D', '', 'g');
  if v_phone !~ '^\d{8,15}$' then v_phone := null; end if;
  if new.status = 'connected' then
    update accounts a
       set status = case when a.status in ('suspended', 'closed') then a.status else 'connected' end,
           instance_name = coalesce(new.instance_name, a.instance_name),
           phone_number = coalesce(a.phone_number, v_phone)
     where a.id = new.account_id;
  elsif new.status in ('disconnected', 'closed') then
    update accounts set status = 'disconnected'
     where id = new.account_id and status = 'connected'
       and not exists (select 1 from whatsapp_sessions s where s.account_id = new.account_id and s.status = 'connected' and s.id <> new.id);
  end if;
  return null;
end $$;

drop trigger if exists trg_sync_account on public.whatsapp_sessions;
create trigger trg_sync_account after insert or update or delete on public.whatsapp_sessions
  for each row execute function public.whatsapp_sessions_sync_account();

-- A new instance for an account takes over its campaigns and upcoming follow-ups. Follow-ups more than a day
-- overdue are left alone, so a reconnect never fires a backlog of stale messages.
create or replace function public.accounts_move_instance()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.instance_name is not null and old.instance_name is not null and new.instance_name <> old.instance_name then
    update campaigns set whatsapp_instance_name = new.instance_name,
                         whatsapp_instances = array[new.instance_name]
     where account_id = new.id and status not in ('completed', 'archived', 'failed');
    update auto_campaign_configs set whatsapp_instance_name = new.instance_name
     where account_id = new.id and whatsapp_instance_name is not null;
    update follow_up_queue set assigned_instance_name = new.instance_name, assigned_instance = new.instance_name
     where account_id = new.id
       and status not in ('sent', 'failed', 'cancelled', 'skipped', 'replied', 'delivered', 'read')
       and coalesce(scheduled_at, now()) >= now() - interval '24 hours';
  end if;
  return null;
end $$;

drop trigger if exists trg_accounts_move_instance on public.accounts;
create trigger trg_accounts_move_instance after update of instance_name on public.accounts
  for each row execute function public.accounts_move_instance();

revoke execute on function public.fill_account_id(), public.accounts_guard(), public.whatsapp_sessions_ensure_account(),
  public.whatsapp_sessions_sync_account(), public.accounts_move_instance() from anon, public, authenticated;
