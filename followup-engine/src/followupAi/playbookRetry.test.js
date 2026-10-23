import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldRetryFailed, wantsGeneration } from './playbookRules.js'

test('a failed playbook retries only when a lead arrived after the failure', () => {
  const failedAt = '2026-10-21T10:00:00Z'
  assert.equal(shouldRetryFailed({ failedAt, latestLeadAt: '2026-10-21T10:00:01Z' }), true)
  assert.equal(shouldRetryFailed({ failedAt, latestLeadAt: '2026-10-21T09:59:59Z' }), false)
  assert.equal(shouldRetryFailed({ failedAt, latestLeadAt: failedAt }), false)
})

test('no timestamps means no retry', () => {
  assert.equal(shouldRetryFailed({ failedAt: null, latestLeadAt: '2026-10-21T10:00:00Z' }), false)
  assert.equal(shouldRetryFailed({ failedAt: '2026-10-21T10:00:00Z', latestLeadAt: null }), false)
  assert.equal(shouldRetryFailed({}), false)
})

test('only waiting or owner-edited playbooks start generation, never one being written or just failed', () => {
  assert.equal(wantsGeneration({ status: 'pending' }), true)
  assert.equal(wantsGeneration({ status: 'review', regenerate_requested_at: '2026-10-21T10:00:00Z' }), true)
  assert.equal(wantsGeneration({ status: 'failed', regenerate_requested_at: '2026-10-21T10:00:00Z' }), true) // owner edit
  assert.equal(wantsGeneration({ status: 'generating', regenerate_requested_at: '2026-10-21T10:00:00Z' }), false)
  assert.equal(wantsGeneration({ status: 'failed', regenerate_requested_at: null }), false)  // the engine's own failure update
  assert.equal(wantsGeneration({ status: 'review', regenerate_requested_at: null }), false)
  assert.equal(wantsGeneration(null), false)
})
