import { DEFAULT_DAILY_CAP } from '../config.js'
import { getDailyCount } from './db.js'
import { log } from './log.js'

// Slow start for new numbers. A brand-new WhatsApp connection that sends at full
// speed gets flagged, so a business's first week of sending is held to a lower
// daily limit. "First week" runs from the business's very first sent message, so
// businesses that have been sending for a while are not affected at all.
const WARMUP = [
  { untilDay: 3, cap: 15 },   // days 1-3
  { untilDay: 7, cap: 25 },   // days 4-7
]
const DAY_MS = 86_400_000

const firstSendCache = new Map()   // business_id -> { first: ms | null, checked: ms }
const countCache = new Map()       // business_id -> { count, at }
const lastLogged = new Map()

async function firstSendAt(s, businessId) {
  const hit = firstSendCache.get(businessId)
  // A real first-send time never changes, so it is kept for good; "never sent" is re-checked every minute.
  if (hit && (hit.first !== null || Date.now() - hit.checked < 60_000)) return hit.first
  const { data, error } = await s.from('follow_up_queue')
    .select('processed_at').eq('business_id', businessId).eq('status', 'sent')
    .order('processed_at', { ascending: true }).limit(1)
  if (error) return hit?.first ?? null
  const first = data?.[0]?.processed_at ? new Date(data[0].processed_at).getTime() : null
  firstSendCache.set(businessId, { first, checked: Date.now() })
  return first
}

// Returns { cap, warmupActive, day }. Once the first week is over, cap is just the
// business's own daily cap and warmupActive is false.
export async function effectiveDailyCap(s, businessId, businessCap) {
  const base = businessCap ?? DEFAULT_DAILY_CAP
  const first = await firstSendAt(s, businessId)
  const day = first === null ? 1 : Math.floor((Date.now() - first) / DAY_MS) + 1
  const step = WARMUP.find(w => day <= w.untilDay)
  if (!step) return { cap: base, warmupActive: false, day }
  return { cap: Math.min(base, step.cap), warmupActive: true, day }
}

// Sent-today count, refreshed from the database every 30 seconds and bumped
// locally after each send so a burst inside those 30 seconds cannot overshoot.
export async function sentTodayCount(s, businessId) {
  const hit = countCache.get(businessId)
  if (hit && Date.now() - hit.at < 30_000) return hit.count
  const count = await getDailyCount(s, businessId)
  countCache.set(businessId, { count, at: Date.now() })
  return count
}

export function noteSent(businessId) {
  const hit = countCache.get(businessId)
  if (hit) hit.count += 1
  const first = firstSendCache.get(businessId)
  if (first && first.first === null) firstSendCache.set(businessId, { first: Date.now(), checked: Date.now() })
}

export function logWarmupHold(businessId, day, cap) {
  const key = `${businessId}:${new Date().toISOString().slice(0, 13)}`
  if (lastLogged.has(key)) return
  lastLogged.set(key, true)
  log('info', 'sender', 'sender.warmup_hold', `Slow start: ${businessId} is on day ${day}, held to ${cap} messages today`, {
    business_id: businessId, details: { day, cap }
  })
}
