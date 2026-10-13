// Picks WHEN a follow-up goes out. Pure: no database, no clock of its own, so it is easy to test.
//
// Two timings are at work here (kept apart on purpose):
//   1. the exact send time  -> picked below, from the lead's own active hours
//   2. the minimum gap      -> the caller turns it into `earliest` (last send + gap), so nothing is ever sooner
//
// Order of preference for the hour of day:
//   a) hours this lead has been active (from their own messages)
//   b) the busiest inbound hours of the whole business
//   c) a default hour
// Always clamped by active days and quiet hours. A send is never at (almost) the same clock time as the lead's
// previous sends on the same or the previous day, so nobody gets a message at 12:00 thirteen days in a row.

import { getZonedParts, zonedPartsToDate, isQuietHour } from '../lib/timing.js'

export const DEFAULT_SEND_HOUR = 10
export const DEFAULT_NO_REPEAT_MINUTES = 60
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]
const SEARCH_DAYS = 21
const DAY_MS = 86_400_000

const circularDiff = (a, b) => {
  const d = Math.abs(a - b) % 1440
  return Math.min(d, 1440 - d)
}

const localDayIndex = (date, timeZone) => {
  const p = getZonedParts(date, timeZone)
  return Math.round(Date.UTC(p.year, p.month - 1, p.day) / DAY_MS)
}

const cleanHours = (hours, quietStart, quietEnd) => [...new Set((hours ?? [])
  .map(Number)
  .filter(h => Number.isInteger(h) && h >= 0 && h <= 23 && !isQuietHour(h, quietStart, quietEnd)))]
  .sort((a, b) => a - b)

export function pickSendTime({
  earliest,
  timeZone,
  quietStart = 21,
  quietEnd = 8,
  activeDays = ALL_DAYS,
  leadHours = [],
  businessHours = [],
  previousSends = [],
  noRepeatMinutes = DEFAULT_NO_REPEAT_MINUTES,
  minuteSeed = 0,
  defaultHour = DEFAULT_SEND_HOUR,
}) {
  const days = Array.isArray(activeDays) && activeDays.length ? activeDays : ALL_DAYS
  const lead = cleanHours(leadHours, quietStart, quietEnd)
  const biz = cleanHours(businessHours, quietStart, quietEnd)
  let source = 'default_hour'
  let hours = cleanHours([defaultHour], quietStart, quietEnd)
  if (lead.length) { source = 'lead_active_hours'; hours = lead }
  else if (biz.length) { source = 'business_busy_hours'; hours = biz }
  if (!hours.length) hours = [((quietEnd % 24) + 24) % 24]

  // a few minutes past the hour, different per lead, so sends do not all land on :00
  const minute = 3 + (Math.abs(Math.trunc(minuteSeed)) % 40)

  const sends = previousSends.map(d => new Date(d)).filter(d => !Number.isNaN(d.getTime())).slice(-4)
    .map(d => ({ day: localDayIndex(d, timeZone), clock: (() => { const p = getZonedParts(d, timeZone); return p.hour * 60 + p.minute })() }))

  const start = getZonedParts(earliest, timeZone)
  for (let offset = 0; offset < SEARCH_DAYS; offset++) {
    const cal = new Date(Date.UTC(start.year, start.month - 1, start.day + offset))
    const weekday = cal.getUTCDay()
    if (!days.includes(weekday)) continue
    const dayIndex = Math.round(cal.getTime() / DAY_MS)
    for (const hour of hours) {
      const at = zonedPartsToDate({
        year: cal.getUTCFullYear(), month: cal.getUTCMonth() + 1, day: cal.getUTCDate(), hour, minute, second: 0,
      }, timeZone)
      if (at < earliest) continue
      const clock = hour * 60 + minute
      const repeats = sends.some(s => dayIndex - s.day <= 1 && dayIndex - s.day >= 0 && circularDiff(s.clock, clock) < noRepeatMinutes)
      if (repeats) continue
      return { at, reason: `${source}:${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` }
    }
  }
  return { at: new Date(Math.max(earliest.getTime(), Date.now()) + DAY_MS), reason: 'fallback_no_window' }
}
