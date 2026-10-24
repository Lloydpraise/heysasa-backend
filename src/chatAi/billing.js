// Billing hook for the chat AI brain. Chat AI is billed at the chat multiplier (default 8x OpenAI cost),
// set by the `chat_ai` runner in billing_runners, so changing it in /admin needs no code.
//
// Brain contract: call canAffordChatAi() before the model call, and billChatAiUsage() after EVERY model
// response (tool-loop steps and retries included), passing the usage block OpenAI returned.

import { billAiUsage } from '../services/aiBilling.js';

export const CHAT_AI_RUNNER = 'chat_ai';

// The wallet an account spends from: its own (account_balances) on separate billing, else the business's.
// With no account (a business from before accounts) it is always the business wallet.
export async function canAffordChatAi(supabase, businessId, accountId = null) {
  const [{ data: biz }, { data: account }] = await Promise.all([
    supabase.from('businesses').select('business_type').eq('business_id', businessId).maybeSingle(),
    accountId ? supabase.from('accounts').select('billing_mode').eq('id', accountId).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  if (biz?.business_type === 'heysasa') return true;
  const { data: bal } = account?.billing_mode === 'separate'
    ? await supabase.from('account_balances').select('balance_usd').eq('account_id', accountId).maybeSingle()
    : await supabase.from('business_balances').select('balance_usd').eq('business_id', businessId).maybeSingle();
  return !!bal && Number(bal.balance_usd) > 0;
}

export function billChatAiUsage(supabase, { businessId, accountId = null, model, usage = {}, runId = null }) {
  return billAiUsage(supabase, {
    businessId, accountId, runner: CHAT_AI_RUNNER, model, runId,
    promptTokens: usage.prompt_tokens || 0,
    cachedTokens: usage.prompt_tokens_details?.cached_tokens || 0,
    completionTokens: usage.completion_tokens || 0,
  });
}
