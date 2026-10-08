import { SENDER_POLL_INTERVAL_MS, CHAT_AI_POLL_INTERVAL_MS } from '../config.js'
import { processBaileysBatch } from './worker.js'
import { processChatAiOutbox } from './chatAiOutbox.js'
import { log } from '../lib/log.js'

let running = false

async function tick() {
  if (running) return // don't overlap if a batch is still processing
  running = true
  try {
    await processBaileysBatch()
    log('debug', 'sender', 'sender.heartbeat', 'Sender tick ok', { details: { ok: true } })
  } catch (e) {
    log('error', 'sender', 'sender.tick_error', `Sender tick failed: ${e.message}`, { details: { error: { name: e.name, message: e.message } } })
  } finally {
    running = false
  }
}

log('info', 'sender', 'sender.loop_started', `Sender starting — polling every ${SENDER_POLL_INTERVAL_MS}ms`, { details: { intervalMs: SENDER_POLL_INTERVAL_MS } })
tick()
setInterval(tick, SENDER_POLL_INTERVAL_MS)

// The chat AI lane has its own loop so a slow campaign batch never delays a reply to a waiting customer.
// Ticks may overlap on purpose: processChatAiOutbox runs one lane per business and skips a business whose lane is still
// busy, so a business sending several messages never holds up the next tick for the others.
async function chatAiTick() {
  try {
    await processChatAiOutbox()
  } catch (e) {
    log('error', 'sender', 'chat_ai.tick_error', `Chat AI sender tick failed: ${e.message}`, { details: { error: { name: e.name, message: e.message } } })
  }
}
setInterval(chatAiTick, CHAT_AI_POLL_INTERVAL_MS)
