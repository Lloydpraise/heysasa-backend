import test from 'node:test'
import assert from 'node:assert/strict'

process.env.SUPABASE_URL ??= 'http://localhost'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test'
const { processChatAiOutbox, typingDelayMs, resetChatAiLaneState } = await import('../src/sender-baileys/chatAiOutbox.js')

// In-memory stand-in for the parts of the Supabase client the outbox worker uses.
function fakeSupabase(state) {
  return {
    from(table) {
      const q = { filters: [], op: 'select', payload: null, head: false, limitN: null, single: false, returning: false, orders: [] }
      const rows = () => state[table].filter(r => q.filters.every(f => f(r)))
      const api = {
        select(_cols, opts) { if (q.op === 'update') q.returning = true; q.head = !!opts?.head; return api },
        eq(col, val) { q.filters.push(r => r[col] === val); return api },
        in(col, vals) { q.filters.push(r => vals.includes(r[col])); return api },
        lte(col, val) { q.filters.push(r => r[col] != null && r[col] <= val); return api },
        gte(col, val) { q.filters.push(r => r[col] != null && r[col] >= val); return api },
        order(col) { q.orders.push(col); return api },
        limit(n) { q.limitN = n; return api },
        maybeSingle() { q.single = true; return api },
        update(payload) { q.op = 'update'; q.payload = payload; return api },
        upsert(payload, opts) { q.op = 'upsert'; q.payload = payload; q.onConflict = opts?.onConflict; return api },
        then(resolve) {
          if (q.op === 'update') { const hit = rows(); hit.forEach(r => Object.assign(r, q.payload)); return resolve({ data: q.single ? (hit[0] ?? null) : hit, error: null }) }
          if (q.op === 'upsert') {
            const i = state[table].findIndex(r => r[q.onConflict] === q.payload[q.onConflict])
            if (i >= 0) Object.assign(state[table][i], q.payload); else state[table].push({ ...q.payload })
            return resolve({ data: null, error: null })
          }
          let out = rows()
          for (const col of [...q.orders].reverse()) out = [...out].sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0))
          if (q.head) return resolve({ count: out.length, error: null })
          if (q.limitN) out = out.slice(0, q.limitN)
          return resolve({ data: q.single ? (out[0] ?? null) : out, error: null })
        },
      }
      return api
    },
  }
}

const T0 = Date.parse('2026-10-04T10:00:00Z')
const item = (over = {}) => ({ id: 'o1', business_id: 'b1', conversation_id: 'c1', contact_id: 7, seq: 0, kind: 'text', text: 'Hello', media: null, status: 'queued', attempts: 0, created_at: '2026-10-04T09:59:59Z', ...over })
const contact = { id: 7, business_id: 'b1', phone: '0712345678', country_code: '254', do_not_contact: false }

function setup(items, overrides = {}) {
  resetChatAiLaneState()
  const state = { chat_ai_outbox: items, whatsapp_sessions: [{ business_id: 'b1', status: 'connected', instance_name: 'heysasa_b1', updated_at: '2026-10-04T09:00:00Z' }], messages: [], follow_up_queue: [] }
  const sends = []
  let clock = T0
  const deps = {
    supabase: fakeSupabase(state),
    getContact: async () => contact,
    send: async (instance, number, content) => { sends.push({ instance, number, content }); return { ok: true, messageId: `W${sends.length}` } },
    now: () => clock, rand: () => 0,
    ...overrides,
  }
  return { state, sends, deps, advance: (ms) => { clock += ms } }
}

test('a queued reply is sent through the same Evolution sender, saved as chat_ai, and the outbox row is marked sent', async () => {
  const { state, sends, deps } = setup([item()])
  const r = await processChatAiOutbox(deps)
  assert.equal(r.sent, 1)
  assert.deepEqual([sends[0].instance, sends[0].number], ['heysasa_b1', '254712345678'])
  assert.equal(sends[0].content.text, 'Hello')
  assert.ok(sends[0].content.delay >= 700, 'typing time is set')
  assert.deepEqual([state.chat_ai_outbox[0].status, state.chat_ai_outbox[0].whatsapp_message_id], ['sent', 'W1'])
  assert.deepEqual([state.messages[0].agent_role, state.messages[0].role, state.messages[0].direction, state.messages[0].whatsapp_message_id], ['chat_ai', 'ai', 'out', 'W1'])
})

test('a product photo goes out as an image with its caption', async () => {
  const { sends, deps, state } = setup([item({ kind: 'image', text: null, media: { type: 'image', url: 'https://img.test/a.jpg', caption: 'Set\nKES 3,500' } })])
  await processChatAiOutbox(deps)
  assert.deepEqual(sends[0].content.media, { type: 'image', url: 'https://img.test/a.jpg', caption: 'Set\nKES 3,500', mime_type: undefined, file_name: undefined })
  assert.equal(state.messages[0].type, 'image')
  assert.equal(state.messages[0].content.text, 'Set\nKES 3,500')
})

test('a chat\'s messages go out in order, one per pass, with a gap between them', async () => {
  const { sends, deps, advance, state } = setup([
    item({ id: 'o1', seq: 0, text: 'photo caption' }), item({ id: 'o2', seq: 1, text: 'the reply', created_at: '2026-10-04T09:59:59Z' }),
  ])
  let r = await processChatAiOutbox(deps)
  assert.equal(r.sent, 1)
  r = await processChatAiOutbox(deps)
  assert.equal(r.sent, 0, 'second message waits for the gap')
  advance(2100)
  r = await processChatAiOutbox(deps)
  assert.equal(r.sent, 1)
  assert.deepEqual(sends.map((s) => s.content.text), ['photo caption', 'the reply'])
  assert.deepEqual(state.chat_ai_outbox.map((o) => o.status), ['sent', 'sent'])
})

test('chat AI sends never touch the follow-up queue or the follow-up antiban timers', async () => {
  const { state, deps } = setup([item()])
  await processChatAiOutbox(deps)
  assert.deepEqual(state.follow_up_queue, [])
  const antiban = await import('../src/sender-baileys/antiban.js')
  assert.equal(antiban.checkAntiban('b1', 40).allowed, true, 'a chat AI reply does not start the follow-up gap')
})

test('the hourly ceiling is counted from the chat AI outbox alone and fails the message with a clear reason', async () => {
  const sentBefore = Array.from({ length: 150 }, (_, i) => item({ id: `s${i}`, status: 'sent', sent_at: '2026-10-04T09:30:00Z', conversation_id: `x${i}` }))
  const { state, sends, deps } = setup([...sentBefore, item({ id: 'new' })])
  const r = await processChatAiOutbox(deps)
  assert.equal(sends.length, 0)
  assert.equal(r.failed, 1)
  assert.equal(state.chat_ai_outbox.find((o) => o.id === 'new').error, 'chat_ai_hourly_limit')
})

test('failures are recorded with their reason and never retried', async () => {
  const noTarget = setup([item()], { getContact: async () => ({ ...contact, phone: null, social_id: null }) })
  await processChatAiOutbox(noTarget.deps)
  assert.equal(noTarget.state.chat_ai_outbox[0].error, 'no_send_target')

  const optedOut = setup([item()], { getContact: async () => ({ ...contact, do_not_contact: true }) })
  await processChatAiOutbox(optedOut.deps)
  assert.equal(optedOut.state.chat_ai_outbox[0].error, 'do_not_contact')

  const offline = setup([item()])
  offline.state.whatsapp_sessions[0].status = 'disconnected'
  await processChatAiOutbox(offline.deps)
  assert.equal(offline.state.chat_ai_outbox[0].error, 'whatsapp_not_connected')

  const rejected = setup([item()], { send: async () => ({ ok: false, error: '400: bad number' }) })
  await processChatAiOutbox(rejected.deps)
  assert.deepEqual([rejected.state.chat_ai_outbox[0].status, rejected.state.chat_ai_outbox[0].error], ['failed', '400: bad number'])
  rejected.advance(60_000)
  const again = await processChatAiOutbox(rejected.deps)
  assert.equal(again.sent + again.failed, 0, 'a failed message is not picked up again')
})

test('a message the brain already cancelled is not sent, and a stuck "sending" row is failed, not re-sent', async () => {
  const cancelled = setup([item({ status: 'failed', error: 'timed_out_waiting_for_sender' })])
  const r = await processChatAiOutbox(cancelled.deps)
  assert.equal(cancelled.sends.length + r.sent, 0)

  const stuck = setup([item({ status: 'sending', claimed_at: '2026-10-04T09:50:00.000Z' })])
  await processChatAiOutbox(stuck.deps)
  assert.deepEqual([stuck.state.chat_ai_outbox[0].status, stuck.state.chat_ai_outbox[0].error, stuck.sends.length], ['failed', 'stale_sending_claim', 0])
})

test('typing time grows with the message length and never exceeds five seconds', () => {
  assert.ok(typingDelayMs('ok', () => 0) < typingDelayMs('x'.repeat(120), () => 0))
  assert.equal(typingDelayMs('x'.repeat(5000), () => 1), 5000)
})
