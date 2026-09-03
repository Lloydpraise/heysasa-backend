import { DEFAULT_TIMEZONE } from '../config.js'

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

function formatter(timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', weekday: 'short'
  })
}

export function getZonedParts(date, timeZone = DEFAULT_TIMEZONE) {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(date)
    .filter(part => part.type !== 'literal')
    .map(part => [part.type, part.value]))
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second),
    weekday: WEEKDAY_INDEX[parts.weekday]
  }
}

function timeZoneOffsetMs(date, timeZone) {
  const parts = getZonedParts(date, timeZone)
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - date.getTime()
}

export function zonedPartsToDate(parts, timeZone = DEFAULT_TIMEZONE) {
  const wallClock = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second ?? 0)
  let result = new Date(wallClock - timeZoneOffsetMs(new Date(wallClock), timeZone))
  result = new Date(wallClock - timeZoneOffsetMs(result, timeZone))
  return result
}

function addLocalHours(parts, hours) {
  const value = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute ?? 0, parts.second ?? 0))
  value.setUTCHours(value.getUTCHours() + hours)
  return {
    ...parts,
    year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate(),
    hour: value.getUTCHours(), minute: value.getUTCMinutes(), second: value.getUTCSeconds()
  }
}

function isQuietHour(hour, quietStart, quietEnd) {
  return quietStart > quietEnd
    ? (hour >= quietStart || hour < quietEnd)
    : (hour >= quietStart && hour < quietEnd)
}

export function calculateSendTime(delayHours, optimalHour, quietStart = 21, quietEnd = 8, timeZone = DEFAULT_TIMEZONE) {
  const base = new Date(Date.now() + delayHours * 3_600_000)
  const localBase = getZonedParts(base, timeZone)

  if (optimalHour != null && !isQuietHour(optimalHour, quietStart, quietEnd)) {
    const target = zonedPartsToDate({ ...localBase, hour: optimalHour, minute: 0, second: 0 }, timeZone)
    if (target <= base) target.setUTCDate(target.getUTCDate() + 1)
    return target
  }

  let adjusted = { ...localBase, minute: 0, second: 0 }
  if (localBase.minute > 0 || localBase.second > 0) adjusted = addLocalHours(adjusted, 1)
  for (let i = 0; i < 48; i++) {
    if (!isQuietHour(adjusted.hour, quietStart, quietEnd)) return zonedPartsToDate(adjusted, timeZone)
    adjusted = addLocalHours(adjusted, 1)
  }
  return zonedPartsToDate(adjusted, timeZone)
}

export function leadAgeDays(createdAt) {
  return (Date.now() - new Date(createdAt).getTime()) / 86_400_000
}

export function hoursSince(ts) {
  return (Date.now() - new Date(ts).getTime()) / 3_600_000
}

// Walks forward using the business-local calendar, not the server's UTC day.
export function nextActiveDayDate(fromDate, activeDays, timeZone = DEFAULT_TIMEZONE, targetHour = null) {
  let parts = getZonedParts(fromDate, timeZone)
  for (let i = 0; i < 8; i++) {
    if (activeDays.includes(parts.weekday)) {
      return zonedPartsToDate({ ...parts, hour: targetHour ?? parts.hour, minute: 0, second: 0 }, timeZone)
    }
    parts = addLocalHours(parts, 24)
  }
  return zonedPartsToDate(parts, timeZone)
}