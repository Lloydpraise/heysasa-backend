// Sends what the chat AI (the sasa-brain edge function) put in chat_ai_outbox.
//
// It shares the Evolution connection, the session lookup, the phone/LID target rules and sendContentViaEvolution
// with follow-ups, but it is a separate lane:
//   - its own pacing (a few seconds between messages, not the 20-65 seconds campaigns use)
//   - its own counter (rows of chat_ai_outbox): nothing here touches follow_up_queue, the follow-up daily limit,
//     the new-number warm-up or the follow-up antiban timers, so the two can never count or hold each other back
//   - a hard hourly ceiling per business
// Each message is claimed before it is sent and is never retried: the brain is waiting for the answer and tells
// the AI honestly whether the customer saw it.
//
// How a pass works: the queued messages are grouped by business, and each business is its own lane. Lanes run side by
// side, so one business sleeping between messages never holds up another. Inside a lane the messages go out in the order
// they were queued, with a gap between them: a short one when the next message is in the same chat as the last (product
// photos, then the written reply), the longer one when it is for a different customer.

import { supabase as defaultSupabase } from '../supabaseClient.js'
import { getContact } from '../lib/db.js'
import { resolveSendTarget } from '../lib/sendTarget.js'
import { sendContentViaEvolution } from './evolutionSender.js'
import { log } from '../lib/log.js'
import {
  CHAT_AI_MIN_GAP_MS, CHAT_AI_GAP_JITTER_MS, CHAT_AI_SAME_CHAT_GAP_MS, CHAT_AI_SAME_CHAT_JITTER_MS,
  CHAT_AI_HOURLY_CEILING, CHAT_AI_STALE_CLAIM_MS, CHAT_AI_STALE_SWEEP_MS,
} from '../config.js'

const BATCH = 30
const HOUR_MS = 60 * 60_000

const lastSent = new Map()        // business_id -> { at: ms, conversationId }
const hourCache = new Map()       // business_id -> { count, at }
const activeLanes = new Set()     // business ids whose lane is running right now
let lastSweepAt = 0

// How long "typing..." shows before a message appears: longer text, longer typing. Capped at 5 seconds.
export function typingDelayMs(text, rand = Math.random) {
  const length = Math.min(String(text ?? '').length, 160)
  return Math.min(5000, Math.round(700 + length * 30 + rand() * 600))
}

export function messageKind(item) {
  return item.kind === 'image' && item.media?.url ? 'image' : 'text'
}

async function sentInLastHour(s, businessId, now) {
  const hit = hourCache.get(businessId)
  if (hit && now - hit.at < 15_000) return hit.count
  const { count, error } = await s.from('chat_ai_outbox')
    .select('id', { count: 'exact', head: true })
    .eq('business_id', businessId).eq('status', 'sent')
    .gte('sent_at', new Date(now - HOUR_MS).toISOString())
  if (error) throw error
  hourCache.set(businessId, { count: count ?? 0, at: now })
  return count ?? 0
}

export function resetChatAiLaneState() {
  lastSent.clear()
  hourCache.clear()
  activeLanes.clear()
  lastSweepAt = 0
}

export async function processChatAiOutbox(deps = {}) {
  const s = deps.supabase ?? defaultSupabase
  const send = deps.send ?? sendContentViaEvolution
  const loadContact = deps.getContact ?? getContact
  const clock = deps.now ?? Date.now
  const rand = deps.rand ?? Math.random
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const result = { sent: 0, failed: 0 }

  // A message stuck in "sending" (the process died mid-send) is failed, not re-sent: we cannot know whether the
  // customer got it, and the AI has stopped waiting. The sweep runs only on startup/reconnect or an outbox insert.
  if (clock() - lastSweepAt >= CHAT_AI_STALE_SWEEP_MS) {
    lastSweepAt = clock()
    const { error: sweepError } = await s.from('chat_ai_outbox')
      .update({ status: 'failed', error: 'stale_sending_claim' })
      .eq('status', 'sending')
      .lte('claimed_at', new Date(clock() - CHAT_AI_STALE_CLAIM_MS).toISOString())
    if (sweepError) throw sweepError
  }

  const { data: queued, error } = await s.from('chat_ai_outbox')
    .select('*').eq('status', 'queued')
    .order('created_at', { ascending: true }).order('seq', { ascending: true }).limit(BATCH)
  if (error) {
    log('error', 'sender', 'chat_ai.fetch_failed', `Could not read the chat AI outbox: ${error.message}`, { details: { error: error.message } })
    throw error
  }

  const fail = async (item, reason, extra = {}) => {
    await s.from('chat_ai_outbox').update({ status: 'failed', error: reason, attempts: (item.attempts ?? 0) + 1 }).eq('id', item.id).in('status', ['queued', 'sending'])
    result.failed++
    log('warn', 'sender', 'chat_ai.send_failed', `Chat AI message not sent: ${reason}`, { business_id: item.business_id, contact_id: item.contact_id, entity_id: item.id, details: { reason, ...extra } })
  }

  async function runLane(items) {
    for (const item of items) {
      try {
        // Pacing for this business's chat AI lane.
        const last = lastSent.get(item.business_id)
        if (last) {
          const sameChat = last.conversationId === item.conversation_id
          const gap = sameChat
            ? CHAT_AI_SAME_CHAT_GAP_MS + Math.floor(rand() * CHAT_AI_SAME_CHAT_JITTER_MS)
            : CHAT_AI_MIN_GAP_MS + Math.floor(rand() * CHAT_AI_GAP_JITTER_MS)
          const wait = gap - (clock() - last.at)
          if (wait > 0) await sleep(wait)
        }
        const now = clock()

        if ((await sentInLastHour(s, item.business_id, now)) >= CHAT_AI_HOURLY_CEILING) {
          await fail(item, 'chat_ai_hourly_limit')
          continue
        }

        const contact = await loadContact(s, item.contact_id)
        if (!contact || String(contact.business_id) !== String(item.business_id)) { await fail(item, 'contact_not_found'); continue }
        if (contact.do_not_contact === true) { await fail(item, 'do_not_contact'); continue }
        const target = resolveSendTarget(contact, contact.country_code)
        if (!target) { await fail(item, 'no_send_target'); continue }

        const { data: sessions } = await s.from('whatsapp_sessions')
          .select('instance_name').eq('business_id', item.business_id).eq('status', 'connected')
          .order('updated_at', { ascending: false }).limit(1)
        const instance = sessions?.[0]?.instance_name
        if (!instance) { await fail(item, 'whatsapp_not_connected'); continue }

        const { data: claimed } = await s.from('chat_ai_outbox')
          .update({ status: 'sending', claimed_at: new Date(clock()).toISOString() })
          .eq('id', item.id).eq('status', 'queued').select('id').maybeSingle()
        if (!claimed) continue   // the brain cancelled it (timed out) or another sender took it

        const kind = messageKind(item)
        const text = kind === 'image' ? (item.media?.caption ?? '') : (item.text ?? '')
        const content = kind === 'image'
          ? { text, media: { type: 'image', url: item.media.url, caption: text, mime_type: item.media.mime_type, file_name: item.media.file_name } }
          : { text }
        content.delay = typingDelayMs(text, rand)

        const startedAt = clock()
        const sent = await send(instance, target.number, content, contact.country_code)
        if (!sent?.ok) { await fail(item, String(sent?.error ?? 'send_failed').slice(0, 300), { instance }); continue }

        const sentAt = new Date(clock()).toISOString()
        lastSent.set(item.business_id, { at: clock(), conversationId: item.conversation_id })
        const cached = hourCache.get(item.business_id)
        if (cached) cached.count += 1

        // Both writes happen together: the brain is waiting on the first one, and the second does not depend on it.
        // The message is saved under its own agent_role so the owner-took-over check and the dashboards can tell it apart
        // from the owner's own messages and from follow-ups. The webhook echo of this message keeps that label.
        const markSent = s.from('chat_ai_outbox').update({ status: 'sent', sent_at: sentAt, whatsapp_message_id: sent.messageId ?? null, attempts: (item.attempts ?? 0) + 1 }).eq('id', item.id)
        const saveMessage = sent.messageId
          ? (async () => {
              const { error: messageError } = await s.from('messages').upsert({
                business_id: item.business_id, conversation_id: item.conversation_id, contact_id: item.contact_id,
                whatsapp_message_id: sent.messageId, direction: 'out', role: 'ai', agent_role: 'chat_ai',
                type: kind, content: kind === 'image' ? { text, type: 'image', url: item.media.url } : { text, type: 'text' },
                status: 'sent', created_at: sentAt,
              }, { onConflict: 'whatsapp_message_id', ignoreDuplicates: false })
              if (messageError) log('error', 'sender', 'chat_ai.message_save_failed', `Sent, but could not save the message: ${messageError.message}`, { business_id: item.business_id, entity_id: item.id, details: { error: messageError.message } })
            })()
          : null
        await Promise.all([markSent, saveMessage])

        result.sent++
        log('ok', 'sender', 'chat_ai.sent', `Chat AI ${kind} sent to ${target.label}`, {
          business_id: item.business_id, contact_id: item.contact_id, entity_id: item.id,
          duration_ms: clock() - startedAt, details: { instance, targetKind: target.kind, whatsappMessageId: sent.messageId ?? null },
        })
      } catch (e) {
        await fail(item, String(e.message ?? e).slice(0, 300)).catch(() => {})
      }
    }
  }

  // One lane per business, started side by side. A business whose lane is still running from an earlier pass is left alone:
  // its waiting messages are picked up by the next pass once the lane is done.
  const lanes = new Map()
  for (const item of queued ?? []) {
    if (!lanes.has(item.business_id)) lanes.set(item.business_id, [])
    lanes.get(item.business_id).push(item)
  }
  const runs = []
  for (const [businessId, items] of lanes) {
    if (activeLanes.has(businessId)) continue
    activeLanes.add(businessId)
    runs.push(
      runLane(items)
        .catch((e) => log('error', 'sender', 'chat_ai.lane_error', `Chat AI lane failed: ${e.message}`, { business_id: businessId, details: { error: e.message } }))
        .finally(() => activeLanes.delete(businessId)),
    )
  }
  await Promise.all(runs)
  return result
}
