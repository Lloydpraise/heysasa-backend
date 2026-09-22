import { SENDER_POLL_INTERVAL_MS } from '../config.js'
import { processBaileysBatch } from './worker.js'
import { log } from '../lib/log.js'

let running = false

async function tick() {
  if (running) return // don't overlap if a batch is still processing
  running = true
  try {
    await processBaileysBatch()
    log('debug', 'sender', 'sender.heartbeat', 'Sender tick ok', { details: { ok: true } })
  } catch (e) {
    console.error(`[Sender] Tick error: ${e.message}`)
    log('error', 'sender', 'sender.tick_error', `Sender tick failed: ${e.message}`, { details: { error: { name: e.name, message: e.message } } })
  } finally {
    running = false
  }
}

console.log(`[Sender-Baileys] Starting — polling every ${SENDER_POLL_INTERVAL_MS}ms`)
log('info', 'sender', 'sender.loop_started', `Sender starting — polling every ${SENDER_POLL_INTERVAL_MS}ms`, { details: { intervalMs: SENDER_POLL_INTERVAL_MS } })
tick()
setInterval(tick, SENDER_POLL_INTERVAL_MS)