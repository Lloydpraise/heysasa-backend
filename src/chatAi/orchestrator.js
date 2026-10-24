// Decides whether the chat AI may answer an incoming customer message, and if so hands the turn to the brain.
// Phase 1 ships the gates, the daily cap and the per-chat lock. The brain (phase 2) plugs in through `brain`.
// With no brain installed this does nothing visible, even for a business that has switched the AI on.

import { evaluateMessageGates, evaluateChatGates, SKIP_MESSAGES } from './gates.js';

// Only reasons the owner would want to know about get a row in chat_ai_turns. Everything else is routine.
const LOGGED_SKIPS = new Set(['cap_reached']);
// Skips that are normal for every message (chat off, your own messages, groups) are not written to the debug console, or it would fill with noise.
const QUIET_SKIPS = new Set(['switch_off', 'from_me', 'group_or_broadcast']);
const MAX_EXTRA_RUNS = 2;

// Typing is a nicety: whatever it does, even throwing or rejecting, must never reach the reply or crash the process.
const quietly = (fn) => { try { Promise.resolve(fn()).catch(() => {}); } catch { /* ignored on purpose */ } };

export function createOrchestrator({ store, brain = null, typing = null, log = () => {}, now = () => new Date() }) {
  return async function handleInboundMessage(input) {
    const { businessId, conversationId, contactId, message } = input;
    // The WhatsApp number (account) this chat belongs to. The webhook passes it; older callers get it from the conversation.
    const accountId = input.accountId || (store.accountIdFor ? await store.accountIdFor(conversationId) : null) || null;
    const skip = (reason, extra = {}) => {
      if (!QUIET_SKIPS.has(reason)) log(reason === 'no_balance' || reason === 'cap_reached' ? 'warn' : 'info', 'Chat AI', `Chat AI did not answer: ${SKIP_MESSAGES[reason] || reason}`, { businessId, accountId, conversationId, reason, messageId: message?.keyId || null, ...extra });
      return { status: 'skipped', reason, detail: SKIP_MESSAGES[reason], ...extra };
    };

    const business = await store.loadBusiness(businessId, accountId);
    const first = evaluateMessageGates({ message, business, now: now() });
    if (!first.allow) return skip(first.reason);

    const chat = await store.loadChat(conversationId, contactId, accountId);
    const second = evaluateChatGates({ ...chat, business, now: now() });
    if (!second.allow) return skip(second.reason);

    // Nothing below this line runs until a brain exists, so no lock or daily slot is wasted.
    if (!brain) return skip('no_brain');

    if (!(await store.canAfford(businessId, accountId))) return skip('no_balance');

    const token = await store.acquireLock(conversationId);
    if (!token) return skip('chat_busy');

    try {
      const slot = await store.claimSlot(businessId, conversationId, business.chat_ai_daily_cap);
      if (!slot?.allowed) {
        const result = skip('cap_reached', { used: slot?.used, cap: slot?.cap });
        if (LOGGED_SKIPS.has('cap_reached')) {
          await store.logTurn({
            business_id: businessId, account_id: accountId, conversation_id: conversationId, contact_id: contactId,
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
        // The customer sees typing while the AI works. Fire and forget: it must never slow or break the reply.
        quietly(() => typing?.start(businessId, current.jid || message.jid, accountId));
        outcome = await brain({ businessId, accountId, conversationId, contactId, message: current, business, ...chat, slot, mode: 'live' });
        if (!outcome?.replied) quietly(() => typing?.stop(businessId, current.jid || message.jid, accountId));   // nothing was sent: clear the typing indicator
        if (run >= MAX_EXTRA_RUNS) break;
        const waiting = await store.unansweredInboundSince(conversationId, startedAt, accountId);
        if (!waiting) break;
        current = { ...current, keyId: waiting.keyId, text: waiting.text, type: waiting.type, sentAt: now() };
      }
      return { status: 'handled', ...outcome };
    } catch (error) {
      quietly(() => typing?.stop(businessId, message.jid, accountId));
      await store.logTurn({
        business_id: businessId, account_id: accountId, conversation_id: conversationId, contact_id: contactId,
        trigger_message_id: message.keyId || null, mode: 'live', status: 'error', error: String(error.message || error).slice(0, 500),
        input: { text: message.text },
      }).catch(() => {});
      throw error;
    } finally {
      await store.releaseLock(conversationId, token).catch((e) => log('error', 'Chat AI', 'Could not release the chat lock (it expires on its own)', { error: e.message }));
    }
  };
}
