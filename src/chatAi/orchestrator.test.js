import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrchestrator } from './orchestrator.js';

const NOW = new Date('2026-10-04T10:00:00Z');
const message = { keyId: 'K1', isFromMe: false, isGroupOrBroadcast: false, type: 'text', text: 'hi', sentAt: new Date('2026-10-04T09:59:50Z') };
const input = { businessId: 'b1', conversationId: 'c1', contactId: 7, message };

function fakeStore(over = {}) {
  const calls = { lock: 0, release: 0, claim: 0, logs: [] };
  const store = {
    calls,
    loadBusiness: async () => ({ chat_ai_enabled: true, subscription_active: true, chat_ai_daily_cap: 5, chat_ai_human_pause_minutes: 60 }),
    loadChat: async () => ({ conversation: { ai_enabled: true, handover_flag: false, is_business_chat: true }, contact: { lead_type: 'business' }, lastOwnerMessageAt: null }),
    acquireLock: async () => { calls.lock++; return 'tok'; },
    releaseLock: async () => { calls.release++; },
    claimSlot: async () => { calls.claim++; return { allowed: true, used: 1, cap: 5 }; },
    logTurn: async (r) => { calls.logs.push(r); },
    ...over,
  };
  return store;
}
const make = (store, brain) => createOrchestrator({ store, brain, now: () => NOW });

test('with no brain installed nothing is locked, claimed or logged', async () => {
  const store = fakeStore();
  const r = await make(store, null)(input);
  assert.deepEqual([r.status, r.reason], ['skipped', 'no_brain']);
  assert.deepEqual([store.calls.lock, store.calls.claim, store.calls.logs.length], [0, 0, 0]);
});

test('switch off stops before any chat lookup', async () => {
  let looked = false;
  const store = fakeStore({ loadBusiness: async () => ({ chat_ai_enabled: false, chat_ai_daily_cap: 5 }), loadChat: async () => { looked = true; } });
  const r = await make(store, async () => ({}))(input);
  assert.equal(r.reason, 'switch_off');
  assert.equal(looked, false);
});

test('the brain runs once with the lock held and the lock is always released', async () => {
  const store = fakeStore();
  let ran = 0;
  const r = await make(store, async (ctx) => { ran++; assert.equal(ctx.slot.allowed, true); return { replied: true }; })(input);
  assert.deepEqual([r.status, r.replied, ran], ['handled', true, 1]);
  assert.equal(store.calls.release, 1);
});

test('the lock is released even if the brain throws, and the error is logged', async () => {
  const store = fakeStore();
  await assert.rejects(make(store, async () => { throw new Error('boom'); })(input), /boom/);
  assert.equal(store.calls.release, 1);
  assert.equal(store.calls.logs[0].status, 'error');
});

test('a busy chat is skipped without spending a daily slot', async () => {
  const store = fakeStore({ acquireLock: async () => null });
  const r = await make(store, async () => ({}))(input);
  assert.equal(r.reason, 'chat_busy');
  assert.equal(store.calls.claim, 0);
});

test('when the daily cap is used up the brain never runs, the lock is released and the skip is logged', async () => {
  const store = fakeStore({ claimSlot: async () => ({ allowed: false, used: 5, cap: 5 }) });
  let ran = false;
  const r = await make(store, async () => { ran = true; })(input);
  assert.deepEqual([r.reason, ran, store.calls.release], ['cap_reached', false, 1]);
  assert.equal(store.calls.logs[0].skip_reason, 'cap_reached');
});

test('an owner who replied recently keeps the AI out', async () => {
  const store = fakeStore({ loadChat: async () => ({ conversation: { ai_enabled: true }, contact: {}, lastOwnerMessageAt: '2026-10-04T09:50:00Z' }) });
  assert.equal((await make(store, async () => ({}))(input)).reason, 'owner_active');
});
