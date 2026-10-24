import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrchestrator } from './orchestrator.js';
import { createStore } from './store.js';
import { createTyping } from './typing.js';
import { canAffordChatAi } from './billing.js';
import { evaluateMessageGates } from './gates.js';

// One account = one WhatsApp number (ACCOUNTS.md). The chat AI must run with that number's settings, wallet and
// connection, and read only that number's rows.

const NOW = new Date('2026-10-24T10:00:00Z');
const JID = '254712345678@s.whatsapp.net';
const message = { keyId: 'K1', jid: JID, isFromMe: false, isGroupOrBroadcast: false, type: 'text', text: 'hi', sentAt: new Date(NOW.getTime() - 5000) };
const on = { business_id: 'b1', chat_ai_enabled: true, subscription_active: true, chat_ai_daily_cap: 5, chat_ai_settings: {} };
const chat = { conversation: { ai_enabled: true, handover_flag: false, is_business_chat: true }, contact: { lead_type: 'business' }, lastOwnerMessageAt: null };

function recordingStore(over = {}) {
  const seen = {};
  const store = {
    seen,
    accountIdFor: async (c) => { seen.accountIdFor = c; return 'acc-from-convo'; },
    loadBusiness: async (b, a) => { seen.loadBusiness = [b, a]; return on; },
    loadChat: async (c, k, a) => { seen.loadChat = [c, k, a]; return chat; },
    canAfford: async (b, a) => { seen.canAfford = [b, a]; return true; },
    acquireLock: async () => 'tok', releaseLock: async () => {},
    claimSlot: async () => ({ allowed: true, used: 1, cap: 5 }),
    unansweredInboundSince: async (c, since, a) => { seen.unanswered = a; return null; },
    logTurn: async (row) => { (seen.logs ??= []).push(row); },
    ...over,
  };
  return store;
}

test('the account given by the webhook is used for settings, the chat, the wallet, typing and the brain', async () => {
  const store = recordingStore();
  const typed = [];
  const typing = { start: async (...a) => typed.push(a), stop: async () => {} };
  let brainCtx;
  await createOrchestrator({ store, typing, brain: async (ctx) => { brainCtx = ctx; return { replied: true }; }, now: () => NOW })(
    { businessId: 'b1', accountId: 'acc1', conversationId: 'c1', contactId: 7, message });
  assert.equal(store.seen.accountIdFor, undefined, 'no lookup when the account was passed');
  assert.deepEqual(store.seen.loadBusiness, ['b1', 'acc1']);
  assert.deepEqual(store.seen.loadChat, ['c1', 7, 'acc1']);
  assert.deepEqual(store.seen.canAfford, ['b1', 'acc1']);
  assert.equal(store.seen.unanswered, 'acc1');
  assert.equal(brainCtx.accountId, 'acc1');
  assert.deepEqual(typed[0], ['b1', JID, 'acc1']);
});

test('a caller without the account gets it from the conversation, and logged turns carry it', async () => {
  const store = recordingStore({ claimSlot: async () => ({ allowed: false, used: 5, cap: 5 }) });
  const r = await createOrchestrator({ store, brain: async () => ({}), now: () => NOW })({ businessId: 'b1', conversationId: 'c9', contactId: 7, message });
  assert.equal(r.reason, 'cap_reached');
  assert.equal(store.seen.accountIdFor, 'c9');
  assert.deepEqual(store.seen.loadBusiness, ['b1', 'acc-from-convo']);
  assert.equal(store.seen.logs[0].account_id, 'acc-from-convo');
});

test('a suspended account is refused like the switch being off, before any chat lookup', async () => {
  assert.equal(evaluateMessageGates({ message, business: { ...on, account_can_operate: false }, now: NOW }).reason, 'account_suspended');
  assert.equal(evaluateMessageGates({ message, business: { ...on, account_can_operate: true }, now: NOW }).allow, true);
  const store = recordingStore({ loadBusiness: async () => ({ ...on, account_can_operate: false }) });
  const r = await createOrchestrator({ store, brain: async () => ({}), now: () => NOW })({ businessId: 'b1', accountId: 'acc1', conversationId: 'c1', contactId: 7, message });
  assert.equal(r.reason, 'account_suspended');
  assert.equal(store.seen.loadChat, undefined);
});

// A tiny query recorder: every builder call is kept so the test can see the filters.
function recorderDb(answers, rpcAnswers = {}) {
  const queries = [];
  const rpcs = [];
  const from = (table) => {
    const q = { table, calls: [] };
    queries.push(q);
    const api = new Proxy({}, {
      get: (_t, prop) => {
        if (prop === 'then') return (resolve) => resolve({ data: typeof answers[table] === 'function' ? answers[table](q) : answers[table] ?? null, error: null });
        return (...args) => { q.calls.push([prop, ...args]); return api; };
      },
    });
    return api;
  };
  return {
    queries, rpcs, from,
    rpc: async (fn, args) => { rpcs.push([fn, args]); return { data: rpcAnswers[fn] ?? null, error: null }; },
  };
}
const filtersOf = (q) => q.calls.filter((c) => c[0] === 'eq').map((c) => `${c[1]}=${c[2]}`);

test('the store reads settings through account_settings and refuses an account of another business', async () => {
  const db = recorderDb({}, { account_settings: { business_id: 'b1', chat_ai_enabled: true, chat_ai_daily_cap: 3 }, account_can_operate: false });
  const row = await createStore(db).loadBusiness('b1', 'acc1');
  assert.deepEqual(db.rpcs.map((r) => r[0]).sort(), ['account_can_operate', 'account_settings']);
  assert.equal(db.rpcs[0][1].p_account_id, 'acc1');
  assert.deepEqual([row.chat_ai_daily_cap, row.account_can_operate], [3, false]);
  assert.equal(db.queries.length, 0, 'no business-level read when the account is known');

  const other = recorderDb({}, { account_settings: { business_id: 'b2', chat_ai_enabled: true }, account_can_operate: true });
  assert.equal(await createStore(other).loadBusiness('b1', 'acc-of-b2'), null);

  const legacy = recorderDb({ businesses: on });
  assert.equal((await createStore(legacy).loadBusiness('b1')).chat_ai_enabled, true);
  assert.equal(legacy.rpcs.length, 0, 'a business without accounts keeps the old read');
});

test('every chat read is limited to the account', async () => {
  const db = recorderDb({});
  await createStore(db).loadChat('c1', 7, 'acc1');
  assert.deepEqual(db.queries.map((q) => q.table).sort(), ['chat_ai_turns', 'contacts', 'conversations', 'messages']);
  for (const q of db.queries) assert.ok(filtersOf(q).includes('account_id=acc1'), `${q.table} is filtered by account`);
  const legacy = recorderDb({});
  await createStore(legacy).loadChat('c1', 7, null);
  for (const q of legacy.queries) assert.ok(!filtersOf(q).some((f) => f.startsWith('account_id')));
});

test('the wallet: separate billing checks the account balance, otherwise the business balance', async () => {
  const db = recorderDb({
    businesses: { business_type: 'customer' },
    accounts: { billing_mode: 'separate' },
    account_balances: { balance_usd: 0 },
    business_balances: { balance_usd: 10 },
  });
  assert.equal(await canAffordChatAi(db, 'b1', 'acc1'), false, 'an empty account wallet pauses that number even when the business has credit');
  assert.ok(db.queries.some((q) => q.table === 'account_balances' && filtersOf(q).includes('account_id=acc1')));
  assert.ok(!db.queries.some((q) => q.table === 'business_balances'));

  const shared = recorderDb({ businesses: { business_type: 'customer' }, accounts: { billing_mode: 'business' }, business_balances: { balance_usd: 10 } });
  assert.equal(await canAffordChatAi(shared, 'b1', 'acc1'), true);
  assert.ok(!shared.queries.some((q) => q.table === 'account_balances'));
});

test('typing goes through the account\'s own connection, and not at all when that number is disconnected', async () => {
  const calls = [];
  const fetchFn = async (url) => { calls.push(url); return { ok: true, status: 201 }; };
  const db = recorderDb({ accounts: (q) => (filtersOf(q).includes('id=acc1') ? { instance_name: 'inst_acc1', status: 'connected' } : { instance_name: 'inst_acc2', status: 'disconnected' }) });
  const typing = createTyping({ supabase: db, evolutionUrl: 'http://evo', apiKey: 'K', fetchFn });
  assert.equal(await typing.start('b1', JID, 'acc1'), true);
  assert.equal(calls[0], 'http://evo/chat/sendPresence/inst_acc1');
  assert.equal(await typing.start('b1', JID, 'acc2'), false);
  assert.equal(calls.length, 1);
  assert.ok(!db.queries.some((q) => q.table === 'whatsapp_sessions'), 'no business-level instance lookup when the account is known');
});
