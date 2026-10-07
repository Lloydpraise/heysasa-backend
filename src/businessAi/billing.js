// Ask HeySasa spend goes through the same bill_ai_usage function as every other AI runner. The runner id
// `business_assistant` is registered by the migration, so its multiplier can be changed in /admin without code.
// The brain bills after EVERY model response (tool-loop rounds included) and after every embedding.

import { billAiUsage } from '../services/aiBilling.js';

export const ASSISTANT_RUNNER = 'business_assistant';

// The HeySasa business itself (business_type 'heysasa') is never charged, like the chat AI.
export async function canAffordAssistant(supabase, businessId) {
  const [{ data: bal }, { data: biz }] = await Promise.all([
    supabase.from('business_balances').select('balance_usd').eq('business_id', businessId).maybeSingle(),
    supabase.from('businesses').select('business_type').eq('business_id', businessId).maybeSingle(),
  ]);
  if (biz?.business_type === 'heysasa') return true;
  return !!bal && Number(bal.balance_usd) > 0;
}

// The Responses API reports input_tokens / output_tokens; billAiUsage wants prompt/cached/completion.
export function billModelUsage(supabase, { businessId, model, usage = {}, runId = null }) {
  return billAiUsage(supabase, {
    businessId, runner: ASSISTANT_RUNNER, model, runId,
    promptTokens: usage.input_tokens || 0,
    cachedTokens: usage.input_tokens_details?.cached_tokens || 0,
    completionTokens: usage.output_tokens || 0,
  });
}

export function billEmbeddingUsage(supabase, { businessId, model, promptTokens }) {
  return billAiUsage(supabase, { businessId, runner: ASSISTANT_RUNNER, model, promptTokens, cachedTokens: 0, completionTokens: 0 });
}
