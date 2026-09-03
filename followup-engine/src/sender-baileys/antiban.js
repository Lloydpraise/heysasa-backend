import {
  ANTIBAN_MIN_GAP_MS,
  ANTIBAN_JITTER_MS,
  ANTIBAN_HOURLY_CEILING,
  ANTIBAN_WINDOW_MS,
} from '../config.js'

// Per-business in-memory state. Lives only as long as this process —
// on restart it resets, which is fine: worst case is one instance
// sends slightly sooner than ideal right after a deploy, not a burst.
const lastSentAt = new Map()          // business_id -> timestamp (ms)
const sentTimestamps = new Map()      // business_id -> [timestamp, ...] within the last hour

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