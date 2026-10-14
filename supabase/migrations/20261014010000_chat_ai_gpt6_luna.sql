-- Chat AI (sasa-brain) moves from gpt-5-mini to gpt-6-luna (medium reasoning, standard tier).
-- Only the chat AI changes. Follow-up AI, Ask HeySasa, the analyser and the persona pack keep their own models.
--
-- ROLLBACK (one line each, safe to run any time):
--   update public.businesses set chat_ai_model = 'gpt-5-mini' where chat_ai_model = 'gpt-6-luna';
--   alter table public.businesses alter column chat_ai_model set default 'gpt-5-mini';

-- 1. Price, so bill_ai_usage charges the real rate instead of falling back to the 'default' row.
--    Source: OpenAI pricing page, GPT-6 Luna, Standard tier, short context (USD per 1M tokens). Verify in admin if it changes.
do $$
begin
  if to_regclass('public.ai_model_prices') is not null then
    insert into public.ai_model_prices (model, input_per_1m_usd, cached_input_per_1m_usd, output_per_1m_usd) values
      ('gpt-6-luna', 0.10, 0.01, 0.50)
    on conflict (model) do update set
      input_per_1m_usd        = excluded.input_per_1m_usd,
      cached_input_per_1m_usd = excluded.cached_input_per_1m_usd,
      output_per_1m_usd       = excluded.output_per_1m_usd;
  end if;
end $$;

-- 2. New businesses get it by default.
alter table public.businesses alter column chat_ai_model set default 'gpt-6-luna';

-- 3. Existing businesses. Only rows still on the old default are moved; anyone set to a different model is left alone.
update public.businesses set chat_ai_model = 'gpt-6-luna' where chat_ai_model = 'gpt-5-mini';
