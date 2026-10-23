import { processBaileysBatch, recoverStaleClaims } from './worker.js'
import { processChatAiOutbox } from './chatAiOutbox.js'
import { log } from '../lib/log.js'
import { supabase } from '../supabaseClient.js'
import { isAnalysisActive, onAnalysisFinished, deferUntilAnalysisEnds } from '../lib/analysisGate.js'

const RETRY_WHEN_BLOCKED_MS = 60_000
const CHAT_AI_RETRY_MS = 60_000
const HEARTBEAT_MS = 180_000
let senderDrain
let senderWakePending = false
let senderWakeTimer = null
let senderWakeAt = 0
let chatAiRetryTimer = null

function scheduleSenderWake(at) {
  if (!Number.isFinite(at)) return
  if (senderWakeTimer && at >= senderWakeAt) return
  clearTimeout(senderWakeTimer)
  senderWakeAt = at
  senderWakeTimer = setTimeout(() => {
    senderWakeTimer = null
    senderWakeAt = 0
    void wakeSender()
  }, Math.max(0, at - Date.now()))
}

async function scheduleNextDue() {
  const now = new Date().toISOString()
  const { data, error } = await supabase.from('follow_up_queue')
    .select('scheduled_at')
    .eq('status', 'ready_to_send')
    .eq('channel', 'baileys')
    .gt('scheduled_at', now)
    .order('scheduled_at', { ascending: true })
    .limit(1)
  if (error) throw error
  if (data?.[0]?.scheduled_at) scheduleSenderWake(Date.parse(data[0].scheduled_at))
  else if (senderWakeTimer) {
    clearTimeout(senderWakeTimer)
    senderWakeTimer = null
    senderWakeAt = 0
  }
}

// Realtime events wake the sender, but a burst (every send updates follow_up_queue; the analyser rewrites
// contacts in bulk) must not mean a database round-trip per event. Event wake-ups are limited to one per gap with
// one trailing wake so nothing is missed. Timers (scheduled sends, retries) still call wakeSender() directly.
const SENDER_QUEUE_GAP_MS = parseInt(process.env.SENDER_QUEUE_EVENT_GAP_MS ?? '2000')
const SENDER_OTHER_GAP_MS = parseInt(process.env.SENDER_OTHER_EVENT_GAP_MS ?? '10000')
const SENDER_CONTACT_GAP_MS = parseInt(process.env.SENDER_CONTACT_EVENT_GAP_MS ?? '15000')
const lastEventWake = new Map()
const trailingWake = new Map()

function wakeSenderFromEvent(source, gapMs) {
  const wait = (lastEventWake.get(source) ?? 0) + gapMs - Date.now()
  if (wait <= 0 && !trailingWake.has(source)) {
    lastEventWake.set(source, Date.now())
    void wakeSender()
    return
  }
  if (trailingWake.has(source)) return
  trailingWake.set(source, setTimeout(() => {
    trailingWake.delete(source)
    lastEventWake.set(source, Date.now())
    void wakeSender()
  }, Math.max(0, wait)))
}

async function onContactEvent() {
  if (await isAnalysisActive()) {
    deferUntilAnalysisEnds()
    return
  }
  wakeSenderFromEvent('contacts', SENDER_CONTACT_GAP_MS)
}
onAnalysisFinished(() => wakeSender())

function wakeSender() {
  senderWakePending = true
  if (senderDrain) return senderDrain
  senderDrain = (async () => {
    try {
      let result
      do {
        senderWakePending = false
        result = await processBaileysBatch()
      } while (senderWakePending)
      // The batch says when something becomes possible again (antiban gap over, lookup slot, daily cap reset, end of quiet hours).
      if (result.wakeAt) scheduleSenderWake(result.wakeAt)
      if (result.retryNeeded) scheduleSenderWake(Date.now() + RETRY_WHEN_BLOCKED_MS)
      await scheduleNextDue()
    } catch (e) {
      log('error', 'sender', 'sender.tick_error', `Sender event failed: ${e.message}`, { details: { error: { name: e.name, message: e.message } } })
      scheduleSenderWake(Date.now() + RETRY_WHEN_BLOCKED_MS)
    } finally {
      senderDrain = null
      if (senderWakePending) void wakeSender()
    }
  })()
  return senderDrain
}

// Safety net: a dropped realtime channel or a missed timer must not leave queued messages stranded.
setInterval(() => {
  void (async () => {
    try { await recoverStaleClaims() } catch { /* logged inside */ }
    void wakeSender()
  })()
}, HEARTBEAT_MS).unref()

log('info', 'sender', 'sender.started', 'Follow-up sender listening for queue and eligibility changes')

// Outbox inserts wake the Chat AI sender. A drain on (re)connection recovers rows
// queued while this process was offline, without polling Supabase while idle.
let chatAiDrain
let chatAiWakePending = false
function wakeChatAiSender() {
  if (chatAiRetryTimer) {
    clearTimeout(chatAiRetryTimer)
    chatAiRetryTimer = null
  }
  chatAiWakePending = true
  if (chatAiDrain) return chatAiDrain
  chatAiDrain = (async () => {
    try {
      let result
      do {
        chatAiWakePending = false
        result = await processChatAiOutbox()
      } while (chatAiWakePending || result.sent + result.failed >= 30)
    } catch (e) {
      log('error', 'sender', 'chat_ai.tick_error', `Chat AI sender failed: ${e.message}`, { details: { error: { name: e.name, message: e.message } } })
      if (!chatAiRetryTimer) {
        chatAiRetryTimer = setTimeout(() => {
          chatAiRetryTimer = null
          void wakeChatAiSender()
        }, CHAT_AI_RETRY_MS)
      }
    } finally {
      chatAiDrain = null
      if (chatAiWakePending) void wakeChatAiSender()
    }
  })()
  return chatAiDrain
}

const chatAiChannel = supabase
  .channel('chat-ai-outbox-sender')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_ai_outbox' }, wakeChatAiSender)
  .subscribe((status, error) => {
    if (status === 'SUBSCRIBED') {
      void wakeChatAiSender()
      log('info', 'sender', 'chat_ai.realtime_connected', 'Chat AI sender listening for queued messages')
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      log('error', 'sender', 'chat_ai.realtime_disconnected', `Chat AI outbox notifications unavailable: ${status}`, { details: { error: error?.message ?? null } })
    }
  })

const senderChannel = supabase
  .channel('follow-up-sender-events')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'follow_up_queue' }, () => wakeSenderFromEvent('queue', SENDER_QUEUE_GAP_MS))
  .on('postgres_changes', { event: '*', schema: 'public', table: 'whatsapp_sessions' }, () => wakeSenderFromEvent('sessions', SENDER_OTHER_GAP_MS))
  .on('postgres_changes', { event: '*', schema: 'public', table: 'campaigns' }, () => wakeSenderFromEvent('campaigns', SENDER_OTHER_GAP_MS))
  .on('postgres_changes', { event: '*', schema: 'public', table: 'businesses' }, () => wakeSenderFromEvent('businesses', SENDER_OTHER_GAP_MS))
  .on('postgres_changes', { event: '*', schema: 'public', table: 'contacts' }, () => { void onContactEvent() })
  .subscribe((status, error) => {
    if (status === 'SUBSCRIBED') {
      void (async () => {
        try {
          await recoverStaleClaims()
          await wakeSender()
        } catch (e) {
          log('error', 'sender', 'sender.startup_recovery_failed', `Could not recover sender work: ${e.message}`, { details: { error: { name: e.name, message: e.message } } })
          scheduleSenderWake(Date.now() + RETRY_WHEN_BLOCKED_MS)
        }
      })()
      log('info', 'sender', 'sender.realtime_connected', 'Follow-up sender listening for database changes')
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      log('error', 'sender', 'sender.realtime_disconnected', `Follow-up sender notifications unavailable: ${status}`, { details: { error: error?.message ?? null } })
    }
  })
