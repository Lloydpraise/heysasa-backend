-- Single wallet. One balance (business_balances.balance_usd) is deducted by BOTH AI runs (USD, OpenAI cost x multiplier)
-- and follow-up sends (send_price_kes / usd_kes_rate). Customers only ever see it in KES: balance_usd x usd_kes_rate.
-- balance_kes is retired (folded into balance_usd below, then left at 0).

insert into public.billing_prices (key, value, unit, label, description, sort) values
  ('usd_kes_rate', 129.2, 'KES', 'USD to KES rate', 'KES per 1 USD. Customers see their USD wallet converted at this rate; follow-up sends are converted at this rate when charged. Update when the market moves.', 5)
on conflict (key) do nothing;

create or replace function public.usd_kes_rate() returns numeric language sql stable security definer set search_path = public as $$
  select coalesce((select value from billing_prices where key = 'usd_kes_rate' and value > 0), 129.2)
$$;
revoke all on function public.usd_kes_rate() from public, anon, authenticated;
grant execute on function public.usd_kes_rate() to service_role;

-- Fold any existing KES balances into the USD wallet (one-off, at the current rate)
do $$
declare r record; v_rate numeric := public.usd_kes_rate(); v_usd numeric; v_new numeric;
begin
  for r in select business_id, balance_kes from business_balances where balance_kes > 0 loop
    v_usd := round(r.balance_kes / v_rate, 6);
    update business_balances set balance_usd = balance_usd + v_usd, balance_kes = 0, updated_at = now()
     where business_id = r.business_id returning balance_usd into v_new;
    insert into balance_transactions (business_id, amount, type, category, description, balance_after, currency)
    values (r.business_id, v_usd, 'credit', 'adjustment', 'Converted KES balance (KES ' || r.balance_kes || ')', v_new, 'USD');
  end loop;
end $$;

create or replace function public.bill_send(
  p_business_id text, p_count int default 1, p_reason text default 'followup_send', p_runner text default 'followup_send'
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_price_kes numeric := coalesce((select value from billing_prices where key = 'send_price_kes'), 0.5);
  v_rate      numeric := public.usd_kes_rate();
  v_amount    numeric := round(v_price_kes * greatest(coalesce(p_count,1),0) / v_rate, 6);   -- USD
  v_free boolean; v_old numeric; v_charged numeric := 0; v_new numeric;
begin
  select (business_type = 'heysasa') into v_free from businesses where business_id = p_business_id;
  select balance_usd into v_old from business_balances where business_id = p_business_id for update;
  v_new := v_old;
  if v_old is not null and coalesce(v_free,false) = false and v_amount > 0 then
    v_charged := least(v_old, v_amount);
    update business_balances set balance_usd = balance_usd - v_charged,
           lifetime_spent_usd = lifetime_spent_usd + v_charged, updated_at = now()
     where business_id = p_business_id returning balance_usd into v_new;
  end if;
  insert into balance_transactions (business_id, amount, type, category, description, balance_after, currency, runner)
  values (p_business_id, -v_amount, 'debit', 'send', p_reason, v_new, 'USD', p_runner);
  return jsonb_build_object('ok', true, 'billed_usd', v_amount, 'billed_kes', v_price_kes * greatest(coalesce(p_count,1),0),
                            'charged_usd', v_charged, 'balance_usd', v_new, 'internal', coalesce(v_free,false));
end $$;

-- Admin credit: KES amounts are converted to USD at the current rate and added to the one wallet.
create or replace function public.admin_credit_wallet(p_business_id text, p_currency text, p_amount numeric, p_note text default 'admin credit')
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_usd numeric; v_new numeric; v_rate numeric := public.usd_kes_rate();
begin
  if p_amount is null or p_amount = 0 then raise exception 'amount required'; end if;
  if p_currency not in ('USD','KES') then raise exception 'currency must be USD or KES'; end if;
  v_usd := case when p_currency = 'KES' then round(p_amount / v_rate, 6) else p_amount end;
  update business_balances set balance_usd = balance_usd + v_usd, updated_at = now()
   where business_id = p_business_id returning balance_usd into v_new;
  if not found then raise exception 'no wallet for business %', p_business_id; end if;
  insert into balance_transactions (business_id, amount, type, category, description, balance_after, currency)
  values (p_business_id, v_usd, case when v_usd > 0 then 'credit' else 'debit' end, 'adjustment',
          coalesce(p_note,'admin credit') || case when p_currency = 'KES' then ' (KES ' || p_amount || ')' else '' end, v_new, 'USD');
  return jsonb_build_object('ok', true, 'currency', 'USD', 'new_balance', v_new, 'new_balance_kes', round(v_new * v_rate, 2));
end $$;

create or replace function public.admin_billing_overview(p_since timestamptz default null)
returns jsonb language sql stable security definer set search_path = public as $$
with rate as (select public.usd_kes_rate() r),
ai as (
  select business_id, count(*) calls, coalesce(sum(base_cost_usd),0) base_usd,
         coalesce(sum(coalesce(billed_usd, estimated_cost_usd)),0) billed_usd,
         coalesce(sum(charged_usd),0) charged_usd, coalesce(sum(shortfall_usd),0) shortfall_usd, coalesce(sum(total_tokens),0) tokens
    from ai_usage_log where p_since is null or created_at >= p_since group by business_id
), snd as (
  select business_id, count(*) sends, coalesce(sum(-amount),0) billed_usd
    from balance_transactions where category = 'send' and (p_since is null or created_at >= p_since) group by business_id
), rn as (
  select business_id, jsonb_object_agg(bot_id, jsonb_build_object('calls', c, 'billed_usd', b, 'base_usd', bb)) runners
    from (select business_id, bot_id, count(*) c, sum(coalesce(billed_usd, estimated_cost_usd)) b, coalesce(sum(base_cost_usd),0) bb
            from ai_usage_log where p_since is null or created_at >= p_since group by business_id, bot_id) x group by business_id
), rows as (
  select b.business_id, b.name, b.business_type,
         coalesce(bb.balance_usd,0) balance_usd, round(coalesce(bb.balance_usd,0) * (select r from rate), 2) balance_kes,
         coalesce(ai.calls,0) ai_calls, coalesce(ai.base_usd,0) ai_base_usd, coalesce(ai.billed_usd,0) ai_billed_usd,
         coalesce(ai.charged_usd,0) ai_charged_usd, coalesce(ai.shortfall_usd,0) ai_shortfall_usd, coalesce(ai.tokens,0) tokens,
         coalesce(snd.sends,0) sends, coalesce(snd.billed_usd,0) send_billed_usd,
         round(coalesce(snd.billed_usd,0) * (select r from rate), 2) send_billed_kes, coalesce(rn.runners,'{}'::jsonb) runners
    from businesses b
    left join business_balances bb on bb.business_id = b.business_id
    left join ai on ai.business_id = b.business_id
    left join snd on snd.business_id = b.business_id
    left join rn on rn.business_id = b.business_id
)
select jsonb_build_object(
  'since', p_since, 'usd_kes_rate', (select r from rate),
  'totals', (select jsonb_build_object('ai_calls', coalesce(sum(ai_calls),0), 'ai_base_usd', coalesce(sum(ai_base_usd),0),
      'ai_billed_usd', coalesce(sum(ai_billed_usd),0), 'ai_charged_usd', coalesce(sum(ai_charged_usd),0),
      'ai_shortfall_usd', coalesce(sum(ai_shortfall_usd),0), 'sends', coalesce(sum(sends),0),
      'send_billed_usd', coalesce(sum(send_billed_usd),0), 'send_billed_kes', coalesce(sum(send_billed_kes),0),
      'balance_usd', coalesce(sum(balance_usd),0), 'balance_kes', coalesce(sum(balance_kes),0)) from rows),
  'businesses', (select coalesce(jsonb_agg(to_jsonb(r) order by r.ai_billed_usd desc), '[]'::jsonb) from rows r),
  'runners', (select coalesce(jsonb_agg(jsonb_build_object('runner_id', runner_id, 'label', label, 'multiplier_key', multiplier_key,
              'multiplier', multiplier, 'auto_registered', auto_registered, 'is_active', is_active) order by auto_registered desc, runner_id), '[]'::jsonb)
              from billing_runners)
);
$$;

-- What a business sees: ONE balance in KES, spend in KES, no rates, no USD.
create or replace function public.my_billing_overview(p_business_id text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_bal business_balances%rowtype;
  v_rate numeric := public.usd_kes_rate();
  v_price numeric := coalesce((select value from billing_prices where key = 'send_price_kes'), 0.5);
  v_month timestamptz := date_trunc('month', now());
  v_kes numeric; v_est numeric; v_p numeric;
begin
  if p_business_id not in (select my_business_ids()) then raise exception 'not allowed'; end if;
  select * into v_bal from business_balances where business_id = p_business_id;
  v_kes := coalesce(v_bal.balance_usd,0) * v_rate;
  v_est := case when v_price > 0 then floor(v_kes / v_price) else 0 end;
  v_p := power(10, greatest(length(v_est::bigint::text) - 2, 0));       -- keep 2 significant figures: it is only an estimate
  v_est := floor(v_est / v_p) * v_p;
  return jsonb_build_object(
    'balance_kes', round(v_kes, 2),
    'estimated_messages', v_est,
    'lifetime_spent_kes', round(coalesce(v_bal.lifetime_spent_usd,0) * v_rate, 2),
    'month_spent_kes', round(coalesce((select sum(-amount) from balance_transactions where business_id = p_business_id and type = 'debit' and category <> 'adjustment' and created_at >= v_month),0) * v_rate, 2),
    'month_messages', (select count(*) from balance_transactions where business_id = p_business_id and category = 'send' and created_at >= v_month),
    'by_category', coalesce((select jsonb_agg(jsonb_build_object('label', lbl, 'count', c, 'kes', round(u * v_rate, 2)) order by u desc)
        from (select case when t.category = 'send' then 'Follow-up messages' else coalesce(r.user_label, case when t.category = 'ai' then 'AI usage' else 'Other' end) end lbl,
                     count(*) c, sum(-t.amount) u
                from balance_transactions t left join billing_runners r on r.runner_id = t.runner
               where t.business_id = p_business_id and t.type = 'debit' and t.category <> 'adjustment' and t.created_at >= v_month group by 1) x), '[]'::jsonb),
    'daily', coalesce((select jsonb_agg(jsonb_build_object('day', g::date, 'kes', round(coalesce((select sum(-amount) from balance_transactions
                where business_id = p_business_id and type = 'debit' and category <> 'adjustment' and created_at::date = g::date),0) * v_rate, 2)) order by g)
        from generate_series(current_date - 29, current_date, interval '1 day') g), '[]'::jsonb),
    'recent', coalesce((select jsonb_agg(to_jsonb(t)) from (
        select x.created_at, x.type, x.category,
               case when x.category = 'send' then 'Follow-up message' else coalesce(r.user_label, case x.category when 'ai' then 'AI usage' when 'adjustment' then 'Balance top up' else initcap(x.category) end) end as label,
               round(abs(x.amount) * v_rate, 4) as kes, round(x.balance_after * v_rate, 2) as balance_kes
          from balance_transactions x left join billing_runners r on r.runner_id = x.runner
         where x.business_id = p_business_id order by x.created_at desc limit 40) t), '[]'::jsonb)
  );
end $$;
revoke all on function public.my_billing_overview(text) from public, anon;
grant execute on function public.my_billing_overview(text) to authenticated;
