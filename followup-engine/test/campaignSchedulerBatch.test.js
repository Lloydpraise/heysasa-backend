import test from 'node:test'
import assert from 'node:assert/strict'
import { runCampaignScheduler } from '../src/scheduler/campaignScheduler.js'

// In-memory stand-in for the supabase-js query builder (select/in/eq/or/update/insert/rpc), counting every request.
function fakeDb(tables) {
  const requests = []
  const from = (name) => {
    const q = { name, op: 'select', filters: [], payload: null, limit: null }
    const run = () => {
      requests.push({ table: name, op: q.op, payload: q.payload, filters: q.filters })
      const rows = tables[name] ?? (tables[name] = [])
      const match = (r) => q.filters.every(([t, c, v]) => (t === 'in' ? v.includes(r[c]) : r[c] === v))
      if (q.op === 'select') return { data: rows.filter(match).slice(0, q.limit ?? 1000), error: null }
      if (q.op === 'update') { const hit = rows.filter(match); hit.forEach(r => Object.assign(r, q.payload)); return { data: hit, error: null } }
      if (q.op === 'insert') {
        const list = Array.isArray(q.payload) ? q.payload : [q.payload]
        if (q.failIf?.(list)) return { data: null, error: { message: 'insert rejected', code: '23505' } }
        list.forEach((r, i) => rows.push({ id: `q${rows.length + i}`, ...r }))
        return { data: null, error: null }
      }
      return { data: null, error: null }
    }
    const b = {
      select() { return b }, limit(n) { q.limit = n; return b }, or() { return b },
      in(c, v) { q.filters.push(['in', c, v]); return b },
      eq(c, v) { q.filters.push(['eq', c, v]); return b },
      update(p) { q.op = 'update'; q.payload = p; return b },
      insert(p) { q.op = 'insert'; q.payload = p; q.failIf = tables.__failInsert; return b },
      then(res, rej) { return Promise.resolve(run()).then(res, rej) },
    }
    return b
  }
  return { requests, from, rpc: async (fn, args) => { requests.push({ rpc: fn, args }); return { error: null } } }
}

function scenario({ contacts = 300 } = {}) {
  const tables = {
    businesses: [{ business_id: 'biz', followup_ai_enabled: true, timezone: 'Africa/Nairobi', followup_quiet_start: 0, followup_quiet_end: 0, followup_active_days: null }],
    campaigns: [{ id: 'camp', business_id: 'biz', status: 'active', whatsapp_instance_name: 'inst' }],
    whatsapp_sessions: [{ business_id: 'biz', instance_name: 'inst', status: 'connected' }],
    campaign_steps: [
      { campaign_id: 'camp', step_number: 1, content: 'Hi {{name}}', media: null, delay_hours: 0 },
      { campaign_id: 'camp', step_number: 2, content: 'Follow up', media: null, delay_hours: 24 },
    ],
    campaign_enrollments: [], contacts: [], conversations: [], follow_up_queue: [],
  }
  for (let i = 1; i <= contacts; i++) {
    tables.contacts.push({ id: i, business_id: 'biz', name: `C${i}`, phone: `+2547000${i}`, wa_exists: i % 100 === 0 ? false : true, lead_type: 'business' })
    tables.campaign_enrollments.push({ id: `e${i}`, campaign_id: 'camp', lead_id: i, current_step: 0, status: 'pending' })
    if (i % 2 === 0) tables.conversations.push({ id: 1000 + i, contact_id: i, business_id: 'biz' })
  }
  return tables
}

test('300 due enrollments are queued with a handful of requests, not ~6 per enrollment', async () => {
  const tables = scenario()
  tables.follow_up_queue.push({ id: 'old', campaign_id: 'camp', contact_id: 5, campaign_step: 1, status: 'sent' })   // already queued -> skipped
  tables.campaign_enrollments.push({ id: 'done', campaign_id: 'camp', lead_id: 1, current_step: 2, status: 'active' }) // no step 3 -> completed
  const db = fakeDb(tables)
  const result = await runCampaignScheduler(db, { seed: false })

  // 300 enrollments - 3 wa_exists=false (100,200,300) - 1 already queued
  assert.equal(result.queued, 296)
  assert.equal(tables.follow_up_queue.filter(r => r.status === 'pending').length, 296)
  assert.ok(db.requests.length < 30, `expected < 30 requests, got ${db.requests.length}`)

  const queued = tables.follow_up_queue.filter(r => r.id !== 'old')
  assert.equal(queued.find(r => r.contact_id === 2).conversation_id, 1002, 'conversation attached')
  assert.equal(queued.find(r => r.contact_id === 3).conversation_id, null)
  assert.equal(queued.find(r => r.contact_id === 7).final_message.includes('C7') || queued.find(r => r.contact_id === 7).final_message.length > 0, true)
  assert.equal(queued[0].touchpoint_type, 'campaign')
  assert.equal(queued[0].assigned_instance_name, 'inst')
  assert.equal(queued[0].approval_status, 'approved')

  const byId = Object.fromEntries(tables.campaign_enrollments.map(e => [e.id, e.status]))
  assert.equal(byId.e1, 'active')
  assert.equal(byId.e100, 'exited')
  assert.equal(byId.e5, 'pending', 'dedupe-skipped enrollment is left alone, as before')
  assert.equal(byId.done, 'completed')
  assert.ok(db.requests.some(r => r.rpc === 'complete_campaign_if_finished'))
})

test('a rejected bulk insert is retried row by row so one bad row cannot block the rest', async () => {
  const tables = scenario({ contacts: 20 })
  tables.__failInsert = (list) => list.length > 1 || list[0].contact_id === 7
  const db = fakeDb(tables)
  const result = await runCampaignScheduler(db, { seed: false })
  assert.equal(result.queued, 19)
  assert.equal(tables.follow_up_queue.some(r => r.contact_id === 7), false)
  assert.equal(tables.campaign_enrollments.find(e => e.id === 'e7').status, 'pending')
  assert.equal(tables.campaign_enrollments.find(e => e.id === 'e8').status, 'active')
})

test('paused campaign, or one whose WhatsApp session is not connected, queues nothing', async () => {
  const t1 = scenario({ contacts: 5 }); t1.campaigns[0].status = 'paused'
  assert.equal((await runCampaignScheduler(fakeDb(t1), { seed: false })).queued, 0)
  const t2 = scenario({ contacts: 5 }); t2.whatsapp_sessions[0].status = 'disconnected'
  assert.equal((await runCampaignScheduler(fakeDb(t2), { seed: false })).queued, 0)
  assert.equal(t2.follow_up_queue.length, 0)
})
