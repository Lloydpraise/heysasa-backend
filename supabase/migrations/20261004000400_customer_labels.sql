-- Customer-facing label for a wallet movement (legacy rows used category 'outcome'/'other').
create or replace function public.billing_label(p_category text, p_description text, p_user_label text)
returns text language sql immutable as $$
  select case
    when p_category = 'send' or coalesce(p_description,'') like 'followup_step%' or coalesce(p_description,'') like 'consent_message%' then 'Follow-up messages'
    when p_category = 'ai' then coalesce(p_user_label, 'AI usage')
    when p_category = 'adjustment' then 'Balance top up'
    when p_category in ('outcome','other') then 'Lead tracking'
    else coalesce(p_user_label, initcap(p_category))
  end
$$;

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
  v_p := power(10, greatest(length(v_est::bigint::text) - 2, 0));
  v_est := floor(v_est / v_p) * v_p;
  return jsonb_build_object(
    'balance_kes', round(v_kes, 2),
    'estimated_messages', v_est,
    'lifetime_spent_kes', round(coalesce(v_bal.lifetime_spent_usd,0) * v_rate, 2),
    'month_spent_kes', round(coalesce((select sum(-amount) from balance_transactions where business_id = p_business_id and type = 'debit' and category <> 'adjustment' and created_at >= v_month),0) * v_rate, 2),
    'month_messages', (select count(*) from balance_transactions where business_id = p_business_id and type = 'debit' and public.billing_label(category, description, null) = 'Follow-up messages' and created_at >= v_month),
    'by_category', coalesce((select jsonb_agg(jsonb_build_object('label', lbl, 'count', c, 'kes', round(u * v_rate, 2)) order by u desc)
        from (select public.billing_label(t.category, t.description, r.user_label) lbl, count(*) c, sum(-t.amount) u
                from balance_transactions t left join billing_runners r on r.runner_id = t.runner
               where t.business_id = p_business_id and t.type = 'debit' and t.category <> 'adjustment' and t.created_at >= v_month group by 1) x), '[]'::jsonb),
    'daily', coalesce((select jsonb_agg(jsonb_build_object('day', g::date, 'kes', round(coalesce((select sum(-amount) from balance_transactions
                where business_id = p_business_id and type = 'debit' and category <> 'adjustment' and created_at::date = g::date),0) * v_rate, 2)) order by g)
        from generate_series(current_date - 29, current_date, interval '1 day') g), '[]'::jsonb),
    'recent', coalesce((select jsonb_agg(to_jsonb(t)) from (
        select x.created_at, x.type, x.category, public.billing_label(x.category, x.description, r.user_label) as label,
               round(abs(x.amount) * v_rate, 4) as kes, round(x.balance_after * v_rate, 2) as balance_kes
          from balance_transactions x left join billing_runners r on r.runner_id = x.runner
         where x.business_id = p_business_id order by x.created_at desc limit 40) t), '[]'::jsonb)
  );
end $$;
revoke all on function public.my_billing_overview(text) from public, anon;
grant execute on function public.my_billing_overview(text) to authenticated;
