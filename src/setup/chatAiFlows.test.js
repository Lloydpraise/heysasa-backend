import test from 'node:test';
import assert from 'node:assert/strict';
import { planFlowSeed } from './chatAiFlows.js';
import { planSwitches } from './switches.js';

const ALL = ['first_reply', 'product_enquiry', 'price_question', 'objections', 'order_details', 'delivery', 'complaints'];

test('a business with no flows gets the ad-lead flow, using only skills it really has', () => {
  const rows = planFlowSeed([], ['first_reply', 'price_question']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Ad leads');
  assert.deepEqual(rows[0].trigger, { any_ad: true });
  assert.deepEqual(rows[0].skill_keys, ['first_reply', 'price_question']);
  assert.equal(rows[0].created_via, 'setup');
  assert.equal(rows[0].enabled, true);
});

test('running it twice adds nothing, and the owner\'s own flows do not block it', () => {
  assert.deepEqual(planFlowSeed([{ name: 'Ad leads', created_via: 'setup' }], ALL), []);
  assert.equal(planFlowSeed([{ name: 'Ad leads', created_via: 'assistant' }], ALL).length, 1);
  assert.equal(planFlowSeed([{ name: 'Wedding cakes', created_via: 'assistant' }], ALL).length, 1);
});

test('the instructions never invite made-up prices and always allow a hand-over', () => {
  const [row] = planFlowSeed([], ALL);
  assert.match(row.instructions, /Never invent prices/);
  assert.match(row.instructions, /hand over/);
});
