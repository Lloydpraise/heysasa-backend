-- HeySasa waitlist: welcome + 2-week follow-up using the existing auto-list / auto-campaign machinery.
-- Everything here is scoped to business_type = 'heysasa' or to the new rule id 'waitinglist',
-- so no other business, rule or default changes behaviour.
-- Apply in the Supabase SQL editor. Safe to run twice.

-- 1. Waitlist rows: consent record + link to the contact created for the HeySasa business
alter table public.waitlist_leads
  add column if not exists consent_whatsapp boolean not null default false,
  add column if not exists consent_at timestamptz,
  add column if not exists contact_id bigint references public.contacts(id) on delete set null;
create index if not exists waitlist_leads_contact_idx on public.waitlist_leads (contact_id);

-- 2. Special business type for HeySasa itself (it was 'saas')
update public.businesses set business_type = 'heysasa' where business_id = 'heysasa';

-- 3. The list rule: everyone on the waitlist who ticked consent, has a contact, and has not opted out / been lost
create or replace function public._auto_list_desired(p_business_id text, p_rule_id text, p_factors jsonb)
 returns setof bigint
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_customer_stages text[] := array['paid','fulfilled','post_purchase','active','completed','retention'];
  v_days int; v_hours int; v_max int; v_min int; v_req boolean; v_src text;
begin
  if p_rule_id = 'hot_inquiries' then
    v_days := coalesce((p_factors->>'window_days')::int, 7);
    v_req  := coalesce((p_factors->>'require_price_request')::boolean, true);
    return query select s.contact_id from public._auto_list_signals(p_business_id) s
      where coalesce(s.lead_type,'unknown') in ('business','unknown') and s.lead_state not in ('won','lost')
        and s.purchase_count = 0 and coalesce(s.stage,'') <> all (v_customer_stages)
        and s.last_inbound_at >= now() - make_interval(days => v_days)
        and ( s.intent in ('buying','price_check') or s.price_signal
              or s.stage in ('selection','intent','proposal','negotiation','checkout','awaiting_payment','committed')
              or (not v_req and s.is_ad_lead
                  and coalesce(s.ad_attributed_at, s.last_inbound_at) >= now() - make_interval(days => v_days)) );

  elsif p_rule_id = 'unanswered' then
    v_hours := coalesce((p_factors->>'min_hours')::int, 2);
    v_max   := coalesce((p_factors->>'max_days')::int, 14);
    return query select s.contact_id from public._auto_list_signals(p_business_id) s
      where coalesce(s.lead_type,'unknown') in ('business','unknown') and s.lead_state not in ('won','lost') and not s.dnc
        and s.last_inbound_at is not null
        and s.last_inbound_at > coalesce(s.last_outbound_at, '-infinity'::timestamptz)
        and s.last_inbound_at <= now() - make_interval(hours => v_hours)
        and s.last_inbound_at >= now() - make_interval(days => v_max);

  elsif p_rule_id = 'price_hesitant' then
    v_days := coalesce((p_factors->>'window_days')::int, 30);
    return query select s.contact_id from public._auto_list_signals(p_business_id) s
      where coalesce(s.lead_type,'unknown') in ('business','unknown') and s.lead_state not in ('won','lost')
        and s.purchase_count = 0 and coalesce(s.stage,'') <> all (v_customer_stages)
        and s.price_signal and s.last_inbound_at >= now() - make_interval(days => v_days);

  elsif p_rule_id = 'cold_dormant' then
    v_days := coalesce((p_factors->>'inactivity_days')::int, 14);
    return query select s.contact_id from public._auto_list_signals(p_business_id) s
      where coalesce(s.lead_type,'unknown') in ('business','unknown') and s.lead_state not in ('won','lost')
        and s.purchase_count = 0 and coalesce(s.stage,'') <> all (v_customer_stages)
        and s.last_inbound_at is not null
        and s.last_inbound_at < now() - make_interval(days => v_days);

  elsif p_rule_id = 'cart_abandoners' then
    v_days := coalesce((p_factors->>'no_purchase_window_days')::int, 3);
    return query select t.contact_id from (
        select s.*, coalesce(s.payment_info_sent_at,
               case when s.stage in ('checkout','awaiting_payment','committed') or s.has_cart
                    then greatest(s.last_inbound_at, s.last_outbound_at) end) as sig_at
        from public._auto_list_signals(p_business_id) s) t
      where coalesce(t.lead_type,'unknown') in ('business','unknown') and t.lead_state not in ('won','lost')
        and coalesce(t.stage,'') <> all (v_customer_stages)
        and t.sig_at is not null and t.sig_at <= now() - make_interval(days => v_days)
        and (t.last_purchase_at is null or t.last_purchase_at < t.sig_at);

  elsif p_rule_id = 'post_purchase' then
    v_min := coalesce((p_factors->>'min_purchases')::int, 1);
    return query select s.contact_id from public._auto_list_signals(p_business_id) s
      where coalesce(s.lead_type,'unknown') in ('business','unknown')
        and greatest(s.purchase_count,
              case when s.stage = any (v_customer_stages) or s.lead_state = 'won' then 1 else 0 end) >= v_min;

  elsif p_rule_id = 'low_intent' then
    v_src := coalesce(p_factors->>'flag_source', 'both');
    return query select s.contact_id from public._auto_list_signals(p_business_id) s
      where coalesce(s.lead_type,'unknown') in ('business','unknown','junk') and s.purchase_count = 0
        and coalesce(s.stage,'') <> all (v_customer_stages)
        and ( (v_src in ('agent','both') and s.lead_state = 'lost')
           or (v_src in ('ai','both') and s.nlp_enriched_at is not null
               and coalesce(s.intent,'unknown') not in ('buying','price_check') and not s.price_signal
               and (s.last_inbound_at is null or s.last_inbound_at < now() - interval '2 days')
               and (s.lead_type = 'junk' or s.quality_score <= 3)) );

  -- NEW: HeySasa waitlist (only ever matches for a business whose type is 'heysasa')
  elsif p_rule_id = 'waitinglist' then
    return query select w.contact_id
      from public.waitlist_leads w
      join public.contacts c on c.id = w.contact_id
      join public.businesses b on b.business_id = p_business_id and b.business_type = 'heysasa'
     where c.business_id = p_business_id
       and w.contact_id is not null
       and w.consent_whatsapp
       and w.status not in ('opted_out', 'lost')
       and not coalesce(c.do_not_contact, false);
  end if;
end $function$;

-- 4. Let the sweep evaluate the new rule id (the only change: 'waitinglist' added to the list)
create or replace function public.sync_auto_lists(p_business_id text default null::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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
    select l.id list_id, sr.business_id, sr.rule_id, sr.factors
    from public.segmentation_rules sr
    join public.lists l on l.business_id = sr.business_id and l.rule_id = sr.rule_id
    where sr.enabled and l.type = 'auto' and not l.archived
      and sr.rule_id in ('hot_inquiries','unanswered','price_hesitant','cold_dormant','cart_abandoners','post_purchase','low_intent','waitinglist')
      and (p_business_id is null or sr.business_id = p_business_id)
  loop
    begin
      v_ids := array(select public._auto_list_desired(r.business_id, r.rule_id, r.factors));

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
      raise warning 'sync_auto_lists failed for % / %: %', r.business_id, r.rule_id, sqlerrm;
    end;
  end loop;

  return jsonb_build_object('lists', t_lists, 'added', t_added, 'removed', t_removed, 'purged', t_purged, 'errors', t_errors);
end $function$;

-- 5. Switch the rule on for the HeySasa business and create its auto list
insert into public.segmentation_rules (business_id, rule_id, enabled, factors)
values ('heysasa', 'waitinglist', true, '{}'::jsonb)
on conflict (business_id, rule_id) do update set enabled = true, disabled_at = null;

insert into public.lists (business_id, name, type, rule_id)
select 'heysasa', 'waitinglist', 'auto', 'waitinglist'
where not exists (select 1 from public.lists where business_id = 'heysasa' and rule_id = 'waitinglist');

-- 6. The campaign default: only for business_type 'heysasa'. Edit the wording any time in /admin -> Campaign defaults.
--    Each person moves through these on their OWN clock: message 1 goes when they join, each next message
--    goes "wait" hours after their previous one was actually sent.
insert into public.auto_campaign_defaults (rule_id, industry, business_type, campaign_name, objective, playbook, sequence_mode, steps)
select 'waitinglist', null, 'heysasa', 'Waitlist welcome and follow-up',
  'Warm each person who joined the HeySasa waiting list, get one reply, and invite them to a free analysis of their own chats.',
  'Short, friendly, human. One question per message. Never pushy. Stop when they reply or ask to stop.',
  'linear',
  '[
    {"content":"Hi {{first_name}}, thanks for joining the HeySasa list 🙌 HeySasa reads your WhatsApp chats, tells you which leads to chase today, and follows up for you. Quick question: roughly how many WhatsApp enquiries does your business get in a week? (Reply STOP any time and I will leave you alone.)","delay_hours":0},
    {"content":"Hi {{first_name}}, quick update from the HeySasa build: we are testing it on real business chats to find leads that went quiet after asking the price. Do you follow up on quiet leads today, or is it mostly from memory?","delay_hours":24},
    {"content":"Leads often go quiet right after asking for the price, and nobody follows up in time. How many would you say slip away from your business in a month, {{first_name}}?","delay_hours":48},
    {"content":"Three quick ones, {{first_name}}: 1) Do you follow up on quiet leads today? 2) How do you keep track (memory, notebook, Excel, Odoo)? 3) Roughly how many leads slip? Reply with any of them.","delay_hours":48},
    {"content":"I would like to show you HeySasa on your own chats, free. One connection and I will show you which leads to chase this week. Want me to set it up, {{first_name}}?","delay_hours":48},
    {"content":"The hardest part of follow-ups is knowing who to chase first. HeySasa lists them for you each morning with a reason for each. Want a quick look at how it would work for your business?","delay_hours":48},
    {"content":"We are onboarding our first businesses one by one. If you would like a place, reply YES and I will set up your free analysis.","delay_hours":48},
    {"content":"Last message from me for now, {{first_name}}. If you want HeySasa to show you who to chase and follow up for you, reply YES and we will start. Otherwise, all the best with your business 🙏","delay_hours":48}
  ]'::jsonb
where not exists (select 1 from public.auto_campaign_defaults where rule_id = 'waitinglist' and business_type = 'heysasa');

-- 7. Campaign settings for the HeySasa business: send the text exactly as written (no AI rewrite), send automatically.
--    The WhatsApp number is chosen in the app (Lists & Campaigns -> Auto) once the HeySasa number is connected.
insert into public.auto_campaign_configs (business_id, rule_id, ai_rewrite_enabled, auto_approve, daily_cap)
values ('heysasa', 'waitinglist', false, true, 40)
on conflict (business_id, rule_id) do update set ai_rewrite_enabled = false, auto_approve = true;
