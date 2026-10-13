// Works out the next send time for one lead: the DB side of sendWindow.js.
//
//   earliest = latest of
//      - the step's own delay after the previous send            (step_delay)
//      - last follow-up sent to this lead + the minimum gap      (min_gap)
//      - the lead's last message + the silence gate              (lead_silence)
//      - an owner/chat-AI hold                                   (hold)
//   then the exact time is picked inside that: the lead's active hours, else the business's busiest hours, else a
//   default hour, always outside quiet hours and on an active day, never at the same clock time as the day before.

import { DEFAULT_TIMEZONE, DEFAULT_QUIET_START, DEFAULT_QUIET_END } from '../config.js'
import { getZonedParts } from '../lib/timing.js'
import { pickSendTime } from './sendWindow.js'

export const DEFAULT_MIN_GAP_HOURS = 20
export const DEFAULT_SILENCE_HOURS = 12
const HOUR_MS = 3_600_000
const BUSY_TTL_MS = 6 * HOUR_MS
const busyCache = new Map() // business_id -> { at, hours }

// The hours of day this business gets the most customer messages in (its own time zone). Needs a real sample.
export async function businessBusyHours(supabase, businessId, timeZone) {
  const hit = busyCache.get(businessId)
  if (hit && Date.now() - hit.at < BUSY_TTL_MS) return hit.hours
  let hours = []
  try {
    const since = new Date(Date.now() - 60 * 24 * HOUR_MS).toISOString()
    const { data } = await supabase.from('messages').select('created_at')
      .eq('business_id', businessId).eq('direction', 'in').gte('created_at', since)
      .order('created_at', { ascending: false }).limit(3000)
    if ((data?.length ?? 0) >= 30) {
      const counts = new Map()
      for (const m of data) {
        const h = getZonedParts(new Date(m.created_at), timeZone).hour
        counts.set(h, (counts.get(h) ?? 0) + 1)
      }
      hours = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([h]) => h)
    }
  } catch { hours = [] }
  busyCache.set(businessId, { at: Date.now(), hours })
  return hours
}

export async function computeNextSend(supabase, { business, contact, campaign = null, after = new Date(), delayHours = 0, lastInboundAt = null }) {
  const timeZone = business.timezone || DEFAULT_TIMEZONE
  const gapHours = Number(campaign?.min_gap_hours ?? business.followup_min_gap_hours ?? DEFAULT_MIN_GAP_HOURS)
  const silenceHours = Number(business.followup_silence_hours ?? DEFAULT_SILENCE_HOURS)

  const [{ data: sentRows }, { data: pattern }, { data: state }, busy] = await Promise.all([
    supabase.from('follow_up_queue').select('processed_at').eq('contact_id', contact.id).eq('status', 'sent')
      .not('processed_at', 'is', null).order('processed_at', { ascending: false }).limit(4),
    supabase.from('contact_activity_patterns').select('active_hours').eq('contact_id', contact.id).eq('business_id', business.business_id).maybeSingle(),
    supabase.from('lead_ai_state').select('hold_until').eq('business_id', business.business_id).eq('contact_id', contact.id).maybeSingle(),
    businessBusyHours(supabase, business.business_id, timeZone),
  ])

  const previousSends = (sentRows ?? []).map(r => new Date(r.processed_at)).reverse()
  const candidates = [{ why: 'step_delay', at: after.getTime() + Math.max(0, delayHours) * HOUR_MS }]
  if (previousSends.length) candidates.push({ why: 'min_gap', at: previousSends.at(-1).getTime() + gapHours * HOUR_MS })
  if (lastInboundAt) candidates.push({ why: 'lead_silence', at: new Date(lastInboundAt).getTime() + silenceHours * HOUR_MS })
  if (state?.hold_until) candidates.push({ why: 'hold', at: new Date(state.hold_until).getTime() })
  const limiting = candidates.reduce((a, b) => (b.at > a.at ? b : a))

  const picked = pickSendTime({
    earliest: new Date(Math.max(limiting.at, Date.now())),
    timeZone,
    quietStart: business.followup_quiet_start ?? DEFAULT_QUIET_START,
    quietEnd: business.followup_quiet_end ?? DEFAULT_QUIET_END,
    activeDays: business.followup_active_days ?? undefined,
    leadHours: pattern?.active_hours ?? [],
    businessHours: busy,
    previousSends,
    minuteSeed: Number(contact.id) || 0,
  })
  return { at: picked.at, reason: `${limiting.why}>${picked.reason}`, gapHours, silenceHours }
}

// Is it OK to send this lead's next AI-managed step right now? Checks the three waiting rules that apply to every send.
export async function checkSendReady(supabase, { business, contact, campaign = null, lastInboundAt = null, now = Date.now() }) {
  const gapHours = Number(campaign?.min_gap_hours ?? business.followup_min_gap_hours ?? DEFAULT_MIN_GAP_HOURS)
  const silenceHours = Number(business.followup_silence_hours ?? DEFAULT_SILENCE_HOURS)
  if (lastInboundAt && now - new Date(lastInboundAt).getTime() < silenceHours * HOUR_MS) return { ready: false, why: 'lead_silence' }

  const [{ data: last }, { data: state }] = await Promise.all([
    supabase.from('follow_up_queue').select('processed_at').eq('contact_id', contact.id).eq('status', 'sent')
      .not('processed_at', 'is', null).order('processed_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('lead_ai_state').select('hold_until').eq('business_id', business.business_id).eq('contact_id', contact.id).maybeSingle(),
  ])
  if (state?.hold_until && new Date(state.hold_until).getTime() > now) return { ready: false, why: 'hold' }
  if (last?.processed_at && now - new Date(last.processed_at).getTime() < gapHours * HOUR_MS) return { ready: false, why: 'min_gap' }
  return { ready: true, why: null }
}
