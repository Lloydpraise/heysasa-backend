import {
  ANTIBAN_MIN_GAP_MS,
  ANTIBAN_JITTER_MS,
  ANTIBAN_HOURLY_CEILING,
  ANTIBAN_WINDOW_MS,
} from '../config.js'

// Per-business in-memory state. It used to start empty after every deploy,
// which let a number send a second full hour's worth right after a restart.
// primeAntiban() below reloads the last hour of sends from the database the
// first time a business is seen, so a restart no longer resets the count.
const lastSentAt = new Map()          // business_id -> timestamp (ms)
const sentTimestamps = new Map()      // business_id -> [timestamp, ...] within the last hour

const primed = new Set()

// Reads this business's sends from the last hour (and the time of the very last one)
// back into memory. Runs once per business per process start; if the read fails it
// tries again on the next poll instead of sending unprimed.
export async function primeAntiban(supabase, businessId) {
  if (primed.has(businessId)) return
  primed.add(businessId)
  const since = new Date(Date.now() - ANTIBAN_WINDOW_MS).toISOString()
  const { data, error } = await supabase
    .from('follow_up_queue')
    .select('processed_at')
    .eq('business_id', businessId)
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

  // 1. Minimum gap since last send (with jitter)
  const last = lastSentAt.get(businessId)
  if (last != null) {
    const requiredGap = ANTIBAN_MIN_GAP_MS + Math.floor(Math.random() * ANTIBAN_JITTER_MS)
    const elapsed = now - last
    if (elapsed < requiredGap) {
      return { allowed: false, retryAfterMs: requiredGap - elapsed }
    }
  }

  // 2. Sliding hourly window cap
  const hourlyCeiling = Math.min(dailyCap ?? ANTIBAN_HOURLY_CEILING, ANTIBAN_HOURLY_CEILING)
  const recent = pruneOldTimestamps(businessId)
  if (recent.length >= hourlyCeiling) {
    const oldest = recent[0]
    return { allowed: false, retryAfterMs: (oldest + ANTIBAN_WINDOW_MS) - now }
  }

  return { allowed: true }
}

// Call this immediately after a successful send to record it
export function recordSend(businessId) {
  const now = Date.now()
  lastSentAt.set(businessId, now)
  const list = pruneOldTimestamps(businessId)
  list.push(now)
  sentTimestamps.set(businessId, list)
}