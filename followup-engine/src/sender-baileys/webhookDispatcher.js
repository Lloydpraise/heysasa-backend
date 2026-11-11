// Posts webhook_deliveries to the caller's webhook (Messages API, MESSAGES_API.md): sent, delivered, read, failed,
// replied, opted out. The rows are written by database triggers (20261109000000_messages_api_webhooks.sql); this only
// delivers them. Woken by a realtime INSERT and by one timer for the next retry, like the event sender: no polling.
//
// Every call is signed so the receiver can trust it:
//   X-Heysasa-Timestamp: <unix seconds>
//   X-Heysasa-Signature: v1=<hex HMAC-SHA256 of "<timestamp>.<raw body>" with the key's webhook secret>
// A 2xx answer means delivered. Anything else is retried with back-off for about a day, then marked failed.
import { createHmac } from 'node:crypto'
import { supabase as defaultSupabase } from '../supabaseClient.js'
import { log } from '../lib/log.js'

const BATCH = 50
const TIMEOUT_MS = 10_000
const CLAIM_MS = 2 * 60_000          // a claimed row is retried after this if the process dies mid-call
export const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000, 3 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000]
const WAKE_PAD_MS = 250

export function signWebhook(secret, timestamp, rawBody) {
  return createHmac('sha256', String(secret)).update(`${timestamp}.${rawBody}`).digest('hex')
}

export async function processWebhookBatch(deps = {}) {
  const s = deps.supabase ?? defaultSupabase
  const post = deps.fetch ?? fetch
  const clock = deps.now ?? Date.now
  const result = { delivered: 0, failed: 0, wakeAt: null }
  const wake = (at) => { if (Number.isFinite(at) && (result.wakeAt === null || at < result.wakeAt)) result.wakeAt = at }

  const nowIso = new Date(clock()).toISOString()
  const { data: due, error } = await s.from('webhook_deliveries')
    .select('id, business_id, api_key_id, kind, payload, attempts, api_keys(webhook_url, webhook_secret, revoked_at)')
    .eq('status', 'pending').lte('next_attempt_at', nowIso)
    .order('next_attempt_at', { ascending: true }).limit(BATCH)
  if (error) throw error

  for (const row of due ?? []) {
    const key = row.api_keys ?? {}
    if (key.revoked_at || !key.webhook_url || !key.webhook_secret) {
      await s.from('webhook_deliveries').update({ status: 'failed', last_error: key.revoked_at ? 'api_key_revoked' : 'no_webhook' }).eq('id', row.id)
      continue
    }
    const attempts = (row.attempts ?? 0) + 1
    // claim: only one pass posts a row; a crash leaves it to come back after CLAIM_MS
    const { data: claimed } = await s.from('webhook_deliveries')
      .update({ attempts, next_attempt_at: new Date(clock() + CLAIM_MS).toISOString() })
      .eq('id', row.id).eq('status', 'pending').eq('attempts', row.attempts ?? 0).select('id').maybeSingle()
    if (!claimed) continue

    const rawBody = JSON.stringify({ ...row.payload, delivery_id: row.id })
    const timestamp = Math.floor(clock() / 1000)
    let status = 0
    let errorText = null
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
      const res = await post(key.webhook_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'HeySasa-Webhooks/1',
          'X-Heysasa-Event': row.kind,
          'X-Heysasa-Delivery': row.id,
          'X-Heysasa-Timestamp': String(timestamp),
          'X-Heysasa-Signature': `v1=${signWebhook(key.webhook_secret, timestamp, rawBody)}`,
        },
        body: rawBody,
        signal: controller.signal,
      })
      clearTimeout(timer)
      status = res.status
      if (!res.ok) errorText = `${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`
    } catch (e) {
      errorText = e.name === 'AbortError' ? 'timeout' : String(e.message || e).slice(0, 200)
    }

    if (!errorText) {
      await s.from('webhook_deliveries').update({ status: 'delivered', delivered_at: new Date(clock()).toISOString(), response_status: status, last_error: null }).eq('id', row.id)
      result.delivered++
      continue
    }
    const delay = RETRY_DELAYS_MS[attempts - 1]
    if (delay === undefined) {
      await s.from('webhook_deliveries').update({ status: 'failed', response_status: status || null, last_error: errorText }).eq('id', row.id)
      result.failed++
      log('warn', 'sender', 'webhooks.gave_up', `Webhook ${row.kind} could not be delivered after ${attempts} tries: ${errorText}`, { business_id: row.business_id, entity_id: row.id })
    } else {
      const at = clock() + delay
      await s.from('webhook_deliveries').update({ next_attempt_at: new Date(at).toISOString(), response_status: status || null, last_error: errorText }).eq('id', row.id)
      wake(at + WAKE_PAD_MS)
    }
  }

  const { data: next } = await s.from('webhook_deliveries').select('next_attempt_at')
    .eq('status', 'pending').gt('next_attempt_at', new Date(clock()).toISOString())
    .order('next_attempt_at', { ascending: true }).limit(1)
  if (next?.[0]?.next_attempt_at) wake(Date.parse(next[0].next_attempt_at) + WAKE_PAD_MS)
  if ((due?.length ?? 0) >= BATCH) wake(clock())
  return result
}
