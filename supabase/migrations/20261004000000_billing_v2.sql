-- Billing v2
--   AI runs  : billed in USD   = (OpenAI input+output cost) x runner multiplier (default 5, chat 8)
--   Sends    : billed in KES   = send_price_kes per message (default 0.50 = 1 KES / 2 messages)
-- Every price lives in a table the admin edits. Every AI run goes through ONE function
-- (bill_ai_usage) so the backend, analyser, persona pack, follow-up engine and any future
-- runner (product runner, chat AI) cannot bill differently from each other.

-- ── Editable prices ─────────────────────────────────────────────────────────
create table if not exists public.billing_prices (
  key         text primary key,
  value       numeric not null,
  unit        text not null,              -- 'x' | 'KES' | 'USD'
  label       text not null,
  description text,
  sort        int  not null default 100,
  updated_at  timestamptz not null default now(),
  updated_by  text
);

insert into public.billing_prices (key, value, unit, label, description, sort) values
  ('ai_multiplier_default', 5, 'x',   'AI multiplier (standard runs)', 'Charged = OpenAI cost x this. Applies to every AI runner without its own multiplier.', 10),
  ('ai_multiplier_chat',    8, 'x',   'AI multiplier (chat AI)',       'Charged = OpenAI cost x this, for runners that use the chat multiplier.', 20),
  ('send_price_kes',      0.5, 'KES', 'Follow-up send price (per message)', 'Charged in KES per follow-up/campaign message sent. 0.50 = 1 KES per 2 messages.', 30)
on conflict (key) do nothing;

create table if not exists public.ai_model_prices (
  model                 text primary key,   -- 'default' is the fallback for unknown models
  input_per_1m_usd      numeric not null,
  cached_input_per_1m_usd numeric not null,
  output_per_1m_usd     numeric not null,
  updated_at            timestamptz not null default now()
);

-- Seed values: verify against https://openai.com/api/pricing and edit in admin if they differ.
insert into public.ai_model_prices (model, input_per_1m_usd, cached_input_per_1m_usd, output_per_1m_usd) values
  ('default',      0.40, 0.10,  1.60),
  ('gpt-4.1-mini', 0.40, 0.10,  1.60),
  ('gpt-4.1-nano', 0.10, 0.025, 0.40),
  ('gpt-4.1',      2.00, 0.50,  8.00),
  ('gpt-4o-mini',  0.15, 0.075, 0.60),
  ('gpt-4o',       2.50, 1.25, 10.00)
on conflict (model) do nothing;

-- ── Runner registry ─────────────────────────────────────────────────────────
-- A "runner" is anything that spends AI. Unknown runners are auto-registered on first
-- use (billed at the default multiplier) so a new runner is never free by accident.
create table if not exists public.billing_runners (
  runner_id       text primary key,
  label           text not null,          -- admin label
  user_label      text not null,          -- what the business sees
  multiplier_key  text references public.billing_prices(key) on update cascade,
  multiplier      numeric,                -- optional fixed override (wins over multiplier_key)
  is_active       boolean not null default true,
  auto_registered boolean not null default false,
  created_at      timestamptz not null default now()
);

insert into public.billing_runners (runner_id, label, user_label, multiplier_key) values
  ('enrichment_worker_local',          'Analyser (lead enrichment)',      'Lead analysis',            'ai_multiplier_default'),
  ('classifier_local',                 'Analyser (classifier)',           'Lead analysis',            'ai_multiplier_default'),
  ('persona_pack_generator',           'Persona pack generator',          'Persona pack',             'ai_multiplier_default'),
  ('follow_up_generator',              'Follow-up writer',                'Follow-up writing',        'ai_multiplier_default'),
  ('suggestion_rewriter',              'Campaign message rewriter',       'Follow-up writing',        'ai_multiplier_default'),
  ('conversation_summariser',          'Conversation summariser',         'Follow-up writing',        'ai_multiplier_default'),
  ('followup_qc',                      'Follow-up QC check',              'Follow-up writing',        'ai_multiplier_default'),
  ('consent_generator',                'Consent message writer',          'Follow-up writing',        'ai_multiplier_default'),
  ('lead_stage_classifier',            'Lead stage classifier',           'Lead tracking',            'ai_multiplier_default'),
  ('opt_in_classifier',                'Opt-in classifier',               'Lead tracking',            'ai_multiplier_default'),
  ('campaign_reply_intent_classifier', 'Campaign reply classifier',      'Lead tracking',            'ai_multiplier_default'),
  ('chat_ai',                          'Chat AI (Autochat)',              'Chat AI',                  'ai_multiplier_chat')
on conflict (runner_id) do nothing;

-- ── Ledger columns ──────────────────────────────────────────────────────────
alter table public.ai_usage_log
  add column if not exists cached_tokens   int     not null default 0,
  add column if not exists base_cost_usd   numeric,
  add column if not exists multiplier      numeric,
  add column if not exists billed_usd      numeric,   -- what the run costs the business
  add column if not exists charged_usd     numeric,   -- what was actually taken (0 for internal / empty balance)
  add column if not exists shortfall_usd   numeric not null default 0;

alter table public.balance_transactions
  add column if not exists currency text not null default 'USD',
  add column if not exists runner   text;

alter table public.business_balances
  add column if not exists lifetime_spent_kes numeric not null default 0;

do $$ begin
  alter table public.business_balances add constraint check_balance_kes_non_negative check (balance_kes >= 0);
exception when duplicate_object then null; end $$;

create index if not exists ai_usage_log_business_created_idx on public.ai_usage_log (business_id, created_at desc);
create index if not exists balance_transactions_business_created_idx on public.balance_transactions (business_id, created_at desc);

-- ── bill_ai_usage: the ONLY way AI spend is recorded ────────────────────────
create or replace function public.bill_ai_usage(
  p_business_id text, p_runner text, p_model text,
  p_prompt_tokens int, p_cached_tokens int, p_completion_tokens int,
  p_run_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
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

  -- Lock the balance row, take what is there (never below zero), remember any shortfall.
  select balance_usd into v_old from business_balances where business_id = p_business_id for update;
  v_new := v_old;
  if v_old is not null and coalesce(v_free,false) = false and v_billed > 0 then
    v_charged := least(v_old, v_billed);
    update business_balances
       set balance_usd = balance_usd - v_charged,
           lifetime_spent_usd = lifetime_spent_usd + v_charged,
           updated_at = now()
     where business_id = p_business_id
     returning balance_usd into v_new;
    insert into balance_transactions (business_id, amount, type, category, description, balance_after, currency, runner)
    values (p_business_id, -v_charged, 'debit', 'ai', p_runner, v_new, 'USD', p_runner);
  end if;

  insert into ai_usage_log (business_id, run_id, bot_id, model, input_type, prompt_tokens, completion_tokens, total_tokens,
                            estimated_cost_usd, cached_tokens, base_cost_usd, multiplier, billed_usd, charged_usd, shortfall_usd)
  values (p_business_id, coalesce(p_run_id, gen_random_uuid()), p_runner, coalesce(p_model,'unknown'), 'text', v_prompt, v_compl, v_prompt + v_compl,
          v_billed, v_cached, v_base, v_mult, v_billed, v_charged, greatest(0, v_billed - v_charged));

  return jsonb_build_object('ok', true, 'base_usd', v_base, 'multiplier', v_mult, 'billed_usd', v_billed,
                            'charged_usd', v_charged, 'balance_usd', v_new, 'internal', coalesce(v_free,false));
end $$;

-- ── bill_send: follow-up / campaign / consent sends, in KES ─────────────────
create or replace function public.bill_send(
  p_business_id text, p_count int default 1, p_reason text default 'followup_send', p_runner text default 'followup_send'
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_price   numeric := coalesce((select value from billing_prices where key = 'send_price_kes'), 0.5);
  v_amount  numeric := round(v_price * greatest(coalesce(p_count,1),0), 4);
  v_free    boolean;
  v_old     numeric;
  v_charged numeric := 0;
  v_new     numeric;
begin
  select (business_type = 'heysasa') into v_free from businesses where business_id = p_business_id;
  select balance_kes into v_old from business_balances where business_id = p_business_id for update;
  v_new := v_old;
  if v_old is not null and coalesce(v_free,false) = false and v_amount > 0 then
    v_charged := least(v_old, v_amount);
    update business_balances
       set balance_kes = balance_kes - v_charged,
           lifetime_spent_kes = lifetime_spent_kes + v_charged,
           updated_at = now()
     where business_id = p_business_id
     returning balance_kes into v_new;
  end if;
  -- Always write the ledger row (amount is what the send cost, even when internal / short)
  insert into balance_transactions (business_id, amount, type, category, description, balance_after, currency, runner)
  values (p_business_id, -v_amount, 'debit', 'send', p_reason, v_new, 'KES', p_runner);
  return jsonb_build_object('ok', true, 'price_kes', v_price, 'billed_kes', v_amount, 'charged_kes', v_charged,
                            'balance_kes', v_new, 'internal', coalesce(v_free,false));
end $$;

-- ── Admin overview: usage per business + totals ─────────────────────────────
create or replace function public.admin_billing_overview(p_since timestamptz default null)
returns jsonb language sql stable security definer set search_path = public as $$
with ai as (
  select business_id,
         count(*) calls,
         coalesce(sum(base_cost_usd),0)  base_usd,
         coalesce(sum(coalesce(billed_usd, estimated_cost_usd)),0) billed_usd,
         coalesce(sum(charged_usd),0)    charged_usd,
         coalesce(sum(shortfall_usd),0)  shortfall_usd,
         coalesce(sum(total_tokens),0)   tokens
    from ai_usage_log where p_since is null or created_at >= p_since group by business_id
), snd as (
  select business_id, count(*) sends, coalesce(sum(-amount),0) billed_kes
    from balance_transactions where category = 'send' and currency = 'KES' and (p_since is null or created_at >= p_since)
   group by business_id
), rn as (
  select business_id, jsonb_object_agg(bot_id, jsonb_build_object('calls', c, 'billed_usd', b, 'base_usd', bb)) runners
    from (select business_id, bot_id, count(*) c, sum(coalesce(billed_usd, estimated_cost_usd)) b, coalesce(sum(base_cost_usd),0) bb
            from ai_usage_log where p_since is null or created_at >= p_since group by business_id, bot_id) x
   group by business_id
), rows as (
  select b.business_id, b.name, b.business_type,
         coalesce(bb.balance_usd,0) balance_usd, coalesce(bb.balance_kes,0) balance_kes,
         coalesce(ai.calls,0) ai_calls, coalesce(ai.base_usd,0) ai_base_usd, coalesce(ai.billed_usd,0) ai_billed_usd,
         coalesce(ai.charged_usd,0) ai_charged_usd, coalesce(ai.shortfall_usd,0) ai_shortfall_usd, coalesce(ai.tokens,0) tokens,
         coalesce(snd.sends,0) sends, coalesce(snd.billed_kes,0) send_billed_kes,
         coalesce(rn.runners,'{}'::jsonb) runners
    from businesses b
    left join business_balances bb on bb.business_id = b.business_id
    left join ai  on ai.business_id  = b.business_id
    left join snd on snd.business_id = b.business_id
    left join rn  on rn.business_id  = b.business_id
)
select jsonb_build_object(
  'since', p_since,
  'totals', (select jsonb_build_object(
      'ai_calls', coalesce(sum(ai_calls),0), 'ai_base_usd', coalesce(sum(ai_base_usd),0),
      'ai_billed_usd', coalesce(sum(ai_billed_usd),0), 'ai_charged_usd', coalesce(sum(ai_charged_usd),0),
      'ai_shortfall_usd', coalesce(sum(ai_shortfall_usd),0), 'sends', coalesce(sum(sends),0),
      'send_billed_kes', coalesce(sum(send_billed_kes),0), 'balance_usd', coalesce(sum(balance_usd),0),
      'balance_kes', coalesce(sum(balance_kes),0)) from rows),
  'businesses', (select coalesce(jsonb_agg(to_jsonb(r) order by r.ai_billed_usd desc), '[]'::jsonb) from rows r),
  'runners', (select coalesce(jsonb_agg(jsonb_build_object('runner_id', runner_id, 'label', label, 'multiplier_key', multiplier_key,
              'multiplier', multiplier, 'auto_registered', auto_registered, 'is_active', is_active) order by auto_registered desc, runner_id), '[]'::jsonb)
              from billing_runners)
);
$$;

-- ── Owner overview: what a business sees on its Billing page ────────────────
create or replace function public.my_billing_overview(p_business_id text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_bal business_balances%rowtype; v_month timestamptz := date_trunc('month', now());
        v_price numeric := coalesce((select value from billing_prices where key = 'send_price_kes'), 0.5);
begin
  if p_business_id not in (select my_business_ids()) then raise exception 'not allowed'; end if;
  select * into v_bal from business_balances where business_id = p_business_id;
  return jsonb_build_object(
    'balance_usd', coalesce(v_bal.balance_usd,0), 'balance_kes', coalesce(v_bal.balance_kes,0),
    'lifetime_spent_usd', coalesce(v_bal.lifetime_spent_usd,0), 'lifetime_spent_kes', coalesce(v_bal.lifetime_spent_kes,0),
    'send_price_kes', v_price,
    'sends_remaining', case when v_price > 0 then floor(coalesce(v_bal.balance_kes,0) / v_price) else null end,
    'month_ai_usd', coalesce((select sum(coalesce(billed_usd, estimated_cost_usd)) from ai_usage_log where business_id = p_business_id and created_at >= v_month),0),
    'month_send_kes', coalesce((select sum(-amount) from balance_transactions where business_id = p_business_id and category = 'send' and currency = 'KES' and created_at >= v_month),0),
    'month_sends', (select count(*) from balance_transactions where business_id = p_business_id and category = 'send' and created_at >= v_month),
    'by_runner', coalesce((select jsonb_agg(jsonb_build_object('label', lbl, 'calls', c, 'usd', u) order by u desc)
        from (select coalesce(r.user_label,'AI usage') lbl, count(*) c, sum(coalesce(l.billed_usd, l.estimated_cost_usd)) u
                from ai_usage_log l left join billing_runners r on r.runner_id = l.bot_id
               where l.business_id = p_business_id and l.created_at >= v_month group by 1) t), '[]'::jsonb),
    'daily', coalesce((select jsonb_agg(jsonb_build_object('day', d, 'usd', usd, 'kes', kes) order by d)
        from (select g::date d,
                coalesce((select sum(coalesce(billed_usd, estimated_cost_usd)) from ai_usage_log where business_id = p_business_id and created_at::date = g::date),0) usd,
                coalesce((select sum(-amount) from balance_transactions where business_id = p_business_id and category = 'send' and currency = 'KES' and created_at::date = g::date),0) kes
                from generate_series(current_date - 29, current_date, interval '1 day') g) t), '[]'::jsonb),
    'recent', coalesce((select jsonb_agg(to_jsonb(t)) from (
        select created_at, type, category, currency, abs(amount) amount, description, balance_after, runner
          from balance_transactions where business_id = p_business_id order by created_at desc limit 40) t), '[]'::jsonb)
  );
end $$;

-- ── Access ──────────────────────────────────────────────────────────────────
alter table public.billing_prices   enable row level security;
alter table public.ai_model_prices  enable row level security;
alter table public.billing_runners  enable row level security;   -- no policies: service role only

revoke all on function public.bill_ai_usage(text,text,text,int,int,int,uuid) from public, anon, authenticated;
revoke all on function public.bill_send(text,int,text,text)                  from public, anon, authenticated;
revoke all on function public.admin_billing_overview(timestamptz)            from public, anon, authenticated;
grant execute on function public.bill_ai_usage(text,text,text,int,int,int,uuid) to service_role;
grant execute on function public.bill_send(text,int,text,text)                  to service_role;
grant execute on function public.admin_billing_overview(timestamptz)            to service_role;
revoke all on function public.my_billing_overview(text) from public, anon;
grant execute on function public.my_billing_overview(text) to authenticated;

-- ── Admin wallet credit / adjustment (USD for AI, KES for sends) ────────────
create or replace function public.admin_credit_wallet(p_business_id text, p_currency text, p_amount numeric, p_note text default 'admin credit')
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_new numeric;
begin
  if p_amount is null or p_amount = 0 then raise exception 'amount required'; end if;
  if p_currency not in ('USD','KES') then raise exception 'currency must be USD or KES'; end if;
  if p_currency = 'USD' then
    update business_balances set balance_usd = balance_usd + p_amount, updated_at = now()
     where business_id = p_business_id returning balance_usd into v_new;
  else
    update business_balances set balance_kes = balance_kes + p_amount, updated_at = now()
     where business_id = p_business_id returning balance_kes into v_new;
  end if;
  if not found then raise exception 'no wallet for business %', p_business_id; end if;
  insert into balance_transactions (business_id, amount, type, category, description, balance_after, currency)
  values (p_business_id, p_amount, case when p_amount > 0 then 'credit' else 'debit' end, 'adjustment', coalesce(p_note,'admin credit'), v_new, p_currency);
  return jsonb_build_object('ok', true, 'currency', p_currency, 'new_balance', v_new);
end $$;
revoke all on function public.admin_credit_wallet(text,text,numeric,text) from public, anon, authenticated;
grant execute on function public.admin_credit_wallet(text,text,numeric,text) to service_role;
