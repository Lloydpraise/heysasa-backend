import test from 'node:test'
import assert from 'node:assert/strict'
import { checkAntiban, recordSend, recordFailedAttempt, _resetAntibanForTests } from '../src/sender-baileys/antiban.js'
import { decideRetry, classifyFailure } from '../src/lib/sendFailures.js'
import { ensureNumberOnWhatsApp, _resetNumberCheckForTests } from '../src/lib/numberCheck.js'
import { nextAwakeAt } from '../src/lib/wakeTimes.js'

test('a failed attempt closes the antiban gap just like a send', () => {
  _resetAntibanForTests()
  assert.equal(checkAntiban('b', 100).allowed, true)
  recordFailedAttempt('b', 'unknown')
  const gate = checkAntiban('b', 100)
  assert.equal(gate.allowed, false)
  assert.equal(gate.reason, 'gap')
})

test('repeated connection failures put the business on a growing cool-down; a success clears it', () => {
  _resetAntibanForTests()
  assert.equal(recordFailedAttempt('b', 'instance_down'), 0, 'first one only paces')
  const second = recordFailedAttempt('b', 'instance_down')
  assert.equal(second, 5 * 60_000)
  const third = recordFailedAttempt('b', 'timeout')
  assert.equal(third, 10 * 60_000)
  const gate = checkAntiban('b', 100)
  assert.equal(gate.allowed, false)
  assert.equal(gate.reason, 'cooldown')
  recordSend('b')
  assert.notEqual(checkAntiban('b', 100).reason, 'cooldown')
})

test('rate_limited cools the business down for an hour straight away; a lead-specific failure never does', () => {
  _resetAntibanForTests()
  assert.equal(recordFailedAttempt('b', 'rate_limited'), 60 * 60_000)
  _resetAntibanForTests()
  assert.equal(recordFailedAttempt('b', 'invalid_number'), 0)
  assert.equal(recordFailedAttempt('b', 'invalid_number'), 0)
})

test('instance_down never counts against the lead and never gives up', () => {
  assert.equal(classifyFailure('connection closed'), 'instance_down')
  for (const n of [1, 5, 50]) {
    const d = decideRetry('connection closed', n)
    assert.equal(d.giveUp, false)
    assert.equal(d.countsAttempt, false)
    assert.equal(d.retryInMs, 10 * 60_000)
  }
  assert.equal(decideRetry('500: boom', 1).countsAttempt, true)
})

test('number lookup is asked once: when WhatsApp cannot answer it is not retried and the send goes ahead', async () => {
  _resetNumberCheckForTests()
  const realFetch = globalThis.fetch
  let lookups = 0
  globalThis.fetch = async () => { lookups++; return { ok: false, status: 500, json: async () => null } }
  const updates = []
  const supabase = {
    from: () => {
      const b = { select: () => b, eq: () => b, gte: () => b, order: () => b, limit: async () => ({ data: [], error: null }),
        update: (p) => { updates.push(p); return { eq: async () => ({}) } } }
      return b
    }
  }
  try {
    const contact = { id: 1, phone: '+254711000001', country_code: 'KE', wa_exists: null, wa_checked_at: null }
    const res = await ensureNumberOnWhatsApp(supabase, { instanceName: 'i', contact, businessId: 'b1' })
    assert.equal(res.status, 'ok')
    assert.equal(lookups, 1)
    assert.ok(updates[0].wa_checked_at, 'the attempt is recorded')
    assert.equal('wa_exists' in updates[0], false)
    // the same contact later (already recorded as asked): no second lookup
    const again = await ensureNumberOnWhatsApp(supabase, { instanceName: 'i', contact: { ...contact, wa_checked_at: updates[0].wa_checked_at }, businessId: 'b1' })
    assert.equal(again.status, 'ok')
    assert.equal(lookups, 1)
  } finally { globalThis.fetch = realFetch }
})

test('nextAwakeAt finds when quiet hours end', () => {
  const business = { timezone: 'Africa/Nairobi', followup_quiet_start: 21, followup_quiet_end: 8, followup_active_days: null }
  const at = nextAwakeAt(business, Date.parse('2026-10-23T19:00:00Z')) // 22:00 Nairobi
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Africa/Nairobi' }).format(at))
  assert.ok(hour >= 8 && hour <= 9, `woke at hour ${hour}`)
})
