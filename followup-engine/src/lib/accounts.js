// HeySasa accounts (one per WhatsApp number) as the engine sees them. See ACCOUNTS.md.
//
// Every row that goes to WhatsApp belongs to an account. The instance that sends it is the account's
// (accounts.instance_name), not the name stamped on the campaign or queue row; the stored name is only a
// fallback for rows without an account. A row is only sent while its account is connected and allowed to
// operate (account_can_operate: false once the access fee is past grace and enforcement is on).

const ROW_TTL_MS = 15_000
const OPERATE_TTL_MS = 60_000
const ACCOUNT_COLUMNS = 'id, business_id, status, instance_name, subscription_status, billing_mode, settings'

const rowCache = new Map()       // account_id -> { at, row }
const operateCache = new Map()   // account_id -> { at, ok }

// Rows for these accounts, read in one request (cached briefly). Returns Map(id -> row).
export async function loadAccounts(s, ids) {
  const out = new Map()
  const missing = []
  for (const id of new Set((ids ?? []).filter(Boolean))) {
    const hit = rowCache.get(id)
    if (hit && Date.now() - hit.at < ROW_TTL_MS) { if (hit.row) out.set(id, hit.row) } else missing.push(id)
  }
  if (missing.length) {
    const { data, error } = await s.from('accounts').select(ACCOUNT_COLUMNS).in('id', missing)
    if (error) throw new Error(`Account lookup failed: ${error.message}`)
    const found = new Map((data ?? []).map(row => [row.id, row]))
    for (const id of missing) {
      const row = found.get(id) ?? null
      rowCache.set(id, { at: Date.now(), row })
      if (row) out.set(id, row)
    }
  }
  return out
}

export async function getAccountRow(s, accountId) {
  if (!accountId) return null
  return (await loadAccounts(s, [accountId])).get(accountId) ?? null
}

// public.account_can_operate(p_account_id), cached for a minute. When the call fails the account row decides
// (same rule as the SQL function), so a database hiccup never stops every account at once.
export async function accountCanOperate(s, accountId) {
  if (!accountId) return true
  const hit = operateCache.get(accountId)
  if (hit && Date.now() - hit.at < OPERATE_TTL_MS) return hit.ok
  let ok
  try {
    const { data, error } = await s.rpc('account_can_operate', { p_account_id: accountId })
    if (error) throw error
    ok = data !== false
  } catch {
    const row = await getAccountRow(s, accountId).catch(() => null)
    ok = !row || (row.status !== 'closed' && row.subscription_status !== 'suspended')
  }
  operateCache.set(accountId, { at: Date.now(), ok })
  return ok
}

// Which instance sends for this account right now.
// Returns { ok: true, instance } or { ok: false, reason } with reason one of
//   account_not_found | account_suspended | account_not_connected
export async function accountSendState(s, accountId) {
  const account = await getAccountRow(s, accountId)
  if (!account) return { ok: false, reason: 'account_not_found' }
  if (!(await accountCanOperate(s, accountId))) return { ok: false, reason: 'account_suspended', account }
  if (account.status !== 'connected' || !account.instance_name) return { ok: false, reason: 'account_not_connected', account }
  return { ok: true, instance: account.instance_name, account }
}

// The instance for a campaign or queue row: the account's when the row has one (stored names are ignored),
// otherwise the stored name. Returns { ok, instance, reason, legacy }.
export async function instanceForRow(s, { accountId = null, storedInstance = null } = {}) {
  if (accountId) return { ...(await accountSendState(s, accountId)), legacy: false }
  if (!storedInstance) return { ok: false, reason: 'instance_unassigned', legacy: true }
  return { ok: true, instance: storedInstance, legacy: true }
}

// Lane key for per-number state (antiban timers, daily caps, warm-up): the account, or the business for
// rows from before accounts existed.
export const laneKey = (businessId, accountId = null) => accountId ? `acct:${accountId}` : `biz:${businessId}`

// Narrows a query to one lane: the account's rows, or (no account) the business's.
export function forLane(query, { businessId, accountId = null }) {
  return accountId ? query.eq('account_id', accountId) : query.eq('business_id', businessId)
}

// The business row as one account sees it: accounts.settings laid over the business columns (the same merge as
// SQL account_settings()). For bulk reads where calling account_settings per account would cost a request each.
export function withAccountSettings(business, account) {
  if (!business) return null
  const overrides = account?.settings && typeof account.settings === 'object' ? account.settings : {}
  return { ...business, ...overrides }
}

// Accounts whose settings set this key, split by value: { on: Set(ids), off: Set(ids) }.
export async function accountOverrides(s, key) {
  const { data, error } = await s.from('accounts').select('id, business_id, settings').neq('status', 'closed')
  const on = new Set()
  const off = new Set()
  if (error) return { on, off }
  for (const row of data ?? []) {
    const value = row.settings && typeof row.settings === 'object' ? row.settings[key] : undefined
    if (value === true) on.add(row.id)
    else if (value === false) off.add(row.id)
  }
  return { on, off }
}

export function _resetAccountsForTests() {
  rowCache.clear(); operateCache.clear()
}
