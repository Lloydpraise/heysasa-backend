insert into public.billing_runners (runner_id, label, user_label, multiplier_key) values
  ('product_discovery', 'Product discovery (text + images)', 'Product discovery', 'ai_multiplier_default'),
  ('chat_ai',           'Chat AI (Autochat)',                'Chat AI',           'ai_multiplier_chat')
on conflict (runner_id) do nothing;
