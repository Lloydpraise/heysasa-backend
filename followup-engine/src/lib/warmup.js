import { DEFAULT_DAILY_CAP } from '../config.js'
import { getDailyCount } from './db.js'
import { log } from './log.js'

// Slow start for new numbers. A brand-new WhatsApp connection that sends at full
// speed gets flagged, so a number's first week of sending is held to a lower
// daily limit. "First week" runs from the number's very first sent message (per
// account; per business for rows without an account), so numbers that have been
// sending for a while are not affected at all.
const WARMUP = [
  { untilDay: 3, cap: 15 },   // days 1-3
  { untilDay: 7, cap: 25 },   // days 4-7
]
const DAY_MS = 86_400_000

const firstSendCache = new Map()   // lane key -> { first: ms | null, checked: ms }
const countCache = new Map()       // lane key -> { count, at }
const keyOf = (businessId, accountId) => accountId ? `acct:${accountId}` : businessId
const lastLogged = new Map()

async function firstSendAt(s, businessId, accountId = null) {
  const key = keyOf(businessId, accountId)
  const hit = firstSendCache.get(key)
  // A real first-send time never changes, so it is kept for good; "never sent" is re-checked every minute.
  if (hit && (hit.first !== null || Date.now() - hit.checked < 60_000)) return hit.first
  let query = s.from('follow_up_queue').select('processed_at')
  query = accountId ? query.eq('account_id', accountId) : query.eq('business_id', businessId)
  const { data, error } = await query.eq('status', 'sent')
    .order('processed_at', { ascending: true }).limit(1)
  if (error) return hit?.first ?? null
  const first = data?.[0]?.processed_at ? new Date(data[0].processed_at).getTime() : null
  firstSendCache.set(key, { first, checked: Date.now() })
  return first
}

// Returns { cap, warmupActive, day }. Once the first week is over, cap is just the
// business's own daily cap and warmupActive is false.
export async function effectiveDailyCap(s, businessId, businessCap, accountId = null) {
  const base = businessCap ?? DEFAULT_DAILY_CAP
  const first = await firstSendAt(s, businessId, accountId)
  const day = first === null ? 1 : Math.floor((Date.now() - first) / DAY_MS) + 1
  const step = WARMUP.find(w => day <= w.untilDay)
  if (!step) return { cap: base, warmupActive: false, day }
  return { cap: Math.min(base, step.cap), warmupActive: true, day }
}

// Sent-today count, refreshed from the database every 30 seconds and bumped
// locally after each send so a burst inside those 30 seconds cannot overshoot.
export async function sentTodayCount(s, businessId, accountId = null) {
  const key = keyOf(businessId, accountId)
  const hit = countCache.get(key)
  if (hit && Date.now() - hit.at < 30_000) return hit.count
  const count = await getDailyCount(s, businessId, accountId)
  countCache.set(key, { count, at: Date.now() })
  return count
}

export function noteSent(businessId, accountId = null) {
  const key = keyOf(businessId, accountId)
  const hit = countCache.get(key)
  if (hit) hit.count += 1
  const first = firstSendCache.get(key)
  if (first && first.first === null) firstSendCache.set(key, { first: Date.now(), checked: Date.now() })
}

export function logWarmupHold(businessId, day, cap) {
  const key = `${businessId}:${new Date().toISOString().slice(0, 13)}`
  if (lastLogged.has(key)) return
  lastLogged.set(key, true)
  log('info', 'sender', 'sender.warmup_hold', `Slow start: ${businessId} is on day ${day}, held to ${cap} messages today`, {
    business_id: businessId, details: { day, cap }
  })
}
