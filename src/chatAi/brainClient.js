// Calls the sasa-brain edge function for one customer message.

export function createBrainCaller({ url, serviceKey, fetchFn = fetch, timeoutMs = 75_000, log = () => {} }) {
  return async function callBrain({ businessId, conversationId, contactId, message }) {
    if (!url || !serviceKey) throw new Error('SUPABASE_URL or the service key is missing, so the chat AI brain cannot be called');
    const startedAt = Date.now();
    log('info', 'Chat AI', 'Calling the chat brain (sasa-brain)', { businessId, conversationId, messageId: message.keyId || null });
    let res;
    try {
      res = await fetchFn(`${url.replace(/\/+$/, '')}/functions/v1/sasa-brain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceKey}` },
        body: JSON.stringify({ business_id: businessId, conversation_id: conversationId, contact_id: contactId, trigger_message_id: message.keyId || null }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      const reason = timedOut ? `The chat brain did not answer within ${Math.round(timeoutMs / 1000)} seconds (sasa-brain is stuck or not deployed)` : `Could not reach the chat brain: ${e.message}`;
      log('error', 'Chat AI', reason, { businessId, conversationId, ms: Date.now() - startedAt });
      throw new Error(reason);
    }
    const body = await res.json().catch(() => null);
    const ms = Date.now() - startedAt;
    if (!res.ok) {
      log('error', 'Chat AI', `The chat brain returned HTTP ${res.status}`, { businessId, conversationId, ms, error: String(body?.error ?? '').slice(0, 300) });
      throw new Error(`sasa-brain returned ${res.status}: ${String(body?.error ?? '').slice(0, 200)}`);
    }
    log(body?.status === 'error' ? 'error' : 'ok', 'Chat AI', `The chat brain finished: ${body?.status ?? 'no status'}${body?.skip_reason ? ` (${body.skip_reason})` : ''}`, { businessId, conversationId, ms, status: body?.status ?? null, skip_reason: body?.skip_reason ?? null, handoff: body?.handoff ?? null, error: body?.error ?? null });
    return { replied: body?.status === 'replied' || body?.status === 'handoff', brain_status: body?.status ?? null, skip_reason: body?.skip_reason ?? null, handoff: body?.handoff ?? null, error: body?.error ?? null };
  };
}
