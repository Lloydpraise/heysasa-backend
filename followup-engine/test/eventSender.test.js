import test from 'node:test'
import assert from 'node:assert/strict'

process.env.SUPABASE_URL ??= 'http://localhost'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test'
const { processEventBatch, resetEventSenderState } = await import('../src/sender-baileys/eventSender.js')
const { _resetAntibanForTests, recordSend } = await import('../src/sender-baileys/antiban.js')

function fakeSupabase(state) {
  return {
    from(table) {
      state[table] ??= []
      const q = { filters: [], op: 'select', payload: null, single: false, limitN: null, orders: [], onConflict: null }
      const rows = () => state[table].filter(r => q.filters.every(f => f(r)))
      const api = {
        select() { return api },
        eq(col, val) { q.filters.push(r => r[col] === val); return api },
        in(col, vals) { q.filters.push(r => vals.includes(r[col])); return api },
        lte(col, val) { q.filters.push(r => r[col] != null && r[col] <= val); return api },
        gte(col, val) { q.filters.push(r => r[col] != null && r[col] >= val); return api },
        gt(col, val) { q.filters.push(r => r[col] != null && r[col] > val); return api },
        order(col) { q.orders.push(col); return api },
        limit(n) { q.limitN = n; return api },
        maybeSingle() { q.single = true; return api },
        update(payload) { q.op = 'update'; q.payload = payload; return api },
        upsert(payload, opts) { q.op = 'upsert'; q.payload = payload; q.onConflict = opts?.onConflict; return api },
        then(resolve) {
          if (q.op === 'update') { const hit = rows(); hit.forEach(r => Object.assign(r, q.payload)); return resolve({ data: q.single ? (hit[0] ?? null) : hit, error: null }) }
          if (q.op === 'upsert') { state[table].push({ ...q.payload }); return resolve({ data: null, error: null }) }
          let out = rows()
          for (const col of [...q.orders].reverse()) out = [...out].sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0))
          if (q.limitN) out = out.slice(0, q.limitN)
          return resolve({ data: q.single ? (out[0] ?? null) : out, error: null })
        },
      }
      return api
    },
  }
}

const NOW = Date.parse('2026-10-30T09:00:00Z')   // 12:00 in Nairobi: awake
const iso = (ms) => new Date(ms).toISOString()
const event = (over = {}) => ({
  id: 'e1', business_id: 'b1', account_id: 'a1', event_type: 'order.paid', contact_id: 7, conversation_id: 'c1',
  message: 'Thanks for your order', status: 'scheduled', send_at: iso(NOW - 1000), created_at: iso(NOW - 2000),
  respect_quiet_hours: false, attempts: 0, ...over,
})
const baseContact = { id: 7, business_id: 'b1', phone: '254712345678', country_code: '254', do_not_contact: false, last_inbound_at: iso(NOW - 86_400_000) }

function setup(events, { contact = baseContact, business = { business_id: 'b1', subscription_active: true, followup_daily_cap: 50, timezone: 'Africa/Nairobi' }, send, accountOk = true, balance = true, numberStatus = 'ok' } = {}) {
  _resetAntibanForTests()
  resetEventSenderState()
  const state = { business_events: events, messages: [], follow_up_queue: [], whatsapp_sessions: [] }
  const sends = []
  const bills = []
  const lookups = []
  const deps = {
    supabase: fakeSupabase(state),
    now: () => NOW,
    getContact: async () => contact,
    getBusiness: async () => business,
    accountSendState: async () => accountOk ? { ok: true, instance: 'inst_a1' } : { ok: false, reason: 'account_not_connected' },
    ensureNumber: async (_s, args) => { lookups.push(args); return { status: numberStatus, retryAfterMs: 30_000 } },
    checkSendBalance: async () => balance,
    billSend: async (_s, businessId, opts) => { bills.push({ businessId, ...opts }) },
    send: send ?? (async (instance, number, content) => { sends.push({ instance, number, content }); return { ok: true, messageId: `W${sends.length}` } }),
  }
  return { state, sends, bills, lookups, deps }
}

test('a due receipt goes out on the account number, is billed and saved as a message', async () => {
  const t = setup([event()])
  const res = await processEventBatch(t.deps)
  assert.equal(res.sent, 1)
  assert.deepEqual(t.sends, [{ instance: 'inst_a1', number: '254712345678', content: { text: 'Thanks for your order' } }])
  assert.equal(t.state.business_events[0].status, 'sent')
  assert.equal(t.state.business_events[0].whatsapp_message_id, 'W1')
  assert.equal(t.state.messages[0].agent_role, 'events_api')
  assert.deepEqual(t.bills, [{ businessId: 'b1', reason: 'event_order.paid', runner: 'event_send', accountId: 'a1' }])
})

test('the built-in antiban gap holds the second event for the same number', async () => {
  const t = setup([event(), event({ id: 'e2', contact_id: 7, send_at: iso(NOW - 500) })])
  const res = await processEventBatch(t.deps)
  assert.equal(t.sends.length, 1)
  assert.equal(t.state.business_events[1].status, 'scheduled')
  assert.ok(res.wakeAt > NOW)
})

test('a follow-up just sent on the same number closes the gap for events too', async () => {
  const t = setup([event()])
  recordSend('acct:a1')
  const res = await processEventBatch(t.deps)
  assert.equal(t.sends.length, 0)
  assert.ok(res.wakeAt > Date.now())
})

test('different numbers send side by side in one pass', async () => {
  const t = setup([event(), event({ id: 'e2', account_id: 'a2' })])
  await processEventBatch(t.deps)
  assert.equal(t.sends.length, 2)
})

test('cart reminders wait for quiet hours to end; receipts do not', async () => {
  const night = Date.parse('2026-10-30T20:00:00Z')   // 23:00 in Nairobi
  const t = setup([
    event({ id: 'cart', event_type: 'cart.abandoned', respect_quiet_hours: true, send_at: iso(night - 1000), created_at: iso(night - 2000) }),
    event({ id: 'paid', send_at: iso(night - 500), created_at: iso(night - 2000) }),
  ])
  t.deps.now = () => night
  await processEventBatch(t.deps)
  const [cart, paid] = t.state.business_events
  assert.equal(cart.status, 'scheduled')
  assert.equal(cart.last_error, 'quiet_hours')
  assert.ok(Date.parse(cart.send_at) > night)
  assert.equal(paid.status, 'sent')
})

test('a cart reminder is skipped when the shopper has written in since', async () => {
  const t = setup([event({ event_type: 'cart.abandoned' })], { contact: { ...baseContact, last_inbound_at: iso(NOW - 100) } })
  await processEventBatch(t.deps)
  assert.equal(t.sends.length, 0)
  assert.equal(t.state.business_events[0].status, 'skipped')
  assert.equal(t.state.business_events[0].last_error, 'customer_replied')
})

test('a number that never wrote in is looked up first; not on WhatsApp fails it', async () => {
  const t = setup([event()], { contact: { ...baseContact, last_inbound_at: null }, numberStatus: 'not_on_whatsapp' })
  await processEventBatch(t.deps)
  assert.equal(t.lookups.length, 1)
  assert.equal(t.sends.length, 0)
  assert.equal(t.state.business_events[0].status, 'failed')
  assert.equal(t.state.business_events[0].failure_class, 'not_on_whatsapp')
})

test('do-not-contact, disconnected number, no balance and old events', async () => {
  let t = setup([event()], { contact: { ...baseContact, do_not_contact: true } })
  await processEventBatch(t.deps)
  assert.equal(t.state.business_events[0].status, 'skipped')

  t = setup([event()], { accountOk: false })
  const res = await processEventBatch(t.deps)
  assert.equal(t.state.business_events[0].status, 'scheduled')
  assert.equal(t.state.business_events[0].last_error, 'whatsapp_not_connected')
  assert.ok(res.wakeAt >= NOW + 5 * 60_000)

  t = setup([event()], { balance: false })
  await processEventBatch(t.deps)
  assert.equal(t.state.business_events[0].last_error, 'insufficient_balance')
  assert.equal(t.sends.length, 0)

  t = setup([event({ created_at: iso(NOW - 49 * 3_600_000) })])
  await processEventBatch(t.deps)
  assert.equal(t.state.business_events[0].status, 'failed')
  assert.equal(t.state.business_events[0].last_error, 'expired')
})

test('a failed send is retried later, a number not on WhatsApp is not', async () => {
  let t = setup([event()], { send: async () => ({ ok: false, error: '500: internal' }) })
  await processEventBatch(t.deps)
  assert.equal(t.state.business_events[0].status, 'scheduled')
  assert.equal(t.state.business_events[0].attempts, 1)
  assert.ok(Date.parse(t.state.business_events[0].send_at) > NOW)

  t = setup([event()], { send: async () => ({ ok: false, error: 'number not on whatsapp' }) })
  await processEventBatch(t.deps)
  assert.equal(t.state.business_events[0].status, 'failed')
})

test('the next delayed event sets the wake-up time', async () => {
  const t = setup([event({ send_at: iso(NOW + 3_600_000) })])
  const res = await processEventBatch(t.deps)
  assert.equal(t.sends.length, 0)
  assert.ok(res.wakeAt >= NOW + 3_600_000 && res.wakeAt < NOW + 3_601_000)
})
