// Sends the messages for website events (business_events, written by the backend's Events API, see EVENTS_API.md).
//
// It goes through the SAME built-in antiban as follow-ups (antiban.js): the minimum gap with jitter, the hourly ceiling and
// the cool-down after connection failures all count per WhatsApp number, and follow-ups and events share them because
// they share the number. A number never seen before is checked on WhatsApp first (numberCheck.js), with its own pacing.
// What events do NOT follow: the follow-up daily cap, the reply hold and the follow-up switch. A receipt the customer
// is waiting for is owed whatever the follow-up settings say. Quiet hours apply only to events whose template says so
// (abandoned-cart reminders by default, never receipts).
//
// One pass: due rows are grouped by number (the account, or the business for rows without one). Each number gets at
// most one send attempt per pass, because after an attempt the antiban gap is closed anyway. The pass returns when the
// next thing becomes possible (gap over, quiet hours end, the next delayed event), so run.js can sleep until then.
import { supabase as defaultSupabase } from '../supabaseClient.js'
import { getContact, getBusinessForAccount } from '../lib/db.js'
import { accountSendState } from '../lib/accounts.js'
import { resolveSendTarget } from '../lib/sendTarget.js'
import { ensureNumberOnWhatsApp } from '../lib/numberCheck.js'
import { checkSendBalance, billSend } from '../lib/billing.js'
import { decideRetry } from '../lib/sendFailures.js'
import { isBusinessAwake } from '../lib/timing.js'
import { nextAwakeAt } from '../lib/wakeTimes.js'
import { sendContentViaEvolution } from './evolutionSender.js'
import { checkAntiban, primeAntiban, recordSend, recordFailedAttempt, reserveSend } from './antiban.js'
import { log } from '../lib/log.js'
import { ANTIBAN_MIN_GAP_MS } from '../config.js'

const BATCH = 100
const MAX_AGE_MS = 48 * 3_600_000          // an event not sent within two days is dropped: a late receipt confuses more than it helps
const STALE_CLAIM_MS = 2 * 60_000
const STALE_SWEEP_EVERY_MS = 5 * 60_000
const NOT_CONNECTED_RETRY_MS = 5 * 60_000
const NO_BALANCE_RETRY_MS = 10 * 60_000
const SUBSCRIPTION_RETRY_MS = 30 * 60_000
const WAKE_PAD_MS = 250

let lastSweepAt = 0

// The antiban key for a row: the same key the follow-up sender uses for that number (worker.js buildLanes).
export const eventLaneKey = (row) => row.account_id ? `acct:${row.account_id}` : String(row.business_id)

export function resetEventSenderState() { lastSweepAt = 0 }

export async function processEventBatch(deps = {}) {
  const s = deps.supabase ?? defaultSupabase
  const send = deps.send ?? sendContentViaEvolution
  const loadContact = deps.getContact ?? getContact
  const loadBusiness = deps.getBusiness ?? getBusinessForAccount
  const accountState = deps.accountSendState ?? accountSendState
  const numberCheck = deps.ensureNumber ?? ensureNumberOnWhatsApp
  const canPay = deps.checkSendBalance ?? checkSendBalance
  const bill = deps.billSend ?? billSend
  const clock = deps.now ?? Date.now
  const result = { sent: 0, failed: 0, wakeAt: null }
  const wake = (at) => { if (Number.isFinite(at) && (result.wakeAt === null || at < result.wakeAt)) result.wakeAt = at }

  // A row left in "sending" (the process died mid-send) is failed, never re-sent: we cannot know whether it went out.
  if (clock() - lastSweepAt >= STALE_SWEEP_EVERY_MS) {
    lastSweepAt = clock()
    await s.from('business_events').update({ status: 'failed', last_error: 'stale_sending_claim' })
      .eq('status', 'sending').lte('claimed_at', new Date(clock() - STALE_CLAIM_MS).toISOString())
  }

  const nowIso = new Date(clock()).toISOString()
  const { data: due, error } = await s.from('business_events').select('*')
    .eq('status', 'scheduled').lte('send_at', nowIso)
    .order('send_at', { ascending: true }).limit(BATCH)
  if (error) throw error

  const finish = async (row, status, reason, extra = {}) => {
    await s.from('business_events').update({ status, last_error: reason, ...extra }).eq('id', row.id).in('status', ['scheduled', 'sending'])
    if (status === 'failed') result.failed++
    log(status === 'failed' ? 'warn' : 'info', 'sender', `events.${status}`, `Website event ${row.event_type} ${status}: ${reason}`, {
      business_id: row.business_id, contact_id: row.contact_id, entity_id: row.id, details: { reason, eventType: row.event_type },
    })
  }
  const later = async (row, delayMs, reason) => {
    const at = clock() + delayMs
    await s.from('business_events').update({ send_at: new Date(at).toISOString(), last_error: reason }).eq('id', row.id).eq('status', 'scheduled')
    wake(at + WAKE_PAD_MS)
  }

  // 'next' = look at the following row of this number; 'stop' = this number is done for this pass.
  async function processRow(row) {
    if (clock() - Date.parse(row.created_at) > MAX_AGE_MS) { await finish(row, 'failed', 'expired'); return 'next' }

    const contact = row.contact_id ? await loadContact(s, row.contact_id) : null
    if (!contact || String(contact.business_id) !== String(row.business_id)) { await finish(row, 'failed', 'contact_not_found'); return 'next' }
    if (contact.do_not_contact === true) { await finish(row, 'skipped', 'do_not_contact'); return 'next' }
    // The shopper wrote to the business after leaving the cart: the conversation (and the chat AI) has it now.
    if (row.event_type === 'cart.abandoned' && contact.last_inbound_at && Date.parse(contact.last_inbound_at) > Date.parse(row.created_at)) {
      await finish(row, 'skipped', 'customer_replied'); return 'next'
    }
    const target = resolveSendTarget(contact, contact.country_code)
    if (!target) { await finish(row, 'failed', 'no_send_target'); return 'next' }

    let instance = null
    if (row.account_id) {
      const route = await accountState(s, row.account_id)
      if (route.ok) instance = route.instance
    } else {
      const { data: sessions } = await s.from('whatsapp_sessions').select('instance_name')
        .eq('business_id', row.business_id).eq('status', 'connected').order('updated_at', { ascending: false }).limit(1)
      instance = sessions?.[0]?.instance_name ?? null
    }
    if (!instance) { await later(row, NOT_CONNECTED_RETRY_MS, 'whatsapp_not_connected'); return 'stop' }

    const business = await loadBusiness(s, row.business_id, row.account_id ?? null)
    if (!business) { await finish(row, 'failed', 'business_not_found'); return 'next' }
    if (business.subscription_active === false) { await later(row, SUBSCRIPTION_RETRY_MS, 'subscription_inactive'); return 'stop' }
    if (row.respect_quiet_hours && !isBusinessAwake(business, new Date(clock()))) {
      const at = nextAwakeAt(business, clock())
      await later(row, Math.max(60_000, at - clock()), 'quiet_hours')
      return 'next'   // a receipt behind it may still go now
    }

    // The built-in antiban, shared with follow-ups on this number.
    const key = eventLaneKey(row)
    await primeAntiban(s, key, { businessId: row.business_id, accountId: row.account_id ?? null })
    const gate = checkAntiban(key, business.followup_daily_cap)
    if (!gate.allowed) { wake(clock() + gate.retryAfterMs + WAKE_PAD_MS); return 'stop' }

    // Someone who never wrote to this number is looked up on WhatsApp first (paced, and asked only once).
    if (target.kind === 'phone' && !contact.last_inbound_at) {
      const check = await numberCheck(s, { instanceName: instance, contact, businessId: row.business_id })
      if (check.status === 'wait') { wake(clock() + (check.retryAfterMs ?? 60_000) + WAKE_PAD_MS); return 'stop' }
      if (check.status === 'not_on_whatsapp') { await finish(row, 'failed', 'number_not_on_whatsapp', { failure_class: 'not_on_whatsapp' }); return 'next' }
    }

    if (!(await canPay(s, row.business_id, row.account_id ?? null))) { await later(row, NO_BALANCE_RETRY_MS, 'insufficient_balance'); return 'stop' }

    const { data: claimed } = await s.from('business_events')
      .update({ status: 'sending', claimed_at: new Date(clock()).toISOString() })
      .eq('id', row.id).eq('status', 'scheduled').select('id').maybeSingle()
    if (!claimed) return 'next'   // cancelled by a purchase, or taken by another pass

    reserveSend(key)
    const sent = await send(instance, target.number, { text: row.message }, contact.country_code)
    const attempts = (row.attempts ?? 0) + 1

    if (!sent?.ok) {
      const errorText = String(sent?.error ?? 'send_failed').slice(0, 300)
      const decision = decideRetry(errorText, attempts)
      recordFailedAttempt(key, decision.failureClass)
      if (decision.giveUp) {
        await finish(row, 'failed', errorText, { attempts, failure_class: decision.failureClass })
      } else {
        const at = clock() + decision.retryInMs
        await s.from('business_events').update({
          status: 'scheduled', send_at: new Date(at).toISOString(), attempts: decision.countsAttempt === false ? row.attempts ?? 0 : attempts,
          last_error: errorText, failure_class: decision.failureClass,
        }).eq('id', row.id)
        wake(at + WAKE_PAD_MS)
      }
      return 'stop'
    }

    recordSend(key)
    const sentAt = new Date(clock()).toISOString()
    const withAccount = row.account_id ? { account_id: row.account_id } : {}
    // The message is saved under its own agent_role so the chat AI and the dashboards can tell it from the owner's
    // own messages and from follow-ups; if the customer answers, the chat AI sees it in the history.
    const [, saved] = await Promise.all([
      s.from('business_events').update({ status: 'sent', sent_at: sentAt, attempts, whatsapp_message_id: sent.messageId ?? null, last_error: null }).eq('id', row.id),
      sent.messageId && row.conversation_id
        ? s.from('messages').upsert({
            business_id: row.business_id, ...withAccount, conversation_id: row.conversation_id, contact_id: row.contact_id,
            whatsapp_message_id: sent.messageId, direction: 'out', role: 'ai', agent_role: 'events_api',
            type: 'text', content: { text: row.message, type: 'text', event_type: row.event_type }, status: 'sent', created_at: sentAt,
          }, { onConflict: 'whatsapp_message_id', ignoreDuplicates: false })
        : Promise.resolve({ error: null }),
      bill(s, row.business_id, { reason: `event_${row.event_type}`, runner: 'event_send', accountId: row.account_id ?? null }),
    ])
    if (saved?.error) log('error', 'sender', 'events.message_save_failed', `Sent, but could not save the message: ${saved.error.message}`, { business_id: row.business_id, entity_id: row.id })
    result.sent++
    log('ok', 'sender', 'events.sent', `Website event ${row.event_type} sent to ${target.label}`, {
      business_id: row.business_id, contact_id: row.contact_id, entity_id: row.id, details: { instance, eventType: row.event_type, whatsappMessageId: sent.messageId ?? null },
    })
    return 'stop'
  }

  const lanes = new Map()
  for (const row of due ?? []) {
    const key = eventLaneKey(row)
    if (!lanes.has(key)) lanes.set(key, [])
    lanes.get(key).push(row)
  }
  for (const rows of lanes.values()) {
    for (const [i, row] of rows.entries()) {
      try {
        if ((await processRow(row)) === 'stop') {
          // More events wait on this number: look again once the shortest antiban gap can be over.
          if (i < rows.length - 1) wake(clock() + ANTIBAN_MIN_GAP_MS + WAKE_PAD_MS)
          break
        }
      } catch (e) {
        log('error', 'sender', 'events.unexpected_error', `Website event ${row.id} failed: ${e.message}`, { business_id: row.business_id, entity_id: row.id, details: { error: e.message } })
        await later(row, 5 * 60_000, `unexpected: ${String(e.message).slice(0, 150)}`).catch(() => {})
        break
      }
    }
  }

  // The next delayed event (a cart reminder an hour out): one timer instead of polling.
  const { data: next } = await s.from('business_events').select('send_at')
    .eq('status', 'scheduled').gt('send_at', new Date(clock()).toISOString())
    .order('send_at', { ascending: true }).limit(1)
  if (next?.[0]?.send_at) wake(Date.parse(next[0].send_at) + WAKE_PAD_MS)
  return result
}
