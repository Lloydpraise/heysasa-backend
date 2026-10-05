// Calls the sasa-brain edge function for one customer message.

export function createBrainCaller({ url, serviceKey, fetchFn = fetch, timeoutMs = 170_000 }) {
  return async function callBrain({ businessId, conversationId, contactId, message }) {
    if (!url || !serviceKey) throw new Error('SUPABASE_URL or the service key is missing, so the chat AI brain cannot be called');
    const res = await fetchFn(`${url.replace(/\/+$/, '')}/functions/v1/sasa-brain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceKey}` },
      body: JSON.stringify({ business_id: businessId, conversation_id: conversationId, contact_id: contactId, trigger_message_id: message.keyId || null }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`sasa-brain returned ${res.status}: ${String(body?.error ?? '').slice(0, 200)}`);
    return { replied: body?.status === 'replied' || body?.status === 'handoff', brain_status: body?.status ?? null, skip_reason: body?.skip_reason ?? null, handoff: body?.handoff ?? null, error: body?.error ?? null };
  };
}
