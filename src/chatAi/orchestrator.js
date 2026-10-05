// Decides whether the chat AI may answer an incoming customer message, and if so hands the turn to the brain.
// Phase 1 ships the gates, the daily cap and the per-chat lock. The brain (phase 2) plugs in through `brain`.
// With no brain installed this does nothing visible, even for a business that has switched the AI on.

import { evaluateMessageGates, evaluateChatGates, SKIP_MESSAGES } from './gates.js';

// Only reasons the owner would want to know about get a row in chat_ai_turns. Everything else is routine.
const LOGGED_SKIPS = new Set(['cap_reached']);
const MAX_EXTRA_RUNS = 2;

export function createOrchestrator({ store, brain = null, log = () => {}, now = () => new Date() }) {
  return async function handleInboundMessage(input) {
    const { businessId, conversationId, contactId, message } = input;
    const skip = (reason, extra = {}) => ({ status: 'skipped', reason, detail: SKIP_MESSAGES[reason], ...extra });

    const business = await store.loadBusiness(businessId);
    const first = evaluateMessageGates({ message, business, now: now() });
    if (!first.allow) return skip(first.reason);

    const chat = await store.loadChat(conversationId, contactId);
    const second = evaluateChatGates({ ...chat, business, now: now() });
    if (!second.allow) return skip(second.reason);

    // Nothing below this line runs until a brain exists, so no lock or daily slot is wasted.
    if (!brain) return skip('no_brain');

    if (!(await store.canAfford(businessId))) return skip('no_balance');

    const token = await store.acquireLock(conversationId);
    if (!token) return skip('chat_busy');

    try {
      const slot = await store.claimSlot(businessId, conversationId, business.chat_ai_daily_cap);
      if (!slot?.allowed) {
        const result = skip('cap_reached', { used: slot?.used, cap: slot?.cap });
        if (LOGGED_SKIPS.has('cap_reached')) {
          await store.logTurn({
            business_id: businessId, conversation_id: conversationId, contact_id: contactId,
            trigger_message_id: message.keyId || null, mode: 'live', status: 'skipped', skip_reason: 'cap_reached',
            input: { text: message.text, used: slot?.used, cap: slot?.cap },
          }).catch((e) => log('error', 'Chat AI', 'Could not log a skipped turn', { error: e.message }));
        }
        return result;
      }

      // A message that arrives while this turn runs is skipped as 'chat_busy' (its row is saved, but nobody answers it).
      // The brain re-checks before it sends; this catches the last gap, after the brain's final check. Up to 2 extra runs.
      let current = message;
      let outcome;
      for (let run = 0; ; run++) {
        const startedAt = now().toISOString();
        outcome = await brain({ businessId, conversationId, contactId, message: current, business, ...chat, slot, mode: 'live' });
        if (run >= MAX_EXTRA_RUNS) break;
        const waiting = await store.unansweredInboundSince(conversationId, startedAt);
        if (!waiting) break;
        current = { ...current, keyId: waiting.keyId, text: waiting.text, type: waiting.type, sentAt: now() };
      }
      return { status: 'handled', ...outcome };
    } catch (error) {
      await store.logTurn({
        business_id: businessId, conversation_id: conversationId, contact_id: contactId,
        trigger_message_id: message.keyId || null, mode: 'live', status: 'error', error: String(error.message || error).slice(0, 500),
        input: { text: message.text },
      }).catch(() => {});
      throw error;
    } finally {
      await store.releaseLock(conversationId, token).catch((e) => log('error', 'Chat AI', 'Could not release the chat lock (it expires on its own)', { error: e.message }));
    }
  };
}
