// Billing hook for the chat AI brain. Chat AI is billed at the chat multiplier (default 8x OpenAI cost),
// set by the `chat_ai` runner in billing_runners, so changing it in /admin needs no code.
//
// Brain contract: call canAffordChatAi() before the model call, and billChatAiUsage() after EVERY model
// response (tool-loop steps and retries included), passing the usage block OpenAI returned.

import { billAiUsage } from '../services/aiBilling.js';

export const CHAT_AI_RUNNER = 'chat_ai';

export async function canAffordChatAi(supabase, businessId) {
  const [{ data: bal }, { data: biz }] = await Promise.all([
    supabase.from('business_balances').select('balance_usd').eq('business_id', businessId).maybeSingle(),
    supabase.from('businesses').select('business_type').eq('business_id', businessId).maybeSingle(),
  ]);
  if (biz?.business_type === 'heysasa') return true;
  return !!bal && Number(bal.balance_usd) > 0;
}

export function billChatAiUsage(supabase, { businessId, model, usage = {}, runId = null }) {
  return billAiUsage(supabase, {
    businessId, runner: CHAT_AI_RUNNER, model, runId,
    promptTokens: usage.prompt_tokens || 0,
    cachedTokens: usage.prompt_tokens_details?.cached_tokens || 0,
    completionTokens: usage.completion_tokens || 0,
  });
}
