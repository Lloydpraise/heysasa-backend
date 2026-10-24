// Ask HeySasa spend goes through the same bill_ai_usage function as every other AI runner. The runner id
// `business_assistant` is registered by the migration, so its multiplier can be changed in /admin without code.
// The brain bills after EVERY model response (tool-loop rounds included) and after every embedding.

import { billAiUsage } from '../services/aiBilling.js';

export const ASSISTANT_RUNNER = 'business_assistant';

// The HeySasa business itself (business_type 'heysasa') is never charged, like the chat AI.
// accountId: an account on separate billing spends from its own wallet (account_balances; ACCOUNTS.md "Billing").
export async function canAffordAssistant(supabase, businessId, accountId = null) {
  const [{ data: bal }, { data: biz }, account] = await Promise.all([
    supabase.from('business_balances').select('balance_usd').eq('business_id', businessId).maybeSingle(),
    supabase.from('businesses').select('business_type').eq('business_id', businessId).maybeSingle(),
    accountId ? supabase.from('accounts').select('billing_mode').eq('id', accountId).maybeSingle().then((r) => r.data, () => null) : null,
  ]);
  if (biz?.business_type === 'heysasa') return true;
  if (account?.billing_mode === 'separate') {
    const { data: own } = await supabase.from('account_balances').select('balance_usd').eq('account_id', accountId).maybeSingle();
    return !!own && Number(own.balance_usd) > 0;
  }
  return !!bal && Number(bal.balance_usd) > 0;
}

// The Responses API reports input_tokens / output_tokens; billAiUsage wants prompt/cached/completion.
export function billModelUsage(supabase, { businessId, accountId = null, model, usage = {}, runId = null }) {
  return billAiUsage(supabase, {
    businessId, accountId, runner: ASSISTANT_RUNNER, model, runId,
    promptTokens: usage.input_tokens || 0,
    cachedTokens: usage.input_tokens_details?.cached_tokens || 0,
    completionTokens: usage.output_tokens || 0,
  });
}

export function billEmbeddingUsage(supabase, { businessId, accountId = null, model, promptTokens }) {
  return billAiUsage(supabase, { businessId, accountId, runner: ASSISTANT_RUNNER, model, promptTokens, cachedTokens: 0, completionTokens: 0 });
}
