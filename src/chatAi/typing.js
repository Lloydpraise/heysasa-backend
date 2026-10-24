// Shows "typing..." on the customer's WhatsApp while the chat AI is working out its reply, so the customer sees someone is on it
// from the first second. (The sender adds a short typing time right before the message lands; this covers the thinking time before it.)
// Best effort only: it never throws and never slows or blocks the reply. If Evolution refuses it, a warning is logged and the reply goes on.

import { EVOLUTION_URL, EVOLUTION_API_KEY } from '../config/evolution.js';

const SENDABLE_JID = /^\d+@(lid|s\.whatsapp\.net)$/;
const INSTANCE_CACHE_MS = 60_000;
const BACK_OFF_MS = 5 * 60_000;      // after the endpoint says it does not exist, stop asking for a while

export function createTyping({ supabase, fetchFn = fetch, evolutionUrl = EVOLUTION_URL, apiKey = EVOLUTION_API_KEY, log = () => {}, now = () => Date.now() }) {
  const instances = new Map();       // accountId (or businessId for a business without accounts) -> { name, at }
  let backOffUntil = 0;

  // The account's own WhatsApp connection. Only a business from before accounts (no account id) falls back to any
  // connected session of the business.
  async function instanceFor(businessId, accountId) {
    const key = accountId || `business:${businessId}`;
    const hit = instances.get(key);
    if (hit && now() - hit.at < INSTANCE_CACHE_MS) return hit.name;
    let name = null;
    if (accountId) {
      const { data } = await supabase.from('accounts').select('instance_name, status').eq('id', accountId).maybeSingle();
      name = data?.status === 'connected' ? data.instance_name || null : null;
    } else {
      const { data } = await supabase.from('whatsapp_sessions').select('instance_name').eq('business_id', businessId).eq('status', 'connected').limit(1);
      name = data?.[0]?.instance_name || null;
    }
    instances.set(key, { name, at: now() });
    return name;
  }

  async function present(businessId, jid, presence, delayMs, accountId = null) {
    try {
      if (!jid || !SENDABLE_JID.test(String(jid)) || now() < backOffUntil) return false;
      const instance = await instanceFor(businessId, accountId);
      if (!instance) return false;
      // Both body shapes are sent, because Evolution versions differ on where "presence" and "delay" go.
      const body = { number: jid, presence, delay: delayMs, options: { presence, delay: delayMs, number: jid } };
      const res = await fetchFn(`${String(evolutionUrl).replace(/\/+$/, '')}/chat/sendPresence/${encodeURIComponent(instance)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) {
        if (res.status === 404) backOffUntil = now() + BACK_OFF_MS;
        log('warn', 'Chat AI', `Could not show typing on WhatsApp (Evolution answered ${res.status})`, { businessId, instance, presence });
        return false;
      }
      return true;
    } catch (e) {
      log('warn', 'Chat AI', `Could not show typing on WhatsApp: ${e.message}`, { businessId, presence });
      return false;
    }
  }

  return {
    // "typing..." for up to 10 seconds (WhatsApp clears it by itself), or until stop() is called.
    start: (businessId, jid, accountId = null) => present(businessId, jid, 'composing', 10_000, accountId),
    stop: (businessId, jid, accountId = null) => present(businessId, jid, 'paused', 0, accountId),
  };
}
