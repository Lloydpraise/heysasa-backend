import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMessageGates, evaluateChatGates } from './gates.js';

const NOW = new Date('2026-10-04T10:00:00Z');
const biz = { chat_ai_enabled: true, subscription_active: true, chat_ai_daily_cap: 10, chat_ai_human_pause_minutes: 60 };
const msg = { isFromMe: false, isGroupOrBroadcast: false, type: 'text', text: 'hi, how much?', sentAt: new Date('2026-10-04T09:59:30Z') };
const convo = { ai_enabled: true, handover_flag: false, is_business_chat: true };

test('a normal customer message passes every gate', () => {
  assert.equal(evaluateMessageGates({ message: msg, business: biz, now: NOW }).allow, true);
  assert.equal(evaluateChatGates({ conversation: convo, contact: { lead_type: 'business' }, business: biz, now: NOW }).allow, true);
});

test('switch OFF (the default) blocks everything', () => {
  for (const business of [{ ...biz, chat_ai_enabled: false }, { ...biz, chat_ai_enabled: undefined }, null]) {
    assert.equal(evaluateMessageGates({ message: msg, business, now: NOW }).reason, 'switch_off');
  }
});

test('cap of 0 and inactive subscription block', () => {
  assert.equal(evaluateMessageGates({ message: msg, business: { ...biz, chat_ai_daily_cap: 0 }, now: NOW }).reason, 'cap_zero');
  assert.equal(evaluateMessageGates({ message: msg, business: { ...biz, subscription_active: false }, now: NOW }).reason, 'subscription_inactive');
});

test('own messages, groups, non-text, empty and stale messages never get a reply', () => {
  const run = (m) => evaluateMessageGates({ message: { ...msg, ...m }, business: biz, now: NOW }).reason;
  assert.equal(run({ isFromMe: true }), 'from_me');
  assert.equal(run({ isGroupOrBroadcast: true }), 'group_or_broadcast');
  assert.equal(run({ type: 'image' }), 'unsupported_type');
  assert.equal(run({ text: '   ' }), 'empty_message');
  assert.equal(run({ sentAt: new Date('2026-10-04T09:40:00Z') }), 'stale_message');
});

test('a paused chat or an open handoff blocks, a resolved handoff does not', () => {
  const run = (c) => evaluateChatGates({ conversation: { ...convo, ...c }, contact: {}, business: biz, now: NOW });
  assert.equal(run({ ai_enabled: false }).reason, 'chat_paused');
  assert.equal(run({ handover_flag: true }).reason, 'handed_off');
  assert.equal(run({ handover_flag: true, handover_resolved_at: '2026-10-04T09:00:00Z' }).allow, true);
});

test('personal chats, vendors, staff and junk are not answered; unknown leads are', () => {
  const run = (contact, c = {}) => evaluateChatGates({ conversation: { ...convo, ...c }, contact, business: biz, now: NOW });
  assert.equal(run({}, { is_business_chat: false }).reason, 'personal_chat');
  assert.equal(run({ lead_type: 'personal' }).reason, 'personal_chat');
  for (const t of ['vendor', 'staff', 'junk']) assert.equal(run({ lead_type: t }).reason, 'not_a_customer');
  assert.equal(run({ contact_role: 'vendor' }).reason, 'not_a_customer');
  assert.equal(run({ lead_type: 'unknown' }).allow, true);
  assert.equal(run({}, { is_business_chat: null }).allow, true);
});

test('the AI stays quiet while the owner is active, then resumes', () => {
  const run = (ownerAt, b = biz) => evaluateChatGates({ conversation: convo, contact: {}, lastOwnerMessageAt: ownerAt, business: b, now: NOW });
  assert.equal(run(new Date('2026-10-04T09:30:00Z')).reason, 'owner_active');
  assert.equal(run(new Date('2026-10-04T08:30:00Z')).allow, true);
  assert.equal(run(new Date('2026-10-04T09:59:00Z'), { ...biz, chat_ai_human_pause_minutes: 0 }).allow, true);
  assert.equal(run(null).allow, true);
});
