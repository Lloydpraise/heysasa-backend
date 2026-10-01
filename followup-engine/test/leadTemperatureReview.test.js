import test from 'node:test'
import assert from 'node:assert/strict'
import { runLeadTemperatureReview } from '../src/scheduler/leadTemperatureReview.js'

function fakeSupabase(state) {
  return {
    from(table) {
      const query = { filters: [], op: 'select', payload: null, limitN: null }
      const rows = () => state[table].filter(row => query.filters.every(filter => filter(row)))
      const api = {
        select() { return api },
        eq(column, value) { query.filters.push(row => row[column] === value); return api },
        gte(column, value) { query.filters.push(row => row[column] >= value); return api },
        lte(column, value) { query.filters.push(row => row[column] <= value); return api },
        not(column, operator) {
          if (operator === 'is') query.filters.push(row => row[column] !== null && row[column] !== undefined)
          return api
        },
        or() { return api },
        limit(value) { query.limitN = value; return api },
        order() { return api },
        update(payload) { query.op = 'update'; query.payload = payload; return api },
        maybeSingle() { return Promise.resolve({ data: rows()[0] ?? null, error: null }) },
        then(resolve, reject) {
          try {
            if (query.op === 'update') {
              rows().forEach(row => Object.assign(row, query.payload))
              return resolve({ data: null, error: null })
            }
            const selected = rows()
            return resolve({ data: query.limitN ? selected.slice(0, query.limitN) : selected, error: null })
          } catch (error) { reject(error) }
        },
      }
      return api
    },
  }
}

function makeState(now) {
  const contact = (id, days, leadQuality = null, leadState = 'engaged') => ({
    id, business_id: 'b1', lead_type: 'business', lead_state: leadState, lead_quality: leadQuality,
    last_seen: new Date(now - days * 86_400_000).toISOString(),
  })
  const contacts = [
    contact(1, 2, 'hot'),
    contact(2, 6, 'warm'),
    contact(3, 4, 'warm'),
    contact(4, 6, 'hot', 'won'),
  ]
  const conversations = contacts.map((item, index) => ({ id: `c${index + 1}`, contact_id: item.id, business_id: 'b1' }))
  const messages = contacts.map((item, index) => ({
    conversation_id: `c${index + 1}`,
    created_at: item.last_seen,
  }))
  return { contacts, conversations, messages }
}

test('refreshes warm/cold from the latest of the five recent messages', async () => {
  const now = Date.now()
  const state = makeState(now)
  const result = await runLeadTemperatureReview(fakeSupabase(state))

  assert.equal(result.updated, 2)
  assert.equal(state.contacts[0].lead_quality, 'warm')
  assert.equal(state.contacts[1].lead_quality, 'cold')
  assert.equal(state.contacts[2].lead_quality, 'warm')
  assert.equal(state.contacts[3].lead_quality, 'hot', 'closed leads are not changed')
})
