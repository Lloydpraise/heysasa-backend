import test from 'node:test'
import assert from 'node:assert/strict'
import { runStageClassifier } from '../src/scheduler/stageClassifier.js'
import { setOpenAIUnavailable, clearOpenAIUnavailable } from '../src/lib/openAiGate.js'

// Minimal in-memory stand-in for the parts of the Supabase client the classifier uses.
function fakeSupabase(state) {
  return {
    from(table) {
      const q = { filters: [], op: 'select', payload: null, head: false, limitN: null }
      const rows = () => state[table].filter(r => q.filters.every(f => f(r)))
      const api = {
        select(_cols, opts) { if (q.op !== 'update') q.op = 'select'; q.head = !!opts?.head; return api },
        not(col) { q.filters.push(r => r[col] !== null && r[col] !== undefined); return api },
        lte(col, val) { q.filters.push(r => r[col] <= val); return api },
        eq(col, val) { q.filters.push(r => r[col] === val); return api },
        order() { return api },
        limit(n) { q.limitN = n; return api },
        update(payload) { q.op = 'update'; q.payload = payload; return api },
        then(resolve, reject) {
          try {
            if (q.op === 'update') { rows().forEach(r => Object.assign(r, q.payload)); return resolve({ data: null, error: null }) }
            const matched = rows()
            if (q.head) return resolve({ count: matched.length, error: null })
            return resolve({ data: q.limitN ? matched.slice(0, q.limitN) : matched, error: null })
          } catch (e) { reject(e) }
        },
      }
      return api
    },
  }
}

const longAgo = () => new Date(Date.now() - 10 * 60_000).toISOString()
const conv = (over = {}) => ({
  id: 'c1', business_id: 'b1', contact_id: 1, lead_stage_ecom: 'browsing', lead_stage_service: null,
  is_business_chat: true, stage_review_requested_at: longAgo(), stage_review_reason: 'responded', ...over,
})

function makeDeps(state, { answer = '{"lead_stage":"checkout","confidence":"high"}', onCall } = {}) {
  const deps = {
    calls: 0, charges: [],
    getBusiness: async () => ({ business_id: 'b1', business_type: 'ecommerce' }),
    getMessages: async () => [{ direction: 'in', content: { text: 'I want to pay' }, type: 'text' }],
    callBot: async () => { deps.calls++; if (onCall) onCall(); return answer },
    chargeLeadStageChange: async (_s, businessId, contactId, from, to) => {
      deps.charges.push({ from, to })
      state.followup_billing_events.push({ business_id: businessId, contact_id: contactId, to_stage: to })
    },
  }
  return deps
}

test.beforeEach(() => clearOpenAIUnavailable())

test('no lead activity means no OpenAI call', async () => {
  const state = { conversations: [conv({ stage_review_requested_at: null })], followup_billing_events: [] }
  const deps = makeDeps(state)
  const out = await runStageClassifier(fakeSupabase(state), deps)
  assert.equal(deps.calls, 0)
  assert.equal(out.classified, 0)
})

test('a response inside the debounce window is not classified yet', async () => {
  const state = { conversations: [conv({ stage_review_requested_at: new Date().toISOString() })], followup_billing_events: [] }
  const deps = makeDeps(state)
  await runStageClassifier(fakeSupabase(state), deps)
  assert.equal(deps.calls, 0)
  assert.ok(state.conversations[0].stage_review_requested_at, 'stays queued')
})

test('a due response is classified exactly once, stage saved, request cleared', async () => {
  const state = { conversations: [conv()], followup_billing_events: [] }
  const deps = makeDeps(state)
  const sb = fakeSupabase(state)
  await runStageClassifier(sb, deps)
  assert.equal(deps.calls, 1)
  assert.equal(state.conversations[0].lead_stage_ecom, 'checkout')
  assert.equal(state.conversations[0].stage_review_requested_at, null)
  // The next tick finds nothing to do: this is the "not called every 60s" guarantee.
  await runStageClassifier(sb, deps)
  await runStageClassifier(sb, deps)
  assert.equal(deps.calls, 1)
})

test('personal/junk chats are cleared without an OpenAI call', async () => {
  const state = { conversations: [conv({ is_business_chat: false })], followup_billing_events: [] }
  const deps = makeDeps(state)
  await runStageClassifier(fakeSupabase(state), deps)
  assert.equal(deps.calls, 0)
  assert.equal(state.conversations[0].stage_review_requested_at, null)
})

test('a message that arrives mid-classification stays queued (no lost update)', async () => {
  const state = { conversations: [conv()], followup_billing_events: [] }
  const newer = new Date().toISOString()
  const deps = makeDeps(state, { onCall: () => { state.conversations[0].stage_review_requested_at = newer } })
  await runStageClassifier(fakeSupabase(state), deps)
  assert.equal(state.conversations[0].stage_review_requested_at, newer, 'the newer request must survive')
})

test('re-advancing to an already-charged stage is not billed twice', async () => {
  const state = { conversations: [conv({ lead_stage_ecom: 'browsing' })], followup_billing_events: [{ business_id: 'b1', contact_id: 1, to_stage: 'checkout' }] }
  const deps = makeDeps(state)
  await runStageClassifier(fakeSupabase(state), deps)
  assert.equal(state.conversations[0].lead_stage_ecom, 'checkout')
  assert.equal(deps.charges.length, 0)
})

test('first advance to a stage is billed once', async () => {
  const state = { conversations: [conv()], followup_billing_events: [] }
  const deps = makeDeps(state)
  await runStageClassifier(fakeSupabase(state), deps)
  assert.deepEqual(deps.charges, [{ from: 'browsing', to: 'checkout' }])
})

test('low-confidence answers do not change the stage but are cleared', async () => {
  const state = { conversations: [conv()], followup_billing_events: [] }
  const deps = makeDeps(state, { answer: '{"lead_stage":"paid","confidence":"low"}' })
  await runStageClassifier(fakeSupabase(state), deps)
  assert.equal(state.conversations[0].lead_stage_ecom, 'browsing')
  assert.equal(state.conversations[0].stage_review_requested_at, null)
})

test('failed AI calls keep the request queued, then give up after 3 tries', async () => {
  const state = { conversations: [conv({ id: 'fail-conv' })], followup_billing_events: [] }
  const deps = makeDeps(state, { answer: null })
  const sb = fakeSupabase(state)
  await runStageClassifier(sb, deps)
  assert.ok(state.conversations[0].stage_review_requested_at, 'still queued after 1st failure')
  await runStageClassifier(sb, deps)
  assert.ok(state.conversations[0].stage_review_requested_at, 'still queued after 2nd failure')
  await runStageClassifier(sb, deps)
  assert.equal(state.conversations[0].stage_review_requested_at, null, 'released after 3rd failure')
})

test('while OpenAI is latched off nothing is queried, called, or lost', async () => {
  const state = { conversations: [conv()], followup_billing_events: [] }
  const deps = makeDeps(state)
  setOpenAIUnavailable({ status: 429, reason: 'insufficient_quota' })
  const out = await runStageClassifier(fakeSupabase(state), deps)
  assert.equal(deps.calls, 0)
  assert.equal(out.classified, 0)
  assert.ok(state.conversations[0].stage_review_requested_at, 'request preserved for when AI is back')
})
