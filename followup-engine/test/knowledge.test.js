import test from 'node:test'
import assert from 'node:assert/strict'
process.env.SUPABASE_URL ??= 'http://localhost'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test'
const { loadFollowupKnowledge, _resetKnowledgeCache } = await import('../src/lib/knowledge.js')

function db({ sources = [], chunks = [] } = {}) {
  const calls = []
  const q = { filters: {} }
  const api = {
    select() { return api }, eq(c, v) { q.filters[c] = v; return api }, in(c, v) { q.filters[c] = v; return api },
    order() { return api }, limit: async () => ({ data: sources, error: null }),
  }
  return {
    calls, from: () => api,
    rpc: async (fn, args) => { calls.push([fn, args]); return { data: chunks, error: null } },
  }
}
const deps = { embed: async () => [0.1, 0.2], now: () => 0 }

test('a business with no follow-up files costs nothing: no block, no embedding call', async () => {
  _resetKnowledgeCache()
  let embedded = 0
  const out = await loadFollowupKnowledge(db(), { businessId: 'b1', queryText: 'customer asked about price', deps: { ...deps, embed: async () => { embedded++; return [1] } } })
  assert.deepEqual(out, { block: '', facts: '' })
  assert.equal(embedded, 0)
})

test('the menu lists the files, and the best pieces for this lead are added and counted as facts', async () => {
  _resetKnowledgeCache()
  const d = db({
    sources: [{ id: 'k1', title: 'Follow-up SOP', use_case: 'Use for any lead that went quiet', file_type: 'pdf' }],
    chunks: [{ title: 'Follow-up SOP', content: 'After two days of silence, send the discount reminder once.' }],
  })
  const out = await loadFollowupKnowledge(d, { businessId: 'b1', queryText: 'lead has been quiet for two days', deps })
  assert.match(out.block, /Follow-up SOP: Use for any lead that went quiet/)
  assert.match(out.block, /MOST RELEVANT PARTS FOR THIS LEAD/)
  assert.match(out.facts, /discount reminder/)
  assert.equal(d.calls[0][1].p_bot, 'followup', 'only files meant for the follow-up AI')
})

test('if searching fails the menu still goes out, and if everything fails the follow-up is simply written without files', async () => {
  _resetKnowledgeCache()
  const sources = [{ id: 'k1', title: 'SOP', use_case: '', file_type: 'pdf' }]
  const noSearch = await loadFollowupKnowledge(db({ sources }), { businessId: 'b1', queryText: 'a quiet lead here', deps: { ...deps, embed: async () => null } })
  assert.match(noSearch.block, /- SOP/)
  _resetKnowledgeCache()
  const broken = { from: () => { throw new Error('db down') } }
  assert.deepEqual(await loadFollowupKnowledge(broken, { businessId: 'b1', queryText: 'x', deps }), { block: '', facts: '' })
})
