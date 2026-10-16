import test from 'node:test'
import assert from 'node:assert/strict'
import { createSetupWatch } from '../src/followupAi/setupWatch.js'
import { readStageAsk, requestStageChange } from '../src/followupAi/stageAsk.js'
import { normalizeDecision } from '../src/followupAi/decision.js'

test('setup watch: fires once when Home becomes ready and once when setup is done', () => {
  const w = createSetupWatch()
  assert.equal(w.reachedMoment({ business_id: 'a', status: 'waiting_history' }), false)
  assert.equal(w.reachedMoment({ business_id: 'a', status: 'running' }), false)
  assert.equal(w.reachedMoment({ business_id: 'a', status: 'home_ready' }), true)
  assert.equal(w.reachedMoment({ business_id: 'a', status: 'home_ready' }), false, 'same status again (bundle counters) is not a new moment')
  assert.equal(w.reachedMoment({ business_id: 'a', status: 'finishing' }), false)
  assert.equal(w.reachedMoment({ business_id: 'a', status: 'done' }), true)
  assert.equal(w.reachedMoment({ business_id: 'a', status: 'done' }), false)
})

test('setup watch: businesses are tracked separately, and junk rows are ignored', () => {
  const w = createSetupWatch()
  assert.equal(w.reachedMoment({ business_id: 'a', status: 'done' }), true)
  assert.equal(w.reachedMoment({ business_id: 'b', status: 'done' }), true)
  assert.equal(w.reachedMoment(null), false)
  assert.equal(w.reachedMoment({ status: 'done' }), false)
  assert.equal(w.reachedMoment({ business_id: 'c', status: 'failed' }), false)
})

test('stage ask: needs a plain stage name and a reason', () => {
  assert.deepEqual(readStageAsk({ stage: ' Intent ', stage_reason: 'asked how to pay' }), { stage: 'intent', reason: 'asked how to pay' })
  assert.equal(readStageAsk({ stage: 'intent' }), null)
  assert.equal(readStageAsk({ stage: 'intent', stage_reason: 'x' }), null)
  assert.equal(readStageAsk({ stage: '', stage_reason: 'asked how to pay' }), null)
  assert.equal(readStageAsk({ stage: 'drop table', stage_reason: 'asked how to pay' }), null)
  assert.equal(readStageAsk(null), null)
  assert.equal(readStageAsk({ stage: 'negotiation', stage_reason: 'a'.repeat(500) }).reason.length, 300)
})

test('director decision carries a stage ask on any real decision, never on a fallback', () => {
  const ctx = { remaining: [2, 3], currentStep: 2 }
  const raw = { decision: 'send', reason: 'fine', stage: 'checkout', stage_reason: 'asked for the till number' }
  assert.deepEqual(normalizeDecision(raw, ctx).stageAsk, { stage: 'checkout', reason: 'asked for the till number' })
  assert.deepEqual(normalizeDecision({ ...raw, decision: 'skip' }, ctx).stageAsk, { stage: 'checkout', reason: 'asked for the till number' })
  assert.equal(normalizeDecision({ decision: 'send' }, ctx).stageAsk, undefined)
  assert.equal(normalizeDecision({ decision: 'rewrite', stage: 'checkout', stage_reason: 'asked for the till number' }, ctx).stageAsk, undefined, 'rewrite without a message falls back, so the ask is dropped')
  assert.equal(normalizeDecision(null, ctx).stageAsk, undefined)
  // the old behaviour is untouched
  assert.equal(normalizeDecision({ decision: 'reorder', step_number: 3 }, ctx).stepNumber, 3)
})

function fakeSupabase({ insertError = null } = {}) {
  const log = []
  const filters = []
  const from = (table) => ({
    delete: () => {
      const chain = { eq: (k, v) => { filters.push([k, v]); return chain }, then: (ok) => ok({ error: null }) }
      log.push(['delete', table])
      return chain
    },
    insert: async (row) => { log.push(['insert', table, row]); return { error: insertError } },
  })
  return { from, log, filters }
}

test('requestStageChange: replaces the open ask for the conversation and writes the new one as the follow-up AI', async () => {
  const db = fakeSupabase()
  const result = await requestStageChange(db, { businessId: 'b1', contact: { id: 7 }, conv: { id: 'c9' }, ask: { stage: 'intent', reason: 'chose the red dress' } })
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(db.log[0], ['delete', 'lead_stage_requests'])
  assert.deepEqual(db.filters, [['business_id', 'b1'], ['conversation_id', 'c9'], ['status', 'pending']])
  assert.deepEqual(db.log[1][2], { business_id: 'b1', contact_id: 7, conversation_id: 'c9', requested_stage: 'intent', reason: 'chose the red dress', actor: 'followup_ai' })
})

test('requestStageChange: never throws and never asks for a non-business chat or an empty ask', async () => {
  assert.equal((await requestStageChange(fakeSupabase(), { businessId: 'b1', contact: { id: 7 }, conv: { id: 'c9' }, ask: null })).ok, false)
  assert.equal((await requestStageChange(fakeSupabase(), { businessId: 'b1', contact: { id: 7 }, conv: null, ask: { stage: 'intent', reason: 'abc' } })).ok, false)
  const personal = fakeSupabase()
  assert.equal((await requestStageChange(personal, { businessId: 'b1', contact: { id: 7 }, conv: { id: 'c9', is_business_chat: false }, ask: { stage: 'intent', reason: 'abc' } })).reason, 'not_a_business_chat')
  assert.equal(personal.log.length, 0)
  const failing = fakeSupabase({ insertError: { message: 'db down' } })
  assert.deepEqual(await requestStageChange(failing, { businessId: 'b1', contact: { id: 7 }, conv: { id: 'c9' }, ask: { stage: 'intent', reason: 'abc' } }), { ok: false, reason: 'db down' })
  const exploding = { from: () => { throw new Error('boom') } }
  assert.deepEqual(await requestStageChange(exploding, { businessId: 'b1', contact: { id: 7 }, conv: { id: 'c9' }, ask: { stage: 'intent', reason: 'abc' } }), { ok: false, reason: 'boom' })
})
