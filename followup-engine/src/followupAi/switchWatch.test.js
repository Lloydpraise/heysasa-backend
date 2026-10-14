import test from 'node:test'
import assert from 'node:assert/strict'
import { createSwitchWatch } from './switchWatch.js'

test('fires once when the Follow-up AI is switched on, not on every later change', () => {
  const w = createSwitchWatch()
  assert.equal(w.switchedOn({ business_id: 'a', followup_ai_enabled: false }), false)
  assert.equal(w.switchedOn({ business_id: 'a', followup_ai_enabled: true }), true)
  assert.equal(w.switchedOn({ business_id: 'a', followup_ai_enabled: true }), false)   // e.g. a send counter changed
  assert.equal(w.switchedOn({ business_id: 'a', followup_ai_enabled: false }), false)
  assert.equal(w.switchedOn({ business_id: 'a', followup_ai_enabled: true }), true)    // switched on again
})

test('businesses are tracked separately and bad rows are ignored', () => {
  const w = createSwitchWatch()
  assert.equal(w.switchedOn({ business_id: 'a', followup_ai_enabled: true }), true)
  assert.equal(w.switchedOn({ business_id: 'b', followup_ai_enabled: true }), true)
  assert.equal(w.switchedOn(null), false)
  assert.equal(w.switchedOn({ followup_ai_enabled: true }), false)
  assert.equal(w.switchedOn({ business_id: 'c' }), false)
})
