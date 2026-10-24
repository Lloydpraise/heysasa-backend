import test from 'node:test'
import assert from 'node:assert/strict'

process.env.SUPABASE_URL ??= 'http://localhost'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test'
const { buildLanes } = await import('../src/sender-baileys/worker.js')
const { checkSendBalance, billSend, billAiUsage, deductBalance } = await import('../src/lib/billing.js')
const { getPersonaPack, getMaterialsForTouchpoint } = await import('../src/lib/db.js')
const { _resetAccountsForTests, instanceForRow } = await import('../src/lib/accounts.js')
const { checkAntiban, recordSend, _resetAntibanForTests } = await import('../src/sender-baileys/antiban.js')

// Minimal stand-in for the supabase-js query builder plus rpc, over in-memory tables.
function fakeDb(tables, rpc = {}) {
  const calls = []
  return {
    calls,
    rpc: async (fn, args) => { calls.push([fn, args]); return { data: rpc[fn] ? rpc[fn](args) : null, error: null } },
    from(name) {
      const filters = []
      let limitN = null
      let single = false
      const api = {
        select() { return api }, order() { return api }, or() { return api },
        eq(c, v) { filters.push(r => r[c] === v); return api },
        neq(c, v) { filters.push(r => r[c] !== v); return api },
        is(c) { filters.push(r => r[c] == null); return api },
        in(c, v) { filters.push(r => v.includes(r[c])); return api },
        limit(n) { limitN = n; return api },
        maybeSingle() { single = true; return api },
        single() { single = true; return api },
        then(resolve) {
          let rows = (tables[name] ?? []).filter(r => filters.every(f => f(r)))
          if (limitN) rows = rows.slice(0, limitN)
          return resolve({ data: single ? (rows[0] ?? null) : rows, error: null })
        },
      }
      return api
    },
  }
}

test('sender lanes: one per connected account, from the account instance; suspended accounts and stale instances get none', async () => {
  _resetAccountsForTests()
  const db = fakeDb({
    accounts: [
      { id: 'a1', business_id: 'b1', status: 'connected', instance_name: 'num-1', subscription_status: 'active' },
      { id: 'a2', business_id: 'b1', status: 'connected', instance_name: 'num-2', subscription_status: 'suspended' },
      { id: 'a3', business_id: 'b1', status: 'connected', instance_name: 'num-3-new', subscription_status: 'active' },
    ],
  }, { account_can_operate: ({ p_account_id }) => p_account_id !== 'a2' })
  const sessions = [
    { business_id: 'b1', account_id: 'a1', instance_name: 'num-1' },
    { business_id: 'b1', account_id: 'a2', instance_name: 'num-2' },
    { business_id: 'b1', account_id: 'a3', instance_name: 'num-3-old' },   // demoted/replaced: the account's instance is not connected
    { business_id: 'b2', account_id: null, instance_name: 'legacy' },
  ]
  const { lanes, held } = await buildLanes(db, sessions)
  const byKey = Object.fromEntries(lanes.map(l => [l.key, l]))
  assert.deepEqual(Object.keys(byKey).sort(), ['acct:a1', 'b2'])
  assert.equal(byKey['acct:a1'].instance, 'num-1')
  assert.equal(byKey.b2.accountId, null)
  assert.equal(byKey.b2.sessions[0].instance_name, 'legacy')
  assert.deepEqual(held.map(a => a.id), ['a2'])
})

test('antiban timers are per lane: two numbers of one business do not hold each other back', () => {
  _resetAntibanForTests()
  recordSend('acct:a1')
  assert.equal(checkAntiban('acct:a1', 100).allowed, false)
  assert.equal(checkAntiban('acct:a2', 100).allowed, true)
})

test('instance for a row: the account decides; the stored name only counts without an account', async () => {
  _resetAccountsForTests()
  const db = fakeDb({ accounts: [{ id: 'a1', business_id: 'b1', status: 'disconnected', instance_name: 'num-1', subscription_status: 'active' }] }, { account_can_operate: () => true })
  assert.deepEqual(await instanceForRow(db, { accountId: null, storedInstance: 'old' }), { ok: true, instance: 'old', legacy: true })
  const r = await instanceForRow(db, { accountId: 'a1', storedInstance: 'old' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'account_not_connected')
})

test('wallet: a separate-billing account spends and is checked against its own balance; every charge names the account', async () => {
  const tables = {
    businesses: [{ business_id: 'b1', business_type: 'salon' }],
    billing_prices: [{ key: 'send_price_kes', value: 1 }, { key: 'usd_kes_rate', value: 100 }],
    business_balances: [{ business_id: 'b1', balance_usd: 50 }],
    account_balances: [{ account_id: 'sep', balance_usd: 0 }],
    accounts: [{ id: 'sep', billing_mode: 'separate' }, { id: 'shared', billing_mode: 'business' }],
  }
  const db = fakeDb(tables, { bill_send: () => ({ ok: true }), bill_ai_usage: () => ({ ok: true }), deduct_balance: () => 1 })
  assert.equal(await checkSendBalance(db, 'b1', 'sep'), false, 'own empty wallet')
  assert.equal(await checkSendBalance(db, 'b1', 'shared'), true, 'business wallet')
  assert.equal(await checkSendBalance(db, 'b1'), true)
  await billSend(db, 'b1', { accountId: 'sep' })
  await billAiUsage(db, { businessId: 'b1', accountId: 'sep', runner: 'x', model: 'm' })
  await deductBalance(db, 'b1', 0.1, 'stage_change:a→b', 'sep')
  assert.deepEqual(db.calls.map(([fn, args]) => [fn, args.p_account_id]), [['bill_send', 'sep'], ['bill_ai_usage', 'sep'], ['deduct_balance', 'sep']])
  await billSend(db, 'b1')
  assert.equal('p_account_id' in db.calls.at(-1)[1], false, 'no account: the old call, unchanged')
})

test('persona pack: the account\'s own active pack, else the business-wide one', async () => {
  const db = fakeDb({ persona_packs: [
    { business_id: 'b1', account_id: null, is_active: true, pack: { v: 'business' } },
    { business_id: 'b1', account_id: 'a1', is_active: true, pack: { v: 'a1' } },
  ] })
  assert.deepEqual(await getPersonaPack(db, 'b1', 'a1'), { v: 'a1' })
  assert.deepEqual(await getPersonaPack(db, 'b1', 'a2'), { v: 'business' })
  assert.deepEqual(await getPersonaPack(db, 'b1'), { v: 'business' })
})

test('materials: the account sees its own plus the business catalog, never another account\'s', async () => {
  const db = fakeDb({ followup_materials: [
    { business_id: 'b1', account_id: null, is_active: true, material_type: 'tip', title: 'shared', content: 'x' },
    { business_id: 'b1', account_id: 'a1', is_active: true, material_type: 'tip', title: 'mine', content: 'x' },
    { business_id: 'b1', account_id: 'a2', is_active: true, material_type: 'tip', title: 'theirs', content: 'x' },
  ] })
  const titles = (await getMaterialsForTouchpoint(db, 'b1', 'value_tip', 'a1')).map(m => m.title).sort()
  assert.deepEqual(titles, ['mine', 'shared'])
})
