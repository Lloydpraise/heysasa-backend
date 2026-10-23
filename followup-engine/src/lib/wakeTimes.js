import { isBusinessAwake } from './timing.js'

// First moment (15-minute steps, up to 36h ahead) at which a sleeping business is awake again.
export function nextAwakeAt(business, from = Date.now()) {
  for (let step = 1; step <= 144; step++) {
    const at = from + step * 15 * 60_000
    if (isBusinessAwake(business, new Date(at))) return at
  }
  return from + 60 * 60_000
}
