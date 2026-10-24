-- Accounts, part 3 of 4: per-account uniqueness, row security, account-aware database functions, billing.
-- Still compatible with the old backend: the business-level unique keys stay until part 4, and every function
-- keeps its old arguments (the account is an extra, optional one).

-- ─── Per-account unique keys (the business-level ones are dropped in part 4) ────────────────────────

create unique index if not exists contacts_account_social_key on public.contacts (account_id, social_platform, social_id);
create unique index if not exists conversations_account_contact_key on public.conversations (account_id, contact_id);
create unique index if not exists ad_attributions_account_ad_key on public.ad_attributions (account_id, ad_id);
create unique index if not exists ad_playbooks_account_ad_key on public.ad_playbooks (account_id, ad_id);
create unique index if not exists auto_campaign_configs_account_rule_key on public.auto_campaign_configs (account_id, rule_id);
create unique index if not exists chat_ai_skills_account_key_key on public.chat_ai_skills (account_id, key);
create unique index if not exists followup_ai_skills_account_key_key on public.followup_ai_skills (account_id, key);
create unique index if not exists daily_send_counters_account_date_key on public.daily_send_counters (account_id, send_date);
create unique index if not exists lists_account_rule_key on public.lists (account_id, rule_id);
create unique index if not exists lists_account_ad_key on public.lists (account_id, ad_id) where ad_id is not null;
create unique index if not exists segmentation_rules_account_rule_key on public.segmentation_rules (account_id, rule_id);
create unique index if not exists persona_packs_account_version_key on public.persona_packs (account_id, version);
create unique index if not exists persona_packs_one_active_per_account on public.persona_packs (account_id)
  where is_active and account_id is not null;
create unique index if not exists campaigns_one_live_auto_per_account_rule on public.campaigns (account_id, rule_id)
  where kind = 'auto' and status in ('active', 'paused');
create unique index if not exists business_setup_account_key on public.business_setup (account_id);
create unique index if not exists chat_ai_daily_chats_account_key on public.chat_ai_daily_chats (account_id, day, conversation_id);

-- ─── Row security ────────────────────────────────────────────────────────────────────────────────────

-- Owner-only policies ("businesses.user_id = auth.uid()") become "any business the user may open", so team
-- members pass. my_business_ids() already covers owners, billing businesses and team members.
do $$
declare
  r record; q text; w text;
  pat constant text := '\(?(\w+)\.user_id = (\( SELECT auth\.uid\(\) AS uid\)|auth\.uid\(\))\)?';
  rep constant text := '(\1.business_id IN ( SELECT public.my_business_ids() AS my_business_ids))';
begin
  for r in
    select * from pg_policies
     where schemaname = 'public'
       and tablename = any (array[
         'auto_campaign_configs','ba_action_prefs','ba_actions','ba_conversations','ba_messages','ba_notes',
         'ba_preferences','chat_ai_skills','chat_ai_turns','chat_flows','contact_whatsapp_sessions',
         'customer_profiles','follow_up_queue','follow_up_send_events','handoff_events','knowledge_sources',
         'daily_send_counters_by_instance','list_members','lists','persona_packs','product_mentions','products','segmentation_rules','whatsapp_sessions'])
       and (coalesce(qual, '') || coalesce(with_check, '')) ~ 'user_id = '
  loop
    q := regexp_replace(r.qual, pat, rep, 'g');
    w := regexp_replace(r.with_check, pat, rep, 'g');
    if r.qual is not null and r.with_check is not null then
      execute format('alter policy %I on public.%I using (%s) with check (%s)', r.policyname, r.tablename, q, w);
    elsif r.qual is not null then
      execute format('alter policy %I on public.%I using (%s)', r.policyname, r.tablename, q);
    else
      execute format('alter policy %I on public.%I with check (%s)', r.policyname, r.tablename, w);
    end if;
  end loop;
end $$;

-- Account scope, on top of whatever business policy a table has: a user sees rows of accounts they may open,
-- and only the selected account's rows (plus business-level ones) when the dashboard sends x-account-id.
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
    'product_mentions','conversions','daily_send_counters','enrichment_runs','whatsapp_sessions','business_setup',
    'persona_packs','products','knowledge_sources','knowledge_chunks','followup_materials','chat_ai_tools',
    'waitlist_leads','ai_usage_log','balance_transactions','system_logs','ba_conversations','ba_actions'
  ] loop
    if (select c.relrowsecurity from pg_class c where c.oid = ('public.' || t)::regclass) then
      execute format('drop policy if exists account_scope on public.%I', t);
      execute format($p$
        create policy account_scope on public.%I as restrictive for all to authenticated
        using (account_id is null or (account_id in (select public.my_account_ids())
               and ((select public.request_account_id()) is null or account_id = (select public.request_account_id()))))
        with check (account_id is null or account_id in (select public.my_account_ids()))$p$, t);
    end if;
  end loop;
end $$;

-- Team members read the business they belong to (owners keep their own policies for changing it).
drop policy if exists team_select on public.businesses;
create policy team_select on public.businesses for select to authenticated
  using (business_id in (select public.my_business_ids()));

-- list_members has no account of its own; it follows its list.
drop policy if exists account_scope on public.list_members;
create policy account_scope on public.list_members as restrictive for all to authenticated
  using (exists (select 1 from public.lists l where l.id = list_members.list_id
                  and (l.account_id is null or l.account_id in (select public.my_account_ids()))))
  with check (exists (select 1 from public.lists l where l.id = list_members.list_id
                  and (l.account_id is null or l.account_id in (select public.my_account_ids()))));

-- New tables: read-only for signed-in users. Every change goes through the backend (service role), so nobody
-- can mark their own invoice paid or unlock a number from the browser.
alter table public.accounts enable row level security;
alter table public.business_users enable row level security;
alter table public.business_user_accounts enable row level security;
alter table public.account_balances enable row level security;
alter table public.account_invoices enable row level security;

drop policy if exists accounts_read on public.accounts;
create policy accounts_read on public.accounts for select to authenticated
  using (id in (select public.my_account_ids()));

drop policy if exists business_users_read on public.business_users;
create policy business_users_read on public.business_users for select to authenticated
  using (user_id = (select auth.uid()) or business_id in (select public.my_admin_business_ids()));

drop policy if exists business_user_accounts_read on public.business_user_accounts;
create policy business_user_accounts_read on public.business_user_accounts for select to authenticated
  using (exists (select 1 from public.business_users bu where bu.id = business_user_accounts.business_user_id
                  and (bu.user_id = (select auth.uid()) or bu.business_id in (select public.my_admin_business_ids()))));

drop policy if exists account_balances_read on public.account_balances;
create policy account_balances_read on public.account_balances for select to authenticated
  using (business_id in (select public.my_admin_business_ids()));

drop policy if exists account_invoices_read on public.account_invoices;
create policy account_invoices_read on public.account_invoices for select to authenticated
  using (business_id in (select public.my_admin_business_ids()));

revoke all on public.accounts, public.business_users, public.business_user_accounts,
  public.account_balances, public.account_invoices from anon, authenticated;
grant select on public.accounts, public.business_users, public.business_user_accounts,
  public.account_balances, public.account_invoices to authenticated;
grant all on public.accounts, public.business_users, public.business_user_accounts,
  public.account_balances, public.account_invoices to service_role;

-- ─── New accounts get their own defaults ─────────────────────────────────────────────────────────────

create or replace function public.seed_account_defaults(p_account_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_biz text;
begin
  select business_id into v_biz from accounts where id = p_account_id;
  if v_biz is null then return; end if;

  insert into chat_ai_skills (business_id, account_id, key, title, when_to_use, instructions, enabled, source_default_key)
  select v_biz, p_account_id, d.key, d.title, d.when_to_use, d.instructions, true, d.key
    from chat_ai_default_skills d
  on conflict do nothing;

  insert into segmentation_rules (business_id, account_id, rule_id, enabled, factors)
  select v_biz, p_account_id, r.rule_id, true, r.factors
  from (values
    ('hot_inquiries',   '{"window_days":7,"require_price_request":true}'::jsonb),
    ('unanswered',      '{"min_hours":2,"max_days":14}'::jsonb),
    ('price_hesitant',  '{"window_days":30}'::jsonb),
    ('cold_dormant',    '{"inactivity_days":14}'::jsonb),
    ('cart_abandoners', '{"no_purchase_window_days":3}'::jsonb),
    ('post_purchase',   '{"min_purchases":1}'::jsonb),
    ('low_intent',      '{"flag_source":"both"}'::jsonb)
  ) as r(rule_id, factors)
  on conflict do nothing;

  insert into lists (business_id, account_id, rule_id, type, name, archived)
  select v_biz, p_account_id, r.rule_id, 'auto', public.auto_list_name(r.rule_id), false
    from segmentation_rules r
   where r.account_id = p_account_id
  on conflict do nothing;
end $$;

-- A business's first account takes over whatever the business already has without an account (lists and
-- skills seeded earlier, contacts imported before WhatsApp was connected), so nothing is left orphaned.
create or replace function public.claim_business_rows(p_account_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_biz text; t text;
begin
  select business_id into v_biz from accounts where id = p_account_id;
  if v_biz is null or (select count(*) from accounts where business_id = v_biz) <> 1 then return; end if;
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
    if t in ('campaign_enrollments', 'conversation_enrichment') then
      continue;  -- no business_id column; filled below through their parent
    end if;
    execute format('update public.%I set account_id = $1 where business_id = $2 and account_id is null', t)
      using p_account_id, v_biz;
  end loop;
  update campaign_enrollments e set account_id = p_account_id
    from campaigns c where c.id = e.campaign_id and c.business_id = v_biz and e.account_id is null;
  update conversation_enrichment e set account_id = p_account_id
    from contacts c where c.id = e.contact_id and c.business_id = v_biz and e.account_id is null;
end $$;

create or replace function public.trg_seed_account_defaults()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.claim_business_rows(new.id);
  perform public.seed_account_defaults(new.id);
  return null;
end $$;

drop trigger if exists trg_seed_account_defaults on public.accounts;
create trigger trg_seed_account_defaults after insert on public.accounts
  for each row execute function public.trg_seed_account_defaults();

-- A business seeds nothing by itself any more; its accounts do.
drop trigger if exists trg_seed_auto_lists_on_business on public.businesses;
drop trigger if exists trg_seed_chat_ai_skills_on_business on public.businesses;

create or replace function public.seed_auto_lists(p_business_id text)
returns void language plpgsql security definer set search_path = public as $$
declare a record;
begin
  for a in select id from accounts where business_id = p_business_id and status <> 'closed' loop
    perform public.seed_account_defaults(a.id);
  end loop;
end $$;

-- ─── Auto lists and ad lists, per account ────────────────────────────────────────────────────────────

-- _auto_list_desired / _auto_list_signals still work per business; the sync keeps only the list's own account.
create or replace function public.sync_auto_lists(p_business_id text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r record; v_ids bigint[]; v_added int; v_removed int;
  t_lists int := 0; t_added int := 0; t_removed int := 0; t_errors int := 0; t_purged int := 0;
begin
  with del as (
    delete from public.lists
     where type = 'auto' and archived and disabled_at < now() - interval '30 days'
       and (p_business_id is null or business_id = p_business_id)
    returning 1) select count(*) into t_purged from del;

  for r in
    select l.id list_id, l.account_id, sr.business_id, sr.rule_id, sr.factors
    from public.segmentation_rules sr
    join public.lists l on l.business_id = sr.business_id and l.rule_id = sr.rule_id
                       and l.account_id is not distinct from sr.account_id
    where sr.enabled and l.type = 'auto' and not l.archived
      and sr.rule_id in ('hot_inquiries','unanswered','price_hesitant','cold_dormant','cart_abandoners','post_purchase','low_intent','waitinglist')
      and (p_business_id is null or sr.business_id = p_business_id)
  loop
    begin
      v_ids := array(
        select d.id from public._auto_list_desired(r.business_id, r.rule_id, r.factors) as d(id)
          join public.contacts c on c.id = d.id
         where c.account_id is not distinct from r.account_id);

      with ins as (
        insert into public.list_members (list_id, lead_id)
        select r.list_id, u from unnest(v_ids) u on conflict do nothing returning 1)
      select count(*) into v_added from ins;

      with del as (
        delete from public.list_members where list_id = r.list_id and lead_id <> all (v_ids) returning 1)
      select count(*) into v_removed from del;

      t_lists := t_lists + 1; t_added := t_added + v_added; t_removed := t_removed + v_removed;
    exception when others then
      t_errors := t_errors + 1;
      raise warning 'sync_auto_lists failed for % / % / %: %', r.business_id, r.account_id, r.rule_id, sqlerrm;
    end;
  end loop;

  return jsonb_build_object('lists', t_lists, 'added', t_added, 'removed', t_removed, 'purged', t_purged, 'errors', t_errors);
end $$;

create or replace function public.sync_ad_lists(p_business_id text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  t_created int := 0; t_added int := 0; t_removed int := 0; t_renamed int := 0;
begin
  if auth.role() is not null and auth.role() <> 'service_role' then
    if p_business_id is null or p_business_id not in (select public.my_business_ids()) then
      raise exception 'not allowed';
    end if;
  end if;

  with ads as (
    select c.business_id, c.account_id,
           coalesce(c.original_ad_id, c.ad_id) as ad_key,
           (array_agg(c.ad_headline order by c.ad_attributed_at desc nulls last) filter (where nullif(trim(c.ad_headline), '') is not null))[1] as headline
      from public.contacts c
     where c.is_ad_lead
       and coalesce(c.original_ad_id, c.ad_id) is not null
       and coalesce(c.lead_type, 'business') not in ('personal', 'vendor', 'staff', 'junk')
       and (p_business_id is null or c.business_id = p_business_id)
     group by 1, 2, 3
  ), ins as (
    insert into public.lists (business_id, account_id, name, type, ad_id)
    select a.business_id, a.account_id, coalesce(nullif(trim(a.headline), ''), 'Ad ' || right(a.ad_key, 6)), 'ad', a.ad_key
      from ads a
    on conflict do nothing
    returning 1
  )
  select count(*) into t_created from ins;

  with fixed as (
    update public.lists l
       set name = h.headline
      from (
        select c.account_id, coalesce(c.original_ad_id, c.ad_id) as ad_key,
               (array_agg(trim(c.ad_headline) order by c.ad_attributed_at desc nulls last) filter (where nullif(trim(c.ad_headline), '') is not null))[1] as headline
          from public.contacts c
         where c.is_ad_lead and coalesce(c.original_ad_id, c.ad_id) is not null
           and (p_business_id is null or c.business_id = p_business_id)
         group by 1, 2
      ) h
     where l.type = 'ad' and l.account_id is not distinct from h.account_id and l.ad_id = h.ad_key
       and h.headline is not null
       and l.name = 'Ad ' || right(l.ad_id, 6)
       and (p_business_id is null or l.business_id = p_business_id)
    returning 1
  )
  select count(*) into t_renamed from fixed;

  with ins as (
    insert into public.list_members (list_id, lead_id)
    select l.id, c.id
      from public.lists l
      join public.contacts c on c.business_id = l.business_id and c.account_id is not distinct from l.account_id
                            and c.is_ad_lead and coalesce(c.original_ad_id, c.ad_id) = l.ad_id
     where l.type = 'ad' and not l.archived
       and coalesce(c.lead_type, 'business') not in ('personal', 'vendor', 'staff', 'junk')
       and (p_business_id is null or l.business_id = p_business_id)
    on conflict do nothing
    returning 1
  )
  select count(*) into t_added from ins;

  with del as (
    delete from public.list_members lm
     using public.lists l
     where lm.list_id = l.id and l.type = 'ad' and not l.archived
       and (p_business_id is null or l.business_id = p_business_id)
       and not exists (
         select 1 from public.contacts c
          where c.id = lm.lead_id and c.business_id = l.business_id
            and c.account_id is not distinct from l.account_id and c.is_ad_lead
            and coalesce(c.original_ad_id, c.ad_id) = l.ad_id
            and coalesce(c.lead_type, 'business') not in ('personal', 'vendor', 'staff', 'junk')
       )
    returning 1
  )
  select count(*) into t_removed from del;

  return jsonb_build_object('created', t_created, 'renamed', t_renamed, 'added', t_added, 'removed', t_removed);
end
$$;

-- ─── Auto campaigns, per account ─────────────────────────────────────────────────────────────────────

-- The account a business-level call means: the one given, else the business's only account.
create or replace function public.resolve_account(p_business_id text, p_account_id uuid)
returns uuid language plpgsql stable security definer set search_path = public as $$
declare v uuid;
begin
  if p_account_id is not null then
    if not exists (select 1 from accounts where id = p_account_id and business_id = p_business_id) then
      raise exception 'account_not_in_business' using errcode = '42501';
    end if;
    return p_account_id;
  end if;
  v := business_only_account(p_business_id);
  if v is null then raise exception 'account_required' using errcode = '22023'; end if;
  return v;
end $$;

drop function if exists public.activate_auto_campaign(text, text);
create or replace function public.activate_auto_campaign(p_business_id text, p_rule_id text, p_account_id uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_account uuid; v_list uuid; v_cfg public.auto_campaign_configs%rowtype; v_def public.auto_campaign_defaults%rowtype;
  v_steps jsonb; v_mode text; v_instance text; v_campaign uuid; v_status text; v_acc public.accounts%rowtype;
begin
  v_account := public.resolve_account(p_business_id, p_account_id);
  if not public.can_access_account(v_account) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_acc from public.accounts where id = v_account;

  select id into v_list from public.lists
   where account_id = v_account and rule_id = p_rule_id and type = 'auto' and not archived;
  if v_list is null then raise exception 'auto_list_not_enabled'; end if;

  select * into v_cfg from public.auto_campaign_configs where account_id = v_account and rule_id = p_rule_id;
  select * into v_def from public.resolve_auto_campaign_default(p_business_id, p_rule_id);

  v_steps := coalesce(v_cfg.steps, v_def.steps);
  if v_steps is null or jsonb_array_length(v_steps) = 0 then raise exception 'no_steps_configured'; end if;
  if exists (select 1 from jsonb_array_elements(v_steps) s where btrim(coalesce(s->>'content','')) = '') then
    raise exception 'empty_step_content';
  end if;
  v_mode := coalesce(v_cfg.sequence_mode, v_def.sequence_mode, 'linear');

  -- The account is the number; its instance is the one to send from.
  v_instance := coalesce(nullif(btrim(v_acc.instance_name), ''), nullif(btrim(coalesce(v_cfg.whatsapp_instance_name, '')), ''));
  if v_instance is null then raise exception 'instance_required'; end if;
  if v_acc.status <> 'connected' then raise exception 'instance_not_connected'; end if;

  if v_cfg.campaign_id is not null then
    select status into v_status from public.campaigns where id = v_cfg.campaign_id;
    if v_status in ('active','paused') then
      update public.campaigns
         set status = 'active', failure_reason = null, failed_at = null,
             whatsapp_instance_name = v_instance,
             ai_rewrite_enabled = coalesce(v_cfg.ai_rewrite_enabled, true),
             auto_approve = coalesce(v_cfg.auto_approve, false),
             daily_cap = coalesce(v_cfg.daily_cap, 40),
             sequence_mode = v_mode
       where id = v_cfg.campaign_id;
      perform public._sync_auto_campaign_steps(v_cfg.campaign_id, v_steps);
      return v_cfg.campaign_id;
    end if;
  end if;

  insert into public.campaigns
    (business_id, account_id, list_id, name, sequence_mode, smart_timing, status, gateway_type, daily_cap,
     ai_rewrite_enabled, auto_approve, whatsapp_instance_name, kind, rule_id)
  values
    (p_business_id, v_account, v_list, coalesce(v_def.campaign_name, 'Auto campaign'), v_mode, true, 'active', 'Baileys',
     coalesce(v_cfg.daily_cap, 40), coalesce(v_cfg.ai_rewrite_enabled, true), coalesce(v_cfg.auto_approve, false),
     v_instance, 'auto', p_rule_id)
  returning id into v_campaign;

  insert into public.campaign_steps (campaign_id, step_number, content, delay_hours, condition)
  select v_campaign, t.ord::int, t.s->>'content', coalesce((t.s->>'delay_hours')::int, 0), null
    from jsonb_array_elements(v_steps) with ordinality as t(s, ord);

  insert into public.campaign_enrollments (campaign_id, lead_id, status, current_step, next_send_at)
  select v_campaign, lm.lead_id, 'pending', 0, now()
    from public.list_members lm
    join public.contacts c on c.id = lm.lead_id
   where lm.list_id = v_list
     and c.account_id = v_account
     and coalesce(c.do_not_contact, false) = false
     and not exists (
       select 1 from public.campaign_enrollments ce
         join public.campaigns cc on cc.id = ce.campaign_id
        where ce.lead_id = lm.lead_id
          and ce.status in ('pending','active','awaiting_opt_in')
          and cc.status = 'active' and ce.campaign_id <> v_campaign);

  update public.auto_campaign_configs
     set campaign_id = v_campaign, updated_at = now()
   where account_id = v_account and rule_id = p_rule_id;
  if not found then
    insert into public.auto_campaign_configs (business_id, account_id, rule_id, campaign_id, based_on_default_id, based_on_default_version)
    values (p_business_id, v_account, p_rule_id, v_campaign, v_def.id, v_def.version);
  end if;

  return v_campaign;
end;
$$;

drop function if exists public.apply_auto_campaign_config(text, text);
create or replace function public.apply_auto_campaign_config(p_business_id text, p_rule_id text, p_account_id uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_account uuid; v_cfg public.auto_campaign_configs%rowtype; v_def public.auto_campaign_defaults%rowtype; v_steps jsonb; v_status text;
begin
  v_account := public.resolve_account(p_business_id, p_account_id);
  if not public.can_access_account(v_account) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_cfg from public.auto_campaign_configs where account_id = v_account and rule_id = p_rule_id;
  if v_cfg.campaign_id is null then return; end if;
  select status into v_status from public.campaigns where id = v_cfg.campaign_id;
  if v_status not in ('active','paused') then return; end if;

  select * into v_def from public.resolve_auto_campaign_default(p_business_id, p_rule_id);
  v_steps := coalesce(v_cfg.steps, v_def.steps);
  if v_steps is null or jsonb_array_length(v_steps) = 0
     or exists (select 1 from jsonb_array_elements(v_steps) s where btrim(coalesce(s->>'content','')) = '') then
    raise exception 'invalid_steps';
  end if;

  update public.campaigns
     set ai_rewrite_enabled = v_cfg.ai_rewrite_enabled, auto_approve = v_cfg.auto_approve,
         daily_cap = coalesce(v_cfg.daily_cap, daily_cap),
         sequence_mode = coalesce(v_cfg.sequence_mode, v_def.sequence_mode, sequence_mode)
   where id = v_cfg.campaign_id;
  perform public._sync_auto_campaign_steps(v_cfg.campaign_id, v_steps);
end;
$$;

-- ─── Chat AI, per account ────────────────────────────────────────────────────────────────────────────

drop function if exists public.chat_ai_seed_skills(text);
create or replace function public.chat_ai_seed_skills(p_business_id text, p_account_id uuid default null)
returns integer language plpgsql security definer set search_path = public as $$
declare inserted integer; v_account uuid;
begin
  v_account := public.resolve_account(p_business_id, p_account_id);
  if not public.can_access_account(v_account) then raise exception 'not allowed'; end if;

  insert into chat_ai_skills (business_id, account_id, key, title, when_to_use, instructions, enabled, source_default_key)
  select p_business_id, v_account, d.key, d.title, d.when_to_use, d.instructions, true, d.key
  from chat_ai_default_skills d
  on conflict do nothing;

  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

drop function if exists public.chat_ai_reset_skill(text, text);
create or replace function public.chat_ai_reset_skill(p_business_id text, p_key text, p_account_id uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_account uuid;
begin
  v_account := public.resolve_account(p_business_id, p_account_id);
  if not public.can_access_account(v_account) then raise exception 'not allowed'; end if;

  update chat_ai_skills s
     set title = d.title, when_to_use = d.when_to_use, instructions = d.instructions, updated_at = now()
    from chat_ai_default_skills d
   where s.account_id = v_account and s.key = p_key and d.key = s.source_default_key;
end;
$$;

-- The daily new-chat cap counts per WhatsApp number.
create or replace function public.chat_ai_claim_slot(p_business_id text, p_conversation_id text, p_cap integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_tz text; v_day date; v_used integer; v_account uuid;
begin
  select account_id into v_account from conversations where id = p_conversation_id;
  select coalesce(nullif(timezone, ''), 'Africa/Nairobi') into v_tz from businesses where business_id = p_business_id;
  begin
    v_day := (now() at time zone coalesce(v_tz, 'Africa/Nairobi'))::date;
  exception when others then
    v_day := (now() at time zone 'Africa/Nairobi')::date;
  end;

  perform pg_advisory_xact_lock(hashtext('chat_ai_slot:' || coalesce(v_account::text, p_business_id)));

  if exists (select 1 from chat_ai_daily_chats where business_id = p_business_id and day = v_day and conversation_id = p_conversation_id) then
    select count(*) into v_used from chat_ai_daily_chats
     where business_id = p_business_id and day = v_day and account_id is not distinct from v_account;
    return jsonb_build_object('allowed', true, 'new_chat', false, 'used', v_used, 'cap', p_cap);
  end if;

  select count(*) into v_used from chat_ai_daily_chats
   where business_id = p_business_id and day = v_day and account_id is not distinct from v_account;
  if p_cap is null or v_used >= p_cap then
    return jsonb_build_object('allowed', false, 'new_chat', true, 'used', v_used, 'cap', coalesce(p_cap, 0));
  end if;

  insert into chat_ai_daily_chats (business_id, account_id, day, conversation_id)
  values (p_business_id, v_account, v_day, p_conversation_id);
  return jsonb_build_object('allowed', true, 'new_chat', true, 'used', v_used + 1, 'cap', p_cap);
end;
$$;

-- Daily send counters count per WhatsApp number.
create or replace function public.increment_daily_send_counter()
returns trigger language plpgsql as $$
begin
  if new.sent_at is not null and old.sent_at is null then
    update daily_send_counters d set sent_today = d.sent_today + 1
      from campaign_enrollments ce join campaigns c on c.id = ce.campaign_id
     where ce.id = new.enrollment_id and d.send_date = current_date
       and d.account_id is not distinct from c.account_id and d.business_id = c.business_id;
    if not found then
      insert into daily_send_counters (business_id, account_id, send_date, sent_today)
      select c.business_id, c.account_id, current_date, 1
        from campaign_enrollments ce join campaigns c on c.id = ce.campaign_id
       where ce.id = new.enrollment_id
      on conflict do nothing;
    end if;
  end if;
  return new;
end;
$$;

-- Knowledge: an account's own sources plus the business-level ones.
drop function if exists public.match_knowledge_chunks(text, vector, integer, double precision, text, uuid);
create or replace function public.match_knowledge_chunks(p_business_id text, p_embedding vector, p_count integer default 4,
  p_threshold double precision default 0.25, p_bot text default null, p_source_id uuid default null, p_account_id uuid default null)
returns table(chunk_id uuid, source_id uuid, title text, use_case text, file_type text, page integer, content text, similarity double precision)
language sql stable as $$
  select c.id, s.id, s.title, s.use_case, s.file_type, c.page, c.content, 1 - (c.embedding <=> p_embedding) as similarity
  from public.knowledge_chunks c
  join public.knowledge_sources s on s.id = c.source_id
  where c.business_id = p_business_id
    and (p_account_id is null or s.account_id is null or s.account_id = p_account_id)
    and s.status = 'ready'
    and s.is_active
    and c.embedding is not null
    and (p_bot is null or s.used_by in ('both', p_bot))
    and (p_source_id is null or s.id = p_source_id)
    and 1 - (c.embedding <=> p_embedding) > p_threshold
  order by c.embedding <=> p_embedding
  limit greatest(1, least(p_count, 12));
$$;

-- Copies products or knowledge files into an account ("import from business"): from the business catalog
-- (account_id null), or from another account of the same business when p_from_account is given.
drop function if exists public.copy_business_items_to_account(uuid, text, text[], uuid);
create or replace function public.copy_business_items_to_account(p_account_id uuid, p_kind text, p_ids text[] default null,
  p_from_account uuid default null)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_biz text; v_cols text; v_n integer := 0; r record; v_new uuid;
begin
  select business_id into v_biz from accounts where id = p_account_id;
  if v_biz is null then raise exception 'account_not_found'; end if;
  if not public.can_access_account(p_account_id) then raise exception 'not_authorized' using errcode = '42501'; end if;
  if p_from_account is not null then
    if p_from_account = p_account_id then raise exception 'same_account'; end if;
    if not exists (select 1 from accounts where id = p_from_account and business_id = v_biz)
       or not public.can_access_account(p_from_account) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
  end if;

  if p_kind = 'products' then
    -- Shop-sync ids are unique per product row, so the copy is a plain product of the account.
    select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into v_cols
      from information_schema.columns
     where table_schema = 'public' and table_name = 'products'
       and column_name not in ('id', 'account_id', 'shopify_product_id', 'telegram_id', 'shopify_variant_id');
    execute format(
      'insert into products (id, account_id, %1$s) select gen_random_uuid()::text, $1, %1$s from products
        where business_id = $2 and account_id is not distinct from $4 and ($3::text[] is null or id = any ($3))', v_cols)
      using p_account_id, v_biz, p_ids, p_from_account;
    get diagnostics v_n = row_count;
  elsif p_kind = 'knowledge' then
    for r in select id from knowledge_sources
              where business_id = v_biz and account_id is not distinct from p_from_account
                and (p_ids is null or id::text = any (p_ids)) loop
      select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into v_cols
        from information_schema.columns
       where table_schema = 'public' and table_name = 'knowledge_sources' and column_name not in ('id', 'account_id');
      execute format('insert into knowledge_sources (account_id, %1$s) select $1, %1$s from knowledge_sources where id = $2 returning id', v_cols)
        into v_new using p_account_id, r.id;
      select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into v_cols
        from information_schema.columns
       where table_schema = 'public' and table_name = 'knowledge_chunks' and column_name not in ('id', 'account_id', 'source_id');
      execute format('insert into knowledge_chunks (account_id, source_id, %1$s) select $1, $2, %1$s from knowledge_chunks where source_id = $3', v_cols)
        using p_account_id, v_new, r.id;
      v_n := v_n + 1;
    end loop;
  else
    raise exception 'unknown kind %', p_kind;
  end if;
  return v_n;
end $$;

-- A reply counts for a campaign of the same WhatsApp account only (the same person on another of the business's
-- numbers is another contact, in another account's campaigns).
create or replace function public.attribute_campaign_reply(p_business_id text, p_contact_id bigint,
  p_at timestamp with time zone default now(), p_window interval default '7 days'::interval)
returns table(step_event_id uuid, enrollment_id uuid, lead_id bigint, campaign_id uuid)
language plpgsql security definer set search_path to 'public' as $function$
declare
    v_key text;
    v_account uuid;
    v_event record;
begin
    select k.phone_key, k.account_id into v_key, v_account
    from public.contacts k
    where k.id = p_contact_id and k.business_id = p_business_id;

    select cse.id as sid, cse.enrollment_id as eid, ce.lead_id as lid, ce.campaign_id as cid,
           cse.replied_at as replied_at, cse.message_id as mid
    into v_event
    from public.campaign_step_events cse
    join public.campaign_enrollments ce on ce.id = cse.enrollment_id
    join public.campaigns camp on camp.id = ce.campaign_id and camp.business_id = p_business_id
                              and (v_account is null or camp.account_id is null or camp.account_id = v_account)
    where cse.sent_at is not null
      and cse.sent_at <= p_at
      and cse.sent_at > p_at - p_window
      and (
          ce.lead_id = p_contact_id
          or (v_key is not null and exists (
                select 1 from public.contacts k
                where k.id = ce.lead_id and k.business_id = p_business_id and k.phone_key = v_key
                  and k.account_id is not distinct from v_account))
      )
    order by cse.sent_at desc
    limit 1;

    if not found or v_event.replied_at is not null then
        return;
    end if;

    update public.campaign_step_events set replied_at = p_at where id = v_event.sid;

    update public.messages m
    set status = case when public.message_receipt_rank(m.status) >= 3 then m.status else 'read' end,
        delivered_at = coalesce(m.delivered_at, p_at),
        read_at = coalesce(m.read_at, p_at)
    where m.id = v_event.mid and m.direction = 'out';

    update public.campaign_enrollments set last_reply_at = p_at where id = v_event.eid;

    return query select v_event.sid, v_event.eid, v_event.lid, v_event.cid;
end;
$function$;

-- ─── Views: expose account_id and respect the account scope ──────────────────────────────────────────

create or replace view public.v_lead_summary with (security_invoker = false) as
 select v.id, v.business_id, v.name, v.phone, v.social_id, v.lead_state, v.lead_type, v.lead_quality, v.is_ad_lead,
    v.last_seen, v.follow_up_count, v.do_not_contact, v.ad_id, v.ad_platform, v.ad_headline, v.ad_body,
    v.ad_thumbnail_url, v.original_ad_id, v.unread_count, v.is_business_chat, v.context_summary, v.customer_intent,
    v.conv_stage, v.next_action_plan, v.cart_state, v.psychology, v.vibe_check, v.competitor_mentions,
    v.objection_tags, v.pre_purchase_questions, v.nlp_enriched_at, v.trust_markers, v.product_sold, v.deal_value,
    v.purchase_date, v.follow_up_opted_in, v.follow_up_opted_in_at, v.follow_up_opted_out_at,
    v.consent_message_sent_at, v.read_receipt, v.last_seen_online, v.sent_voice_note, v.sent_media,
    v.sent_reaction, v.intent_score, v.structural_enriched_at, v.product_interests, v.followup_status,
    v.followup_current_step, v.followup_sent_steps, v.followup_pending_approval, v.followup_draft,
    v.followup_next_due, v.ad_attributed_at, v.last_outbound_message_id, v.last_outbound_message_raw_status,
    v.last_outbound_receipt_status, v.last_outbound_message_is_read, v.last_outbound_message_at,
    k.account_id
   from public.v_lead_summary_base v
   left join public.contacts k on k.id = v.id
  where (select auth.role()) = 'service_role'
     or (v.business_id in (select public.my_business_ids())
         and (k.account_id is null or (k.account_id in (select public.my_account_ids())
              and ((select public.request_account_id()) is null or k.account_id = (select public.request_account_id())))));

create or replace view public.v_assistant_leads with (security_invoker = true) as
 select s.id, s.business_id, s.name, s.phone, s.social_id, s.lead_state, s.lead_type, s.lead_quality, s.is_ad_lead,
    s.last_seen, s.follow_up_count, s.do_not_contact, s.ad_id, s.ad_platform, s.ad_headline, s.ad_body,
    s.ad_thumbnail_url, s.original_ad_id, s.unread_count, s.is_business_chat, s.context_summary, s.customer_intent,
    s.conv_stage, s.next_action_plan, s.cart_state, s.psychology, s.vibe_check, s.competitor_mentions,
    s.objection_tags, s.pre_purchase_questions, s.nlp_enriched_at, s.trust_markers, s.product_sold, s.deal_value,
    s.purchase_date, s.follow_up_opted_in, s.follow_up_opted_in_at, s.follow_up_opted_out_at,
    s.consent_message_sent_at, s.read_receipt, s.last_seen_online, s.sent_voice_note, s.sent_media,
    s.sent_reaction, s.intent_score, s.structural_enriched_at, s.product_interests, s.followup_status,
    s.followup_current_step, s.followup_sent_steps, s.followup_pending_approval, s.followup_draft,
    s.followup_next_due, s.ad_attributed_at, s.last_outbound_message_id, s.last_outbound_message_raw_status,
    s.last_outbound_receipt_status, s.last_outbound_message_is_read, s.last_outbound_message_at,
    c.created_at as first_seen_at, c.awaiting_reply, c.awaiting_since, c.hours_awaiting_reply, c.last_inbound_at,
    c.last_outbound_at, c.follow_up_urgency, c.payment_confirmed_at, c.first_message, c.primary_language, c.wa_exists,
    s.account_id
   from public.v_lead_summary s
   join public.contacts c on c.id = s.id and c.business_id = s.business_id;

create or replace view public.v_list_summary with (security_invoker = false) as
 select v.list_id, v.business_id, v.name, v.type, v.rule_id, v.archived, v.disabled_at, v.total_contacts,
    v.est_pipeline_value, v.ready_count, v.in_campaign_count, v.opted_out_count, v.ad_id, v.ad_headline,
    v.ad_thumbnail_url, v.ad_platform, l.account_id
   from public.v_list_summary_base v
   left join public.lists l on l.id = v.list_id
  where (select auth.role()) = 'service_role'
     or (v.business_id in (select public.my_business_ids())
         and (l.account_id is null or (l.account_id in (select public.my_account_ids())
              and ((select public.request_account_id()) is null or l.account_id = (select public.request_account_id())))));

create or replace view public.v_campaign_summary with (security_invoker = false) as
 select v.campaign_id, v.business_id, v.name, v.status, v.list_id, v.list_name, v.sequence_mode, v.gateway_type,
    v.daily_cap, v.sent_today, v.enrolled_count, v.sent_count, v.replies_count, v.response_rate, v.realized_revenue,
    v.ai_rewrite_enabled, v.auto_approve, v.whatsapp_instances, v.reached_count, v.delivered_count, v.read_count,
    v.responded_count, v.responded_leads, c.account_id
   from public.v_campaign_summary_base v
   left join public.campaigns c on c.id = v.campaign_id
  where (select auth.role()) = 'service_role'
     or (v.business_id in (select public.my_business_ids())
         and (c.account_id is null or (c.account_id in (select public.my_account_ids())
              and ((select public.request_account_id()) is null or c.account_id = (select public.request_account_id())))));

create or replace view public.v_campaign_responders with (security_invoker = false) as
 select v.campaign_id, v.campaign_name, v.business_id, v.enrolled_contact_id, v.chat_contact_id, v.contact_name,
    v.contact_phone, v.first_responded_at, v.last_responded_at, v.responses, v.replied, v.reacted,
    v.last_step_number, v.last_reaction_emoji, v.last_reply_intent, c.account_id
   from public.v_campaign_responders_base v
   left join public.campaigns c on c.id = v.campaign_id
  where (select auth.role()) = 'service_role'
     or (v.business_id in (select public.my_business_ids())
         and (c.account_id is null or c.account_id in (select public.my_account_ids())));

create or replace view public.v_campaign_message_feedback with (security_invoker = false) as
 select step_event_id, enrollment_id, campaign_id, contact_id, step_id, step_number, message_id, whatsapp_message_id,
    delivery_status, is_read, sent_at, replied_at, reacted_at, reaction_emoji, opted_out_at, contact_name,
    contact_phone, reply_intent, responded_at, was_delivered, was_read, delivery_state
   from public.v_campaign_message_feedback_base
  where (select auth.role()) = 'service_role'
     or campaign_id in (select c.id from public.campaigns c
                         where c.business_id in (select public.my_business_ids())
                           and (c.account_id is null or c.account_id in (select public.my_account_ids())));

create or replace view public.v_campaign_step_summary with (security_invoker = false) as
 select step_id, campaign_id, step_number, content, delay_hours, condition, sent_count, replied_count, opt_outs,
    media, reacted_count, positive_count, negative_count, action_count, delivered_count, read_count, responded_count
   from public.v_campaign_step_summary_base
  where (select auth.role()) = 'service_role'
     or campaign_id in (select c.id from public.campaigns c
                         where c.business_id in (select public.my_business_ids())
                           and (c.account_id is null or c.account_id in (select public.my_account_ids())));

create or replace view public.v_ad_leaderboard with (security_invoker = false) as
 select v.business_id, v.ad_attribution_id, v.ad_id, v.ad_platform, v.ad_headline, v.ad_body_preview,
    v.ad_thumbnail_url, v.lead_count, v.reply_count, v.product_interest_count, v.conversion_count, v.quality_score,
    v.reply_rate_pct, v.conversion_rate_pct, v.product_interest_rate_pct, v.created_at, v.updated_at, a.account_id
   from public.v_ad_leaderboard_base v
   left join public.ad_attributions a on a.id = v.ad_attribution_id
  where (select auth.role()) = 'service_role'
     or (v.business_id in (select public.my_business_ids())
         and (a.account_id is null or (a.account_id in (select public.my_account_ids())
              and ((select public.request_account_id()) is null or a.account_id = (select public.request_account_id())))));

create or replace view public.v_auto_campaigns with (security_invoker = true) as
 select l.business_id, l.rule_id, l.id as list_id, l.name as list_name,
    d.id as default_id, d.version as default_version,
    coalesce(d.campaign_name, l.name) as campaign_name,
    coalesce(cfg.objective, d.objective) as objective,
    coalesce(cfg.playbook, d.playbook) as playbook,
    coalesce(cfg.steps, d.steps) as steps,
    coalesce(cfg.sequence_mode, d.sequence_mode, 'linear') as sequence_mode,
    coalesce(cfg.ai_rewrite_enabled, true) as ai_rewrite_enabled,
    coalesce(cfg.auto_approve, false) as auto_approve,
    coalesce(a.instance_name, cfg.whatsapp_instance_name) as whatsapp_instance_name,
    coalesce(cfg.daily_cap, 40) as daily_cap,
    (cfg.objective is not null or cfg.playbook is not null or cfg.steps is not null) as customised,
    cfg.campaign_id,
    c.status as campaign_status,
    (select count(*) from public.list_members lm where lm.list_id = l.id and public.lead_status(lm.lead_id) = 'ready') as ready_count,
    l.account_id
   from public.lists l
   left join lateral public.resolve_auto_campaign_default(l.business_id, l.rule_id)
        d(id, rule_id, industry, business_type, campaign_name, objective, playbook, sequence_mode, steps, version, is_active, created_at, updated_at) on true
   left join public.auto_campaign_configs cfg on cfg.rule_id = l.rule_id and cfg.business_id = l.business_id
                                              and cfg.account_id is not distinct from l.account_id
   left join public.campaigns c on c.id = cfg.campaign_id
   left join public.accounts a on a.id = l.account_id
  where l.type = 'auto' and not l.archived;

-- ─── Billing: AI credit per wallet, every charge tagged with its account ─────────────────────────────

-- Which wallet an account spends from: its own when on separate billing, else the business's.
create or replace function public.account_wallet_is_separate(p_account_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select billing_mode = 'separate' from accounts where id = p_account_id), false)
$$;

drop function if exists public.bill_ai_usage(text, text, text, integer, integer, integer, uuid);
create or replace function public.bill_ai_usage(p_business_id text, p_runner text, p_model text, p_prompt_tokens integer,
  p_cached_tokens integer, p_completion_tokens integer, p_run_id uuid default null, p_account_id uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_runner  billing_runners%rowtype;
  v_price   ai_model_prices%rowtype;
  v_mult    numeric;
  v_prompt  int := greatest(coalesce(p_prompt_tokens,0),0);
  v_cached  int := least(greatest(coalesce(p_cached_tokens,0),0), greatest(coalesce(p_prompt_tokens,0),0));
  v_compl   int := greatest(coalesce(p_completion_tokens,0),0);
  v_base    numeric;
  v_billed  numeric;
  v_free    boolean;
  v_old     numeric;
  v_charged numeric := 0;
  v_new     numeric;
  v_account uuid := coalesce(p_account_id, public.business_only_account(p_business_id));
  v_sep     boolean := public.account_wallet_is_separate(v_account);
begin
  if p_business_id is null then return jsonb_build_object('ok', false, 'error', 'no_business'); end if;

  select * into v_runner from billing_runners where runner_id = p_runner;
  if not found then
    insert into billing_runners (runner_id, label, user_label, multiplier_key, auto_registered)
    values (p_runner, p_runner, 'AI usage', 'ai_multiplier_default', true)
    on conflict (runner_id) do nothing;
    select * into v_runner from billing_runners where runner_id = p_runner;
  end if;

  v_mult := coalesce(v_runner.multiplier,
                     (select value from billing_prices where key = v_runner.multiplier_key),
                     (select value from billing_prices where key = 'ai_multiplier_default'),
                     5);

  select * into v_price from ai_model_prices where model = p_model;
  if not found then select * into v_price from ai_model_prices where model = 'default'; end if;

  v_base := ((v_prompt - v_cached) * v_price.input_per_1m_usd
             + v_cached * v_price.cached_input_per_1m_usd
             + v_compl  * v_price.output_per_1m_usd) / 1000000.0;
  v_billed := round(v_base * v_mult, 6);
  v_base   := round(v_base, 6);

  select (business_type = 'heysasa') into v_free from businesses where business_id = p_business_id;

  if v_sep then
    select balance_usd into v_old from account_balances where account_id = v_account for update;
  else
    select balance_usd into v_old from business_balances where business_id = p_business_id for update;
  end if;
  v_new := v_old;
  if v_old is not null and coalesce(v_free,false) = false and v_billed > 0 then
    v_charged := least(v_old, v_billed);
    if v_sep then
      update account_balances set balance_usd = balance_usd - v_charged, lifetime_spent_usd = lifetime_spent_usd + v_charged,
             updated_at = now() where account_id = v_account returning balance_usd into v_new;
    else
      update business_balances set balance_usd = balance_usd - v_charged, lifetime_spent_usd = lifetime_spent_usd + v_charged,
             updated_at = now() where business_id = p_business_id returning balance_usd into v_new;
    end if;
    insert into balance_transactions (business_id, account_id, amount, type, category, description, balance_after, currency, runner)
    values (p_business_id, v_account, -v_charged, 'debit', 'ai', p_runner, v_new, 'USD', p_runner);
  end if;

  insert into ai_usage_log (business_id, account_id, run_id, bot_id, model, input_type, prompt_tokens, completion_tokens, total_tokens,
                            estimated_cost_usd, cached_tokens, base_cost_usd, multiplier, billed_usd, charged_usd, shortfall_usd)
  values (p_business_id, v_account, coalesce(p_run_id, gen_random_uuid()), p_runner, coalesce(p_model,'unknown'), 'text', v_prompt, v_compl, v_prompt + v_compl,
          v_billed, v_cached, v_base, v_mult, v_billed, v_charged, greatest(0, v_billed - v_charged));

  return jsonb_build_object('ok', true, 'base_usd', v_base, 'multiplier', v_mult, 'billed_usd', v_billed,
                            'charged_usd', v_charged, 'balance_usd', v_new, 'internal', coalesce(v_free,false),
                            'account_id', v_account, 'wallet', case when v_sep then 'account' else 'business' end);
end $$;

drop function if exists public.bill_send(text, integer, text, text);
create or replace function public.bill_send(p_business_id text, p_count integer default 1, p_reason text default 'followup_send',
  p_runner text default 'followup_send', p_account_id uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_price_kes numeric := coalesce((select value from billing_prices where key = 'send_price_kes'), 0.5);
  v_rate      numeric := public.usd_kes_rate();
  v_amount    numeric := round(v_price_kes * greatest(coalesce(p_count,1),0) / v_rate, 6);
  v_free boolean; v_old numeric; v_charged numeric := 0; v_new numeric;
  v_account uuid := coalesce(p_account_id, public.business_only_account(p_business_id));
  v_sep     boolean := public.account_wallet_is_separate(v_account);
begin
  select (business_type = 'heysasa') into v_free from businesses where business_id = p_business_id;
  if v_sep then
    select balance_usd into v_old from account_balances where account_id = v_account for update;
  else
    select balance_usd into v_old from business_balances where business_id = p_business_id for update;
  end if;
  v_new := v_old;
  if v_old is not null and coalesce(v_free,false) = false and v_amount > 0 then
    v_charged := least(v_old, v_amount);
    if v_sep then
      update account_balances set balance_usd = balance_usd - v_charged, lifetime_spent_usd = lifetime_spent_usd + v_charged,
             updated_at = now() where account_id = v_account returning balance_usd into v_new;
    else
      update business_balances set balance_usd = balance_usd - v_charged, lifetime_spent_usd = lifetime_spent_usd + v_charged,
             updated_at = now() where business_id = p_business_id returning balance_usd into v_new;
    end if;
  end if;
  insert into balance_transactions (business_id, account_id, amount, type, category, description, balance_after, currency, runner)
  values (p_business_id, v_account, -v_amount, 'debit', 'send', p_reason, v_new, 'USD', p_runner);
  return jsonb_build_object('ok', true, 'billed_usd', v_amount, 'billed_kes', v_price_kes * greatest(coalesce(p_count,1),0),
                            'charged_usd', v_charged, 'balance_usd', v_new, 'internal', coalesce(v_free,false),
                            'account_id', v_account);
end $$;

drop function if exists public.deduct_balance(text, numeric, text);
create or replace function public.deduct_balance(p_business_id text, p_amount numeric, p_reason text, p_account_id uuid default null)
returns numeric language plpgsql security definer set search_path = public as $$
declare
  v_new numeric; v_cat text;
  v_account uuid := coalesce(p_account_id, public.business_only_account(p_business_id));
  v_sep     boolean := public.account_wallet_is_separate(v_account);
begin
  if p_amount is null or p_amount <= 0 then return null; end if;
  if v_sep then
    update account_balances
       set lifetime_spent_usd = lifetime_spent_usd + least(p_amount, balance_usd),
           balance_usd = greatest(0, balance_usd - p_amount), updated_at = now()
     where account_id = v_account returning balance_usd into v_new;
  else
    update business_balances
       set lifetime_spent_usd = lifetime_spent_usd + least(p_amount, balance_usd),
           balance_usd = greatest(0, balance_usd - p_amount), updated_at = now()
     where business_id = p_business_id returning balance_usd into v_new;
  end if;
  if not found then return null; end if;
  v_cat := case
    when p_reason like 'stage_change:%' then 'outcome'
    when p_reason = 'consent_message' then 'consent'
    when p_reason like 'followup_step_%' then 'message'
    else 'other' end;
  insert into balance_transactions (business_id, account_id, amount, type, category, description, balance_after)
  values (p_business_id, v_account, -p_amount, 'debit', v_cat, p_reason, v_new);
  return v_new;
end $$;

drop function if exists public.admin_credit_wallet(text, text, numeric, text);
create or replace function public.admin_credit_wallet(p_business_id text, p_currency text, p_amount numeric,
  p_note text default 'admin credit', p_account_id uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_usd numeric; v_new numeric; v_rate numeric := public.usd_kes_rate();
begin
  if p_amount is null or p_amount = 0 then raise exception 'amount required'; end if;
  if p_currency not in ('USD','KES') then raise exception 'currency must be USD or KES'; end if;
  v_usd := case when p_currency = 'KES' then round(p_amount / v_rate, 6) else p_amount end;
  if p_account_id is not null then
    if not exists (select 1 from accounts where id = p_account_id and business_id = p_business_id) then
      raise exception 'account % is not in business %', p_account_id, p_business_id;
    end if;
    insert into account_balances (account_id, business_id, balance_usd) values (p_account_id, p_business_id, 0)
    on conflict (account_id) do nothing;
    update account_balances set balance_usd = balance_usd + v_usd, updated_at = now()
     where account_id = p_account_id returning balance_usd into v_new;
  else
    update business_balances set balance_usd = balance_usd + v_usd, updated_at = now()
     where business_id = p_business_id returning balance_usd into v_new;
    if not found then raise exception 'no wallet for business %', p_business_id; end if;
  end if;
  insert into balance_transactions (business_id, account_id, amount, type, category, description, balance_after, currency)
  values (p_business_id, p_account_id, v_usd, case when v_usd > 0 then 'credit' else 'debit' end, 'adjustment',
          coalesce(p_note,'admin credit') || case when p_currency = 'KES' then ' (KES ' || p_amount || ')' else '' end, v_new, 'USD');
  return jsonb_build_object('ok', true, 'currency', 'USD', 'new_balance', v_new, 'new_balance_kes', round(v_new * v_rate, 2),
                            'wallet', case when p_account_id is null then 'business' else 'account' end);
end $$;

-- Owner / admin billing page. With p_account_id: that account's spend (and its own wallet when billed separately).
drop function if exists public.my_billing_overview(text);
create or replace function public.my_billing_overview(p_business_id text, p_account_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_balance numeric; v_lifetime numeric;
  v_rate numeric := public.usd_kes_rate();
  v_price numeric := coalesce((select value from billing_prices where key = 'send_price_kes'), 0.5);
  v_month timestamptz := date_trunc('month', now());
  v_kes numeric; v_est numeric; v_p numeric; v_sep boolean := false;
begin
  if p_business_id not in (select my_business_ids()) then raise exception 'not allowed'; end if;
  if p_account_id is not null then
    if not exists (select 1 from accounts where id = p_account_id and business_id = p_business_id) then raise exception 'not allowed'; end if;
    if p_account_id not in (select my_account_ids()) then raise exception 'not allowed'; end if;
    v_sep := public.account_wallet_is_separate(p_account_id);
  elsif p_business_id not in (select my_admin_business_ids()) then
    raise exception 'not allowed';
  end if;

  if v_sep then
    select balance_usd, lifetime_spent_usd into v_balance, v_lifetime from account_balances where account_id = p_account_id;
  else
    select balance_usd, lifetime_spent_usd into v_balance, v_lifetime from business_balances where business_id = p_business_id;
  end if;
  v_kes := coalesce(v_balance,0) * v_rate;
  v_est := case when v_price > 0 then floor(v_kes / v_price) else 0 end;
  v_p := power(10, greatest(length(v_est::bigint::text) - 2, 0));
  v_est := floor(v_est / v_p) * v_p;
  return jsonb_build_object(
    'wallet', case when v_sep then 'account' else 'business' end,
    'account_id', p_account_id,
    'balance_kes', round(v_kes, 2),
    'estimated_messages', v_est,
    'lifetime_spent_kes', round(coalesce(v_lifetime,0) * v_rate, 2),
    'month_spent_kes', round(coalesce((select sum(-amount) from balance_transactions where business_id = p_business_id
        and (p_account_id is null or account_id = p_account_id) and type = 'debit' and category <> 'adjustment' and created_at >= v_month),0) * v_rate, 2),
    'month_messages', (select count(*) from balance_transactions where business_id = p_business_id
        and (p_account_id is null or account_id = p_account_id) and type = 'debit'
        and public.billing_label(category, description, null) = 'Follow-up messages' and created_at >= v_month),
    'by_category', coalesce((select jsonb_agg(jsonb_build_object('label', lbl, 'count', c, 'kes', round(u * v_rate, 2)) order by u desc)
        from (select public.billing_label(t.category, t.description, r.user_label) lbl, count(*) c, sum(-t.amount) u
                from balance_transactions t left join billing_runners r on r.runner_id = t.runner
               where t.business_id = p_business_id and (p_account_id is null or t.account_id = p_account_id)
                 and t.type = 'debit' and t.category <> 'adjustment' and t.created_at >= v_month group by 1) x), '[]'::jsonb),
    'by_account', case when p_account_id is null then coalesce((select jsonb_agg(jsonb_build_object(
          'account_id', a.id, 'label', a.label, 'phone_number', a.phone_number, 'status', a.status,
          'billing_mode', a.billing_mode, 'subscription_status', a.subscription_status, 'paid_until', a.paid_until,
          'month_spent_kes', round(coalesce((select sum(-t.amount) from balance_transactions t where t.account_id = a.id
               and t.type = 'debit' and t.category <> 'adjustment' and t.created_at >= v_month), 0) * v_rate, 2),
          'wallet_kes', case when a.billing_mode = 'separate'
               then round(coalesce((select ab.balance_usd from account_balances ab where ab.account_id = a.id), 0) * v_rate, 2) end)
          order by a.created_at)
        from accounts a where a.business_id = p_business_id and a.status <> 'closed'), '[]'::jsonb) end,
    'daily', coalesce((select jsonb_agg(jsonb_build_object('day', g::date, 'kes', round(coalesce((select sum(-amount) from balance_transactions
                where business_id = p_business_id and (p_account_id is null or account_id = p_account_id)
                  and type = 'debit' and category <> 'adjustment' and created_at::date = g::date),0) * v_rate, 2)) order by g)
        from generate_series(current_date - 29, current_date, interval '1 day') g), '[]'::jsonb),
    'recent', coalesce((select jsonb_agg(to_jsonb(t)) from (
        select x.created_at, x.type, x.category, x.account_id, public.billing_label(x.category, x.description, r.user_label) as label,
               round(abs(x.amount) * v_rate, 4) as kes, round(x.balance_after * v_rate, 2) as balance_kes
          from balance_transactions x left join billing_runners r on r.runner_id = x.runner
         where x.business_id = p_business_id and (p_account_id is null or x.account_id = p_account_id)
         order by x.created_at desc limit 40) t), '[]'::jsonb),
    'invoices', coalesce((select jsonb_agg(to_jsonb(i) order by i.period_start desc) from (
        select id, account_id, bill_to, period_start, period_end, amount_kes, status, due_at, paid_at
          from account_invoices where business_id = p_business_id and (p_account_id is null or account_id = p_account_id)
         order by period_start desc limit 24) i), '[]'::jsonb)
  );
end $$;

-- ─── Access fee: KES 10,000 per account per month ───────────────────────────────────────────────────

-- Issues the next month's invoice for every account whose paid period ends within 3 days, and (when
-- enforcement is on) suspends accounts more than the grace period past due. Safe to run any number of times.
create or replace function public.account_billing_daily()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_price numeric := coalesce((select value from billing_prices where key = 'account_monthly_kes'), 10000);
  v_grace int := coalesce((select value from billing_prices where key = 'account_grace_days'), 7)::int;
  v_enforce boolean := coalesce((select value from billing_prices where key = 'enforce_account_subscription'), 0) = 1;
  v_issued int := 0; v_overdue int := 0; v_suspended int := 0;
begin
  with due as (
    select a.id, a.business_id, a.billing_mode, coalesce(a.paid_until, a.created_at)::date as start_day,
           coalesce(a.monthly_price_kes, v_price) as price
      from accounts a
     where a.status <> 'closed' and a.subscription_status <> 'cancelled'
       and coalesce(a.paid_until, a.created_at) <= now() + interval '3 days'
  ), ins as (
    insert into account_invoices (account_id, business_id, bill_to, period_start, period_end, amount_kes, due_at)
    select d.id, d.business_id, case when d.billing_mode = 'separate' then 'account' else 'business' end,
           d.start_day, (d.start_day + interval '1 month')::date, d.price, d.start_day::timestamptz
      from due d
    on conflict (account_id, period_start) do nothing
    returning 1
  ) select count(*) into v_issued from ins;

  update accounts a set subscription_status = 'past_due'
   where a.subscription_status in ('trial', 'active')
     and exists (select 1 from account_invoices i where i.account_id = a.id and i.status = 'due' and i.due_at < now());
  get diagnostics v_overdue = row_count;

  if v_enforce then
    update accounts a set subscription_status = 'suspended'
     where a.subscription_status = 'past_due'
       and exists (select 1 from account_invoices i where i.account_id = a.id and i.status = 'due'
                    and i.due_at < now() - make_interval(days => v_grace));
    get diagnostics v_suspended = row_count;
  end if;

  return jsonb_build_object('issued', v_issued, 'past_due', v_overdue, 'suspended', v_suspended, 'enforced', v_enforce);
end $$;

-- Marks an access-fee invoice paid (HeySasa admin, by hand, until a payment gateway exists).
create or replace function public.admin_mark_account_invoice_paid(p_invoice_id uuid, p_reference text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_inv account_invoices%rowtype;
begin
  update account_invoices set status = 'paid', paid_at = now(), reference = coalesce(p_reference, reference)
   where id = p_invoice_id and status = 'due' returning * into v_inv;
  if not found then raise exception 'invoice not found or not due'; end if;
  update accounts set paid_until = greatest(coalesce(paid_until, v_inv.period_start::timestamptz), v_inv.period_end::timestamptz),
                      subscription_status = case
                        when exists (select 1 from account_invoices i where i.account_id = v_inv.account_id and i.status = 'due' and i.due_at < now())
                        then subscription_status else 'active' end
   where id = v_inv.account_id;
  return jsonb_build_object('ok', true, 'account_id', v_inv.account_id, 'paid_until', v_inv.period_end);
end $$;

-- Is this account allowed to send and run the chat AI right now?
create or replace function public.account_can_operate(p_account_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select a.status <> 'closed' and a.subscription_status <> 'suspended' from accounts a where a.id = p_account_id), true)
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'account-billing-daily';
    perform cron.schedule('account-billing-daily', '15 0 * * *', 'select public.account_billing_daily()');
  end if;
end $$;

-- Part B (20261024100300) replaces this with "true". Until then a business must keep a single account.
create or replace function public.accounts_part_b_applied()
returns boolean language sql immutable as $$ select false $$;
grant execute on function public.accounts_part_b_applied() to authenticated, service_role;

-- ─── Grants ──────────────────────────────────────────────────────────────────────────────────────────

revoke execute on function public.seed_account_defaults(uuid), public.trg_seed_account_defaults(), public.claim_business_rows(uuid),
  public.resolve_account(text, uuid), public.account_wallet_is_separate(uuid),
  public.bill_ai_usage(text, text, text, integer, integer, integer, uuid, uuid),
  public.bill_send(text, integer, text, text, uuid), public.deduct_balance(text, numeric, text, uuid),
  public.admin_credit_wallet(text, text, numeric, text, uuid), public.account_billing_daily(),
  public.admin_mark_account_invoice_paid(uuid, text), public.account_can_operate(uuid),
  public.activate_auto_campaign(text, text, uuid), public.apply_auto_campaign_config(text, text, uuid),
  public.chat_ai_seed_skills(text, uuid), public.chat_ai_reset_skill(text, text, uuid),
  public.copy_business_items_to_account(uuid, text, text[], uuid), public.my_billing_overview(text, uuid),
  public.sync_auto_lists(text), public.sync_ad_lists(text), public.seed_auto_lists(text),
  public.chat_ai_claim_slot(text, text, integer)
  from anon, public;

grant execute on function public.seed_account_defaults(uuid), public.resolve_account(text, uuid),
  public.account_wallet_is_separate(uuid),
  public.bill_ai_usage(text, text, text, integer, integer, integer, uuid, uuid),
  public.bill_send(text, integer, text, text, uuid), public.deduct_balance(text, numeric, text, uuid),
  public.admin_credit_wallet(text, text, numeric, text, uuid), public.account_billing_daily(),
  public.admin_mark_account_invoice_paid(uuid, text), public.account_can_operate(uuid),
  public.sync_auto_lists(text), public.seed_auto_lists(text), public.chat_ai_claim_slot(text, text, integer)
  to service_role;

grant execute on function public.activate_auto_campaign(text, text, uuid), public.apply_auto_campaign_config(text, text, uuid),
  public.chat_ai_seed_skills(text, uuid), public.chat_ai_reset_skill(text, text, uuid),
  public.copy_business_items_to_account(uuid, text, text[], uuid), public.my_billing_overview(text, uuid),
  public.sync_ad_lists(text)
  to authenticated, service_role;

grant execute on function public.match_knowledge_chunks(text, vector, integer, double precision, text, uuid, uuid)
  to authenticated, service_role;
