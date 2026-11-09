import test from 'node:test'
import assert from 'node:assert/strict'

process.env.SUPABASE_URL ??= 'http://localhost'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test'
const { processWebhookBatch, signWebhook, RETRY_DELAYS_MS } = await import('../src/sender-baileys/webhookDispatcher.js')

const NOW = Date.parse('2026-11-09T09:00:00Z')
const iso = (ms) => new Date(ms).toISOString()

function fakeSupabase(state) {
  return {
    from(table) {
      const q = { filters: [], op: 'select', payload: null, single: false, limitN: null }
      const rows = () => state[table].filter(r => q.filters.every(f => f(r)))
      const api = {
        select() { return api },
        eq(col, val) { q.filters.push(r => r[col] === val); return api },
        lte(col, val) { q.filters.push(r => r[col] <= val); return api },
        gt(col, val) { q.filters.push(r => r[col] > val); return api },
        order() { return api },
        limit(n) { q.limitN = n; return api },
        maybeSingle() { q.single = true; return api },
        update(payload) { q.op = 'update'; q.payload = payload; return api },
        then(resolve) {
          if (q.op === 'update') { const hit = rows(); hit.forEach(r => Object.assign(r, q.payload)); return resolve({ data: q.single ? (hit[0] ?? null) : hit, error: null }) }
          let out = rows()
          if (q.limitN) out = out.slice(0, q.limitN)
          return resolve({ data: q.single ? (out[0] ?? null) : out, error: null })
        },
      }
      return api
    },
  }
}

const key = { webhook_url: 'https://lashtribe.example/hook', webhook_secret: 'whsec_test', revoked_at: null }
const delivery = (over = {}) => ({ id: 'd1', business_id: 'b1', api_key_id: 'k1', kind: 'message.delivered', status: 'pending', attempts: 0, next_attempt_at: iso(NOW - 1), payload: { type: 'message.delivered', data: { id: 'm1' } }, api_keys: key, ...over })

test('delivers a signed callback and marks it delivered', async () => {
  const state = { webhook_deliveries: [delivery()] }
  const calls = []
  const res = await processWebhookBatch({ supabase: fakeSupabase(state), now: () => NOW, fetch: async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, text: async () => '' } } })
  assert.equal(res.delivered, 1)
  assert.equal(state.webhook_deliveries[0].status, 'delivered')
  const { init } = calls[0]
  assert.equal(init.headers['X-Heysasa-Event'], 'message.delivered')
  const ts = init.headers['X-Heysasa-Timestamp']
  assert.equal(init.headers['X-Heysasa-Signature'], `v1=${signWebhook('whsec_test', ts, init.body)}`)
  assert.equal(JSON.parse(init.body).delivery_id, 'd1')
})

test('a failing receiver is retried with back-off, then given up', async () => {
  const state = { webhook_deliveries: [delivery()] }
  const deps = { supabase: fakeSupabase(state), now: () => NOW, fetch: async () => ({ ok: false, status: 500, text: async () => 'boom' }) }
  const res = await processWebhookBatch(deps)
  const row = state.webhook_deliveries[0]
  assert.equal(row.status, 'pending')
  assert.equal(row.attempts, 1)
  assert.equal(row.next_attempt_at, iso(NOW + RETRY_DELAYS_MS[0]))
  assert.ok(res.wakeAt >= NOW + RETRY_DELAYS_MS[0])
  row.attempts = RETRY_DELAYS_MS.length
  row.next_attempt_at = iso(NOW - 1)
  await processWebhookBatch(deps)
  assert.equal(row.status, 'failed')
  assert.match(row.last_error, /^500/)
})

test('a revoked key or a removed webhook fails the row without calling out', async () => {
  const state = { webhook_deliveries: [delivery({ api_keys: { ...key, revoked_at: iso(NOW) } })] }
  let called = false
  await processWebhookBatch({ supabase: fakeSupabase(state), now: () => NOW, fetch: async () => { called = true } })
  assert.equal(called, false)
  assert.equal(state.webhook_deliveries[0].status, 'failed')
})
