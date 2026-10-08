import test from 'node:test';
import assert from 'node:assert/strict';
import { checkReply, extractPrices, NO_REPLY } from './guards.ts';
import { pickFlow, type Flow } from './flows.ts';
import { executeBatch, resolveTools, toModelTools, type ToolRow } from './tools.ts';
import { buildInstructions, buildInput } from './prompt.ts';
import { formatPrice } from './builtin.ts';

// ── guards ──
test('assistant-style phrases are rejected', () => {
  for (const bad of ['Hi! How can I assist you today?', "I'm here to help with anything.", 'Feel free to ask me anything', 'Is there anything else you need?', 'Let me know if you need anything else']) {
    assert.equal(checkReply(bad, '').ok, false, bad);
  }
  assert.equal(checkReply('Which size are you after, the 3kg or the 5kg?', '').ok, true);
});

test('a price that no tool gave is caught, a real one passes, in either format', () => {
  const corpus = '{"name":"Volume Set","price":"KES 3,500"}';
  assert.equal(checkReply('The volume set is KES 3,500.', corpus).ok, true);
  assert.equal(checkReply('Volume set is Ksh 3500 only', corpus).ok, true);
  assert.equal(checkReply('3,500/= only', corpus).ok, true);
  const bad = checkReply('Volume set is KES 2,900 today', corpus);
  assert.equal(bad.ok, false);
  assert.match(bad.problems.join(' '), /2,900/);
  assert.deepEqual(extractPrices('Ksh. 1,200 or 800 bob'), [1200, 800]);
});

test('empty, too long and list-style replies are rejected', () => {
  assert.equal(checkReply('  ', '').ok, false);
  assert.equal(checkReply('a'.repeat(701), '').ok, false);
  assert.equal(checkReply('Options:\n- one\n- two', '').ok, false);
});

// ── flows ──
const flow = (over: Partial<Flow>): Flow => ({ id: 'f1', name: 'F', enabled: true, priority: 100, trigger: { ad_ids: ['ad1'] }, goal: null, instructions: 'x', skill_keys: [], created_at: '2026-01-01', ...over });

test('flows are picked by ad or list, never by guess', () => {
  const flows = [flow({ id: 'a', trigger: { ad_ids: ['ad1'] } }), flow({ id: 'b', trigger: { list_ids: ['L1'] } })];
  assert.equal(pickFlow(flows, { adIds: ['ad1'], listIds: [] })?.id, 'a');
  assert.equal(pickFlow(flows, { adIds: [], listIds: ['L1'] })?.id, 'b');
  assert.equal(pickFlow(flows, { adIds: ['zzz'], listIds: ['L9'] }), null);
  assert.equal(pickFlow([flow({ trigger: {} })], { adIds: [null], listIds: [] }), null);
});

test('highest priority wins, a chat keeps its flow, disabled flows are ignored', () => {
  const flows = [flow({ id: 'low', priority: 10 }), flow({ id: 'high', priority: 50 })];
  assert.equal(pickFlow(flows, { adIds: ['ad1'], listIds: [] })?.id, 'high');
  assert.equal(pickFlow(flows, { adIds: ['ad1'], listIds: [], stickyFlowId: 'low' })?.id, 'low');
  assert.equal(pickFlow([flow({ id: 'off', enabled: false })], { adIds: ['ad1'], listIds: [], stickyFlowId: 'off' }), null);
});

// ── tools ──
const row = (name: string, phase: ToolRow['phase'], business_id: string | null = null): ToolRow =>
  ({ name, business_id, description: name, parameters: { type: 'object', properties: {} }, kind: 'builtin', target: name, phase });

test('the tool list is sorted and a business tool replaces a global one', () => {
  const rows = [row('zeta', 'lookup'), row('alpha', 'lookup'), row('alpha', 'lookup', 'b1'), row('other', 'lookup', 'b2')];
  const resolved = resolveTools(rows, 'b1');
  assert.deepEqual(resolved.map((r) => `${r.name}:${r.business_id}`), ['alpha:b1', 'zeta:null']);
  assert.equal(JSON.stringify(toModelTools(resolveTools(rows, 'b1'))), JSON.stringify(toModelTools(resolveTools([...rows].reverse(), 'b1'))));
});

test('lookups run together and all results come back', async () => {
  const tools = [row('a', 'lookup'), row('b', 'write')];
  let running = 0, peak = 0;
  const results = await executeBatch(
    [{ call_id: '1', name: 'a', arguments: '{}' }, { call_id: '2', name: 'b', arguments: '{}' }], tools,
    async () => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 20)); running--; return { ok: 1 }; },
  );
  assert.equal(peak, 2);
  assert.deepEqual(results.map((r) => [r.call_id, r.ok]), [['1', true], ['2', true]]);
});

test('a send tool in the same step as a lookup is bounced, and runs when called alone', async () => {
  const tools = [row('search', 'lookup'), row('send', 'send')];
  const ran: string[] = [];
  const run = async (r: ToolRow) => { ran.push(r.name); return { ok: true }; };
  const mixed = await executeBatch([{ call_id: '1', name: 'search', arguments: '{}' }, { call_id: '2', name: 'send', arguments: '{}' }], tools, run);
  assert.deepEqual(ran, ['search']);
  assert.equal(mixed[1].not_run, true);
  const alone = await executeBatch([{ call_id: '3', name: 'send', arguments: '{}' }], tools, run);
  assert.deepEqual([ran.length, alone[0].ok], [2, true]);
});

test('several sends run one after another, never together', async () => {
  const tools = [row('send', 'send')];
  let running = 0, peak = 0;
  await executeBatch([{ call_id: '1', name: 'send', arguments: '{}' }, { call_id: '2', name: 'send', arguments: '{}' }], tools,
    async () => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 10)); running--; return {}; });
  assert.equal(peak, 1);
});

test('unknown tools, bad JSON and a failing tool return errors instead of crashing the turn', async () => {
  const tools = [row('ok', 'lookup')];
  const results = await executeBatch(
    [{ call_id: '1', name: 'nope', arguments: '{}' }, { call_id: '2', name: 'ok', arguments: '{bad' }, { call_id: '3', name: 'ok', arguments: '{}' }], tools,
    async () => { throw new Error('boom'); },
  );
  assert.deepEqual(results.map((r) => r.ok), [false, false, false]);
  assert.match(results[2].output, /boom/);
});

// ── prompt (caching order) ──
test('instructions are identical for identical business data, whatever order the skills arrive in', () => {
  const skills = [{ key: 'b', title: 'B', when_to_use: 'when b' }, { key: 'a', title: 'A', when_to_use: 'when a' }];
  const mk = (s: typeof skills) => buildInstructions({ businessName: 'Biz', currency: 'KES', persona: { persona: 'warm' }, categories: [{ name: 'Lashes', count: 3 }], skillMenu: s });
  assert.equal(mk(skills), mk([...skills].reverse()));
  assert.match(mk(skills), new RegExp(NO_REPLY));
});

test('the clock and the new message come last so the history stays cacheable', () => {
  const base = { flow: null, loadedSkills: [], customer: { name: 'Amina' }, history: [{ role: 'user' as const, text: 'hi' }] };
  const a = buildInput({ ...base, nowLabel: 'Monday 09:00' });
  const b = buildInput({ ...base, nowLabel: 'Monday 09:05' });
  assert.deepEqual(a.slice(0, -1), b.slice(0, -1));
  assert.notEqual(a.at(-1)!.content, b.at(-1)!.content);
});

test('the customer file comes after the history, so a profile change does not make the whole history a cache miss', () => {
  const history = [{ role: 'user' as const, text: 'hi' }, { role: 'assistant' as const, text: 'hello' }, { role: 'user' as const, text: 'price?' }];
  const mk = (customer: Record<string, unknown>) => buildInput({ flow: null, loadedSkills: [], customer, history, nowLabel: 'Monday 09:00' });
  const a = mk({ name: 'Amina' });
  const b = mk({ name: 'Amina', stage: 'hot', lead_summary: 'wants volume set' });
  const fileAt = a.findIndex((i) => i.content.startsWith('CUSTOMER FILE'));
  assert.equal(fileAt, a.length - 2, 'just before the clock');
  assert.deepEqual(a.slice(1, 4).map((i) => i.content), ['hi', 'hello', 'price?']);
  assert.deepEqual(a.slice(0, fileAt), b.slice(0, fileAt), 'everything before the file is identical, so it stays cached');
  assert.notEqual(a[fileAt].content, b[fileAt].content);
});

test('prices are shown with currency and thousands separators', () => {
  assert.equal(formatPrice(3500, 'KES'), 'KES 3,500');
  assert.equal(formatPrice(99.5, null), 'KES 99.50');
  assert.equal(formatPrice(null, 'KES'), '');
});
