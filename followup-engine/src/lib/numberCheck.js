import { EVOLUTION_URL, EVOLUTION_KEY } from '../config.js'
import { resolveSendTarget } from './sendTarget.js'
import { log } from './log.js'

// Asks WhatsApp whether a number has an account, BEFORE we try to message it.
//
// WHO GETS CHECKED: only people in MANUAL campaigns (uploaded or hand-picked lists), because
// we cannot be sure those numbers are on WhatsApp. Everyone in an AUTO campaign, and every
// AI follow-up, already messaged the business on WhatsApp, so they are never looked up.
//
// WHEN: at send time, only for the person who is next in line. Nothing is looked up when a list
// is uploaded, so a 1,000-contact upload causes no burst. The answer is saved on the contact
// (wa_exists, wa_checked_at), so each number is asked about once.
//
// HOW IT LOOKS TO WHATSAPP: lookups are spaced at random, never on a fixed beat. Gaps are
// 20-75 seconds, with an occasional 2-5 minute break, a hard limit of 30 lookups an hour per
// business, and a short random pause after each lookup before the message goes (like a person
// opening a chat). If a stretch of numbers in a row are not on WhatsApp, the same pacing still
// applies, so skipping a bad list is slow and quiet rather than fast.
//
// SURVIVES RESTARTS: the pacing state lives in memory, but it is rebuilt from contacts.wa_checked_at
// the first time a business is seen after a start, so a deploy no longer hands out a fresh budget of
// 30 lookups with no gap.
//
// ASKED ONCE, NEVER RETRIED: each number is looked up a single time. If WhatsApp (via Evolution) cannot answer, the
// lookup is not repeated: the attempt is recorded on the contact (wa_checked_at) and the message goes ahead, because the
// send itself will fail cleanly if the number has no account. A second lookup for the same number is never made.

const MIN_GAP_MS = 20_000
const MAX_GAP_MS = 75_000
const LONG_BREAK_CHANCE = 0.12
const LONG_BREAK_MIN_MS = 120_000
const LONG_BREAK_MAX_MS = 300_000
const MAX_LOOKUPS_PER_HOUR = 30
const AFTER_LOOKUP_PAUSE_MIN_MS = 1_500
const AFTER_LOOKUP_PAUSE_MAX_MS = 4_500
const WARN_EVERY_MS = 10 * 60_000
const HOUR_MS = 3_600_000
const RECHECK_TRUE_MS = 30 * 86_400_000     // a "yes" is trusted for 30 days
const RECHECK_FALSE_MS = 60 * 86_400_000    // a "no" is trusted for 60 days

const state = new Map() // business_id -> { nextAt, stamps: [ms], failures, lastWarn }
const primed = new Set()
const kindCache = new Map() // campaign_id -> { kind, at }

const between = (min, max) => min + Math.random() * (max - min)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

function bizState(businessId) {
  let biz = state.get(businessId)
  if (!biz) { biz = { nextAt: 0, stamps: [], failures: 0, lastWarn: 0 }; state.set(businessId, biz) }
  return biz
}

// Rebuilds the last hour of lookups for this business from the database (once per process start).
async function primeLookups(supabase, businessId) {
  if (primed.has(businessId)) return
  primed.add(businessId)
  const since = new Date(Date.now() - HOUR_MS).toISOString()
  const { data, error } = await supabase.from('contacts')
    .select('wa_checked_at')
    .eq('business_id', businessId)
    .gte('wa_checked_at', since)
    .order('wa_checked_at', { ascending: true })
    .limit(200)
  if (error) { primed.delete(businessId); return }
  const times = (data ?? []).map(r => Date.parse(r.wa_checked_at)).filter(Number.isFinite)
  if (!times.length) return
  const biz = bizState(businessId)
  biz.stamps = [...new Set([...biz.stamps, ...times])].sort((a, b) => a - b)
  // The next lookup is at least one minimum gap after the most recent one we know of.
  biz.nextAt = Math.max(biz.nextAt, times[times.length - 1] + MIN_GAP_MS)
}

// true = this queue item belongs to a manual campaign (so its number may be unverified)
export async function needsNumberLookup(supabase, item) {
  if (!item.campaign_id) return false
  const hit = kindCache.get(item.campaign_id)
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.kind !== 'auto'
  const { data, error } = await supabase.from('campaigns').select('kind').eq('id', item.campaign_id).maybeSingle()
  if (error) return false // cannot tell: do not look up, the send itself will decide
  const kind = data?.kind ?? 'manual'
  kindCache.set(item.campaign_id, { kind, at: Date.now() })
  return kind !== 'auto'
}

// true / false / null (null = could not tell)
async function askWhatsApp(instanceName, number) {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)
    const res = await fetch(`${EVOLUTION_URL}/chat/whatsappNumbers/${encodeURIComponent(instanceName)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: EVOLUTION_KEY },
      body: JSON.stringify({ numbers: [number] }),
      signal: controller.signal
    })
    clearTimeout(timeout)
    if (!res.ok) return null
    const body = await res.json().catch(() => null)
    const row = Array.isArray(body) ? body[0] : null
    return typeof row?.exists === 'boolean' ? row.exists : null
  } catch {
    return null
  }
}

// Returns { status: 'ok' | 'not_on_whatsapp' | 'wait', retryAfterMs? }.
//   ok               -> go ahead and send (already known, or just checked)
//   not_on_whatsapp  -> do NOT send; the contact has been marked
//   wait             -> not this one's turn for a lookup yet (pacing only); leave it in the queue
export async function ensureNumberOnWhatsApp(supabase, { instanceName, contact, businessId }) {
  // Defensive: a @lid contact has no number to look up (and already messaged us).
  const target = resolveSendTarget(contact, contact.country_code)
  if (target?.kind === 'lid') return { status: 'ok' }

  const age = contact.wa_checked_at ? Date.now() - new Date(contact.wa_checked_at).getTime() : Infinity
  if (contact.wa_exists === false && age < RECHECK_FALSE_MS) return { status: 'not_on_whatsapp' }
  if (contact.wa_exists === true && age < RECHECK_TRUE_MS) return { status: 'ok' }
  // Already asked once and WhatsApp could not answer: never ask again for this number.
  if (contact.wa_exists == null && contact.wa_checked_at) return { status: 'ok' }

  await primeLookups(supabase, businessId)

  const now = Date.now()
  const biz = bizState(businessId)
  biz.stamps = biz.stamps.filter(t => now - t < HOUR_MS)
  if (now < biz.nextAt) return { status: 'wait', retryAfterMs: biz.nextAt - now }
  if (biz.stamps.length >= MAX_LOOKUPS_PER_HOUR) return { status: 'wait', retryAfterMs: biz.stamps[0] + HOUR_MS - now }

  const number = target?.number
  if (!number) return { status: 'not_on_whatsapp' }

  biz.stamps.push(now)
  biz.nextAt = now + (Math.random() < LONG_BREAK_CHANCE
    ? between(LONG_BREAK_MIN_MS, LONG_BREAK_MAX_MS)
    : between(MIN_GAP_MS, MAX_GAP_MS))

  const exists = await askWhatsApp(instanceName, number)
  if (exists === null) {
    // No retry. Remember that the one lookup happened so it is never repeated, and let the send decide.
    biz.failures += 1
    await supabase.from('contacts').update({ wa_checked_at: new Date().toISOString() }).eq('id', contact.id)
    if (Date.now() - biz.lastWarn > WARN_EVERY_MS) {
      biz.lastWarn = Date.now()
      log('warn', 'sender', 'sender.number_check_unavailable',
        `WhatsApp could not answer a number lookup for ${businessId} (${biz.failures} so far); sending without the check, no retry`,
        { business_id: businessId, details: { failures: biz.failures } })
    }
    return { status: 'ok' }
  }

  await supabase.from('contacts').update({ wa_exists: exists, wa_checked_at: new Date().toISOString() }).eq('id', contact.id)
  if (!exists) {
    log('info', 'sender', 'sender.number_not_on_whatsapp', `${number} is not on WhatsApp, skipped before sending`, {
      business_id: businessId, contact_id: contact.id, details: { number }
    })
    return { status: 'not_on_whatsapp' }
  }
  await sleep(between(AFTER_LOOKUP_PAUSE_MIN_MS, AFTER_LOOKUP_PAUSE_MAX_MS))
  return { status: 'ok' }
}

export function _resetNumberCheckForTests() {
  state.clear(); primed.clear(); kindCache.clear()
}
