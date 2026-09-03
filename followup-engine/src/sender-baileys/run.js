import { SENDER_POLL_INTERVAL_MS } from '../config.js'
import { processBaileysBatch } from './worker.js'

let running = false

async function tick() {
  if (running) return // don't overlap if a batch is still processing
  running = true
  try {
    await processBaileysBatch()
  } catch (e) {
    console.error(`[Sender] Tick error: ${e.message}`)
  } finally {
    running = false
  }
}

console.log(`[Sender-Baileys] Starting — polling every ${SENDER_POLL_INTERVAL_MS}ms`)
tick()
setInterval(tick, SENDER_POLL_INTERVAL_MS)