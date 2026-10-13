import test from 'node:test'
import assert from 'node:assert/strict'
import { createDbGuard, describeRequest } from '../src/lib/dbGuard.js'

const res = (status, body = '') => new Response(body, { status })

test('describeRequest names the table or rpc', () => {
  assert.equal(describeRequest('https://x.supabase.co/rest/v1/conversations?select=id').key, 'GET conversations')
  assert.equal(describeRequest('https://x.supabase.co/rest/v1/rpc/bulk_patch_rows', { method: 'post' }).key, 'POST rpc:bulk_patch_rows')
})

test('identical errors are logged once per minute with a repeat count, and counted in stats', async () => {
  const logs = []
  const guard = createDbGuard({
    label: 't', env: { SUPABASE_MAX_RPS: '100000' },
    onLog: (level, event, message) => logs.push({ level, event, message }),
    fetchImpl: async () => res(400, '{"code":"42703","message":"column conversations.lead_state does not exist"}'),
  })
  for (let i = 0; i < 50; i++) await guard.fetch(`https://x.supabase.co/rest/v1/conversations?contact_id=eq.${i}`)
  const errors = logs.filter(l => l.event === 'db.error')
  assert.equal(errors.length, 1)
  assert.match(errors[0].message, /lead_state does not exist/)
  guard.flushStats()
  const stats = logs.find(l => l.event === 'db.stats' || l.event === 'db.high_volume')
  assert.match(stats.message, /GET conversations=50\(50 err\)/)
})

test('100 consecutive failures open the breaker for that endpoint only; a success resets the streak', async () => {
  const logs = []
  let ok = false
  let calls = 0
  const guard = createDbGuard({
    label: 't', env: { SUPABASE_MAX_RPS: '100000' }, onLog: (l, e) => logs.push(e),
    fetchImpl: async (url) => { calls++; return String(url).includes('/other') ? res(200, '[]') : (ok ? res(200, '[]') : res(400, 'bad')) },
  })
  for (let i = 0; i < 99; i++) await guard.fetch('https://x/rest/v1/a')
  ok = true; await guard.fetch('https://x/rest/v1/a'); ok = false          // streak reset
  for (let i = 0; i < 100; i++) await guard.fetch('https://x/rest/v1/a')
  assert.ok(logs.includes('db.circuit_open'))
  const before = calls
  const blocked = await guard.fetch('https://x/rest/v1/a')
  assert.equal(blocked.status, 503)
  assert.equal(calls, before, 'blocked call never reaches Supabase')
  assert.equal((await guard.fetch('https://x/rest/v1/other')).status, 200, 'other endpoints unaffected')
})

test('a single() lookup that finds nothing (406) is not a failure streak', async () => {
  const logs = []
  const guard = createDbGuard({ label: 't', env: { SUPABASE_MAX_RPS: '100000' }, onLog: (l, e) => logs.push(e), fetchImpl: async () => res(406, '{}') })
  for (let i = 0; i < 300; i++) await guard.fetch('https://x/rest/v1/contacts?id=eq.1')
  assert.ok(!logs.includes('db.circuit_open'))
})

test('the rate cap delays calls instead of dropping them', async () => {
  const guard = createDbGuard({ label: 't', env: { SUPABASE_MAX_RPS: '50' }, fetchImpl: async () => res(200, '[]') })
  const start = Date.now()
  const out = await Promise.all(Array.from({ length: 11 }, () => guard.fetch('https://x/rest/v1/a')))
  assert.equal(out.length, 11)
  assert.ok(Date.now() - start >= 180, 'about 10 gaps of 20ms')
})
