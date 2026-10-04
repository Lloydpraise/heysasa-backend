// Decides whether the chat AI may answer an incoming customer message, and if so hands the turn to the brain.
// Phase 1 ships the gates, the daily cap and the per-chat lock. The brain (phase 2) plugs in through `brain`.
// With no brain installed this does nothing visible, even for a business that has switched the AI on.

import { evaluateMessageGates, evaluateChatGates, SKIP_MESSAGES } from './gates.js';

// Only reasons the owner would want to know about get a row in chat_ai_turns. Everything else is routine.
const LOGGED_SKIPS = new Set(['cap_reached']);

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

      const outcome = await brain({ businessId, conversationId, contactId, message, business, ...chat, slot, mode: 'live' });
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
