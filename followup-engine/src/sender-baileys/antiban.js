import {
  ANTIBAN_MIN_GAP_MS,
  ANTIBAN_JITTER_MS,
  ANTIBAN_HOURLY_CEILING,
  ANTIBAN_WINDOW_MS,
} from '../config.js'

// Per-number in-memory state, keyed by lane (lib/accounts.js laneKey: the account, or the business for rows
// from before accounts existed; plain business ids still work). It used to start empty after every deploy,
// which let a number send a second full hour's worth right after a restart.
// primeAntiban() below reloads the last hour of sends from the database the
// first time a business is seen, so a restart no longer resets the count.
const lastSentAt = new Map()          // business_id -> timestamp (ms) of the last send OR failed attempt
const sentTimestamps = new Map()      // business_id -> [timestamp, ...] within the last hour (successful sends only)
const failStreak = new Map()          // business_id -> consecutive connection-type failures
const coolUntil = new Map()           // business_id -> timestamp (ms) before which nothing is attempted

const primed = new Set()

// Failures that point at the connection or WhatsApp itself rather than at one lead's number.
// A run of these means "stop knocking", not "try the next lead".
const CONNECTION_TROUBLE = new Set(['instance_down', 'timeout', 'server_error', 'auth_error', 'rate_limited'])
const COOL_BASE_MS = 5 * 60_000
const COOL_MAX_MS = 60 * 60_000
const RATE_LIMITED_COOL_MS = 60 * 60_000

// Reads this business's sends from the last hour (and the time of the very last one)
// back into memory. Runs once per business per process start; if the read fails it
// tries again on the next poll instead of sending unprimed.
// lane: { businessId, accountId } — which sends count (the account's, or the business's). Defaults to the key
// as a business id.
export async function primeAntiban(supabase, businessId, lane = null) {
  if (primed.has(businessId)) return
  primed.add(businessId)
  const since = new Date(Date.now() - ANTIBAN_WINDOW_MS).toISOString()
  let query = supabase
    .from('follow_up_queue')
    .select('processed_at')
  query = lane?.accountId ? query.eq('account_id', lane.accountId) : query.eq('business_id', lane?.businessId ?? businessId)
  const { data, error } = await query
    .eq('status', 'sent')
    .gte('processed_at', since)
    .order('processed_at', { ascending: true })
    .limit(200)
  if (error) { primed.delete(businessId); return }
  const fromDb = (data ?? []).map(r => new Date(r.processed_at).getTime()).filter(Number.isFinite)
  const merged = [...new Set([...(sentTimestamps.get(businessId) ?? []), ...fromDb])].sort((a, b) => a - b)
  sentTimestamps.set(businessId, merged)
  if (merged.length) lastSentAt.set(businessId, Math.max(lastSentAt.get(businessId) ?? 0, merged[merged.length - 1]))
}

function pruneOldTimestamps(businessId) {
  const cutoff = Date.now() - ANTIBAN_WINDOW_MS
  const list = (sentTimestamps.get(businessId) ?? []).filter(t => t > cutoff)
  sentTimestamps.set(businessId, list)
  return list
}

/**
 * Returns { allowed: true } if this business can send right now, or
 * { allowed: false, retryAfterMs } if it should wait.
 * dailyCap is passed in from the business record — the hourly window
 * is capped at min(dailyCap, ANTIBAN_HOURLY_CEILING) so a business
 * with a huge daily allowance still can't blast it all in one hour.
 */
export function checkAntiban(businessId, dailyCap) {
  const now = Date.now()

  // 0. Cool-down after a run of connection-type failures
  const cool = coolUntil.get(businessId)
  if (cool != null) {
    if (cool > now) return { allowed: false, retryAfterMs: cool - now, reason: 'cooldown' }
    coolUntil.delete(businessId)
  }

  // 1. Minimum gap since last send or failed attempt (with jitter)
  const last = lastSentAt.get(businessId)
  if (last != null) {
    const requiredGap = ANTIBAN_MIN_GAP_MS + Math.floor(Math.random() * ANTIBAN_JITTER_MS)
    const elapsed = now - last
    if (elapsed < requiredGap) {
      return { allowed: false, retryAfterMs: requiredGap - elapsed, reason: 'gap' }
    }
  }

  // 2. Sliding hourly window cap
  const hourlyCeiling = Math.min(dailyCap ?? ANTIBAN_HOURLY_CEILING, ANTIBAN_HOURLY_CEILING)
  const recent = pruneOldTimestamps(businessId)
  if (recent.length >= hourlyCeiling) {
    const oldest = recent[0]
    return { allowed: false, retryAfterMs: (oldest + ANTIBAN_WINDOW_MS) - now, reason: 'hourly' }
  }

  return { allowed: true }
}

// Call this immediately after a successful send to record it
export function recordSend(businessId) {
  const now = Date.now()
  lastSentAt.set(businessId, now)
  failStreak.delete(businessId)
  coolUntil.delete(businessId)
  const list = pruneOldTimestamps(businessId)
  list.push(now)
  sentTimestamps.set(businessId, list)
}

// Call this after a send ATTEMPT that did not go through. A failed attempt still touches WhatsApp,
// so the same minimum gap applies to the next one (it used to be free: a broken connection got
// hammered with back-to-back attempts). A run of connection-type failures puts the whole business
// on a growing cool-down (5, 10, 20, 40, 60 minutes) instead of working through every lead.
// Returns the cool-down in ms (0 when none was applied).
export function recordFailedAttempt(businessId, failureClass = 'unknown') {
  const now = Date.now()
  lastSentAt.set(businessId, now)
  if (!CONNECTION_TROUBLE.has(failureClass)) return 0

  const streak = (failStreak.get(businessId) ?? 0) + 1
  failStreak.set(businessId, streak)

  let cool = 0
  if (failureClass === 'rate_limited') cool = RATE_LIMITED_COOL_MS
  else if (streak >= 2) cool = Math.min(COOL_MAX_MS, COOL_BASE_MS * 2 ** (streak - 2))
  if (cool > 0) coolUntil.set(businessId, Math.max(coolUntil.get(businessId) ?? 0, now + cool))
  return cool
}

export function _resetAntibanForTests() {
  lastSentAt.clear(); sentTimestamps.clear(); failStreak.clear(); coolUntil.clear(); primed.clear()
}
