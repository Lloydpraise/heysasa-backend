// Remembers, per business, whether the Follow-up AI was on at the last change, so that SWITCHING IT ON can start
// the ad intake straight away (the owner then sees plans for the ads already found in minutes, not at the next
// five-minute check). Realtime does not reliably tell us the old value, so we keep our own.
export function createSwitchWatch() {
  const seen = new Map()
  return {
    // row = the business row from a database change. True only when this change turned the Follow-up AI on.
    switchedOn(row) {
      if (!row?.business_id) return false
      const on = row.followup_ai_enabled === true
      const was = seen.get(row.business_id)
      seen.set(row.business_id, on)
      return on && was !== true
    },
  }
}
