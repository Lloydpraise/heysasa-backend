import test from 'node:test'
import assert from 'node:assert/strict'
import { planStageChange, applyStageRequest, stageField, STAGES, AI_CEILING } from './stageRequests.js'

test('planStageChange: vocabulary, ceiling, and no-ops for each business type', () => {
  assert.deepEqual(planStageChange({ businessType: 'ecommerce', current: 'browsing', requested: 'Intent ' }), { action: 'apply', stage: 'intent' })
  assert.deepEqual(planStageChange({ businessType: 'ecommerce', current: 'intent', requested: 'intent' }), { action: 'unchanged', stage: 'intent' })
  assert.deepEqual(planStageChange({ businessType: 'ecommerce', current: 'intent', requested: 'paid' }), { action: 'reject', reason: 'needs_real_event' })
  assert.deepEqual(planStageChange({ businessType: 'ecommerce', current: null, requested: 'negotiation' }), { action: 'reject', reason: 'unknown_stage' })
  assert.deepEqual(planStageChange({ businessType: 'salon', current: 'qualified', requested: 'negotiation' }), { action: 'apply', stage: 'negotiation' })
  assert.deepEqual(planStageChange({ businessType: 'salon', current: 'proposal', requested: 'committed' }), { action: 'apply', stage: 'committed' })
  assert.deepEqual(planStageChange({ businessType: 'salon', current: 'proposal', requested: 'completed' }), { action: 'reject', reason: 'needs_real_event' })
  assert.deepEqual(planStageChange({ businessType: 'salon', current: 'negotiation', requested: 'discovery' }), { action: 'apply', stage: 'discovery' })   // moving back is allowed
  assert.equal(planStageChange({ businessType: 'salon', current: null, requested: '' }).reason, 'unknown_stage')
  for (const type of ['ecommerce', 'service']) assert.ok(STAGES[type].includes(AI_CEILING[type]))
  assert.equal(stageField('ecommerce'), 'lead_stage_ecom')
  assert.equal(stageField('salon'), 'lead_stage_service')
})

function world({ business = { business_type: 'salon' }, conversation = {}, billed = false } = {}) {
  const log = { set: [], charged: [], audit: [], finished: [] }
  const conv = { id: 'c1', business_id: 'b', contact_id: 7, lead_stage_service: 'qualified', lead_stage_ecom: null, is_business_chat: true, ...conversation }
  const deps = {
    getBusiness: async () => business,
    getConversation: async () => conv,
    setStage: async (id, field, stage) => { log.set.push([id, field, stage]) },
    billedBefore: async () => billed,
    charge: async (...args) => { log.charged.push(args) },
    audit: async (row) => { log.audit.push(row) },
    finish: async (id, patch) => { log.finished.push([id, patch]) },
  }
  return { deps, log }
}
const req = (over = {}) => ({ id: 1, business_id: 'b', contact_id: 7, conversation_id: 'c1', requested_stage: 'negotiation', reason: 'agreed to the price', actor: 'chat_ai', ...over })

test('apply: sets the stage, charges once, writes the audit row, marks the request applied', async () => {
  const w = world()
  await applyStageRequest(req(), w.deps)
  assert.deepEqual(w.log.set, [['c1', 'lead_stage_service', 'negotiation']])
  assert.equal(w.log.charged.length, 1)
  assert.deepEqual(w.log.charged[0], ['b', 7, 'qualified', 'negotiation', 'salon'])
  assert.equal(w.log.audit[0].reason, 'agreed to the price')
  assert.equal(w.log.audit[0].from_stage, 'qualified')
  assert.deepEqual(w.log.finished[0], [1, { status: 'applied', from_stage: 'qualified' }])
})

test('a stage already billed for this lead is not charged again', async () => {
  const w = world({ billed: true })
  await applyStageRequest(req(), w.deps)
  assert.equal(w.log.charged.length, 0)
  assert.equal(w.log.finished[0][1].status, 'applied')
})

test('a failing charge never blocks the stage change', async () => {
  const w = world()
  w.deps.charge = async () => { throw new Error('wallet down') }
  await applyStageRequest(req(), w.deps)
  assert.equal(w.log.finished[0][1].status, 'applied')
})

test('rejects: too far, wrong lead, personal chat, missing rows, no-op', async () => {
  let w = world(); await applyStageRequest(req({ requested_stage: 'completed' }), w.deps)
  assert.deepEqual(w.log.finished[0][1], { status: 'rejected', reject_reason: 'needs_real_event' }); assert.equal(w.log.set.length, 0)

  w = world({ conversation: { contact_id: 99 } }); await applyStageRequest(req(), w.deps)
  assert.equal(w.log.finished[0][1].reject_reason, 'not_found')

  w = world({ conversation: { business_id: 'other' } }); await applyStageRequest(req(), w.deps)
  assert.equal(w.log.finished[0][1].reject_reason, 'not_found')

  w = world({ conversation: { is_business_chat: false } }); await applyStageRequest(req(), w.deps)
  assert.equal(w.log.finished[0][1].reject_reason, 'not_a_business_chat')

  w = world({ business: null }); await applyStageRequest(req(), w.deps)
  assert.equal(w.log.finished[0][1].reject_reason, 'not_found')

  w = world({ conversation: { lead_stage_service: 'negotiation' } }); await applyStageRequest(req(), w.deps)
  assert.deepEqual(w.log.finished[0][1], { status: 'unchanged', from_stage: 'negotiation' }); assert.equal(w.log.audit.length, 0)
})

test('ecommerce uses its own stage column', async () => {
  const w = world({ business: { business_type: 'ecommerce' }, conversation: { lead_stage_ecom: 'browsing' } })
  await applyStageRequest(req({ requested_stage: 'checkout' }), w.deps)
  assert.deepEqual(w.log.set, [['c1', 'lead_stage_ecom', 'checkout']])
})
