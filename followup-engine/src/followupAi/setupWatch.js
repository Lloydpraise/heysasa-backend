// Notices the moments a business's setup becomes useful, so the Follow-up AI can look for work straight away.
//
//   home_ready : the first leads are sorted (the owner's Home is ready)
//   done       : every chat has been checked
//
// Without this, plans for the ads already found waited for the next five-minute check after setup ended.
// Realtime does not tell us the old value, so we keep our own. Each moment fires once per business.
const MOMENTS = new Set(['home_ready', 'done'])

export function createSetupWatch() {
  const seen = new Map()
  return {
    // row = the business_setup row from a database change. True only when this change reached a new moment.
    reachedMoment(row) {
      if (!row?.business_id) return false
      const status = String(row.status ?? '')
      const before = seen.get(row.business_id)
      seen.set(row.business_id, status)
      return MOMENTS.has(status) && before !== status
    },
  }
}
