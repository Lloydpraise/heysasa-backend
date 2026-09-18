import test from 'node:test'
import assert from 'node:assert/strict'
import { getSessionHealthDecision } from '../src/lib/instanceHealth.js'

test('session-closed state is treated as locked and never as campaign pause/fail', () => {
  assert.equal(getSessionHealthDecision('disconnected', false), 'locked')
  assert.equal(getSessionHealthDecision('connected', false), 'ok')
  assert.equal(getSessionHealthDecision('unknown', false), 'retry')
})
