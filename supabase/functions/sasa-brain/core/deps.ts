// Connects the turn to the real world: Supabase, OpenAI and the outbox. index.ts calls buildDeps once per request,
// because where messages go (this chat) and whether anything is really sent (simulation) depend on the request.

import type { TurnContext, TurnDeps, TurnInput } from './turn.ts';
import type { SendItem, SendResult } from './builtin.ts';
import { loadContext } from './context.ts';
import { enqueueAndWait } from './outbox.ts';
import { makeCallModel, makeEmbed } from './openai.ts';

export type RuntimeDeps = {
  // deno-lint-ignore no-explicit-any
  db: any; openaiKey: string; fetch: typeof fetch; sleep: (ms: number) => Promise<void>; toolSecret?: string;
};

const HOLDING_INSTRUCTIONS = `You write one very short WhatsApp line (at most 12 words) for a sales rep who is checking something and needs a moment.
Rules: say you are checking or pulling it up. No greeting. No question. No facts, no prices, no promises about time. Same language as the customer. Plain text, no quotes.`;

export const BILLING_RUNNER = 'chat_ai';

export function buildDeps(rt: RuntimeDeps, request: TurnInput): TurnDeps {
  const openai = { apiKey: rt.openaiKey, fetch: rt.fetch, sleep: rt.sleep };
  const turnId = crypto.randomUUID();

  // Every OpenAI response is billed to the business through bill_ai_usage (runner 'chat_ai', priced and multiplied
  // from the admin settings), including tool-loop steps, rewrites, the holding message and embeddings. The turn id is the
  // run id, so one customer message's spend is one group in the usage log. Billing never blocks a reply: a failure is
  // logged loudly with the numbers so it can be re-billed by hand.
  let base = 0;
  let billed = 0;
  const bill = async (model: string, promptTokens: number, cachedTokens: number, completionTokens: number) => {
    let lastError = 'unknown';
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { data, error } = await rt.db.rpc('bill_ai_usage', {
        p_business_id: request.business_id, p_runner: BILLING_RUNNER, p_model: model || 'default',
        p_prompt_tokens: Math.round(promptTokens), p_cached_tokens: Math.round(cachedTokens), p_completion_tokens: Math.round(completionTokens), p_run_id: turnId,
      });
      if (!error) { base += Number(data?.base_usd ?? 0); billed += Number(data?.billed_usd ?? 0); return; }
      lastError = error.message;
      if (attempt < 3) await rt.sleep(400 * attempt);
    }
    console.error(`[billing] FAILED to bill chat AI usage business=${request.business_id} model=${model} prompt=${promptTokens} cached=${cachedTokens} completion=${completionTokens}: ${lastError}`);
  };
  const pendingBills: Array<Promise<void>> = [];
  const track = (promise: Promise<void>) => { pendingBills.push(promise.catch(() => {})); };

  const rawCallModel = makeCallModel(openai);
  // deno-lint-ignore no-explicit-any
  const callModel = async (body: Record<string, any>) => {
    const res = await rawCallModel(body);
    const u = res?.usage ?? {};
    await bill(String(body.model), Number(u.input_tokens ?? 0), Number(u.input_tokens_details?.cached_tokens ?? 0), Number(u.output_tokens ?? 0)).catch(() => {});
    return res;
  };
  const embed = makeEmbed(openai, (model, tokens) => track(bill(model, tokens, 0, 0)));

  const send = async (items: SendItem[]): Promise<SendResult> => {
    const input = request;
    if (input.simulate) {
      // Nothing is sent in simulation. The caller sees what would have gone out in the turn log.
      return { ok: true, results: items.map(() => ({ ok: true, messageId: null })) };
    }
    if (!input.conversation_id || !input.contact_id) return { ok: false, error: 'missing conversation or contact' };
    return enqueueAndWait(rt.db, { businessId: input.business_id, conversationId: input.conversation_id, contactId: input.contact_id }, items, { sleep: rt.sleep });
  };

  return {
    turnId,
    spend: () => ({ base, billed }),
    async canAfford(businessId: string) {
      // Same rule as the backend gate: an empty wallet pauses the AI; HeySasa's own business is never charged.
      const [{ data: bal }, { data: biz }] = await Promise.all([
        rt.db.from('business_balances').select('balance_usd').eq('business_id', businessId).maybeSingle(),
        rt.db.from('businesses').select('business_type').eq('business_id', businessId).maybeSingle(),
      ]);
      if (biz?.business_type === 'heysasa') return true;
      return Boolean(bal) && Number(bal.balance_usd) > 0;
    },
    loadContext: (input) => loadContext(rt.db, input),
    callModel,
    tools: { db: rt.db, embed, fetch: rt.fetch, toolSecret: rt.toolSecret },
    send,
    sleep: rt.sleep,

    async hasNewerInbound(input: TurnInput) {
      if (!input.conversation_id || !input.trigger_message_id) return false;
      const { data: trigger } = await rt.db.from('messages').select('created_at').eq('whatsapp_message_id', input.trigger_message_id).maybeSingle();
      if (!trigger?.created_at) return false;
      const { data } = await rt.db.from('messages').select('id').eq('conversation_id', input.conversation_id).eq('direction', 'in')
        .gt('created_at', trigger.created_at).neq('type', 'reaction').limit(1);
      return Boolean(data?.length);
    },

    async holdingMessage(ctx: TurnContext, lastCustomerText: string) {
      const persona = ctx.persona as Record<string, unknown> | null;
      const voice = typeof persona?.persona === 'string' ? persona.persona : persona?.persona ? JSON.stringify(persona.persona) : '';
      const res = await callModel({
        model: ctx.settings.holdingModel, store: false, max_output_tokens: 60,
        instructions: `${HOLDING_INSTRUCTIONS}${voice ? `\nVoice of the business: ${voice.slice(0, 500)}` : ''}`,
        input: [{ role: 'user', content: `Customer wrote: "${lastCustomerText.slice(0, 300)}"` }],
      });
      const text = (res?.output ?? []).flatMap((o: { type: string; content?: Array<{ type: string; text?: string }> }) => o.type === 'message' ? (o.content ?? []) : [])
        .map((c: { type: string; text?: string }) => (c.type === 'output_text' ? c.text : '')).join('').trim().replace(/^["']|["']$/g, '');
      return text && text.length <= 120 ? text : null;
    },

    async recordHandoff(input: TurnInput, reason: string, summary: string) {
      if (!input.conversation_id) return;
      await rt.db.from('conversations').update({
        handover_flag: true, handover_reason: reason, handover_urgency: 'normal', handover_summary: summary,
        handover_at: new Date().toISOString(), handover_source: 'rule', handover_resolved_at: null,
      }).eq('id', input.conversation_id);
    },

    async rememberFlow(input: TurnInput, flowId: string) {
      if (!input.conversation_id) return;
      await rt.db.from('conversations').update({ chat_ai_flow_id: flowId }).eq('id', input.conversation_id);
    },

    async logTurn(row: Record<string, unknown>) {
      await Promise.all(pendingBills);   // embedding bills run beside the turn; settle them so the logged cost is complete
      await rt.db.from('chat_ai_turns').insert({ ...row, cost_usd: base || row.cost_usd || null });
    },
  };
}
