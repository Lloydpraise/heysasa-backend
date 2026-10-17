import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanAudience, audienceOf, audienceAllows, isHotLead, describeAudience, DEFAULT_AUDIENCE } from './audience.js';
import { evaluateChatGates } from './gates.js';

const NOW = new Date('2026-10-16T10:00:00Z');
const convo = { ai_enabled: true, handover_flag: false, is_business_chat: true };
const biz = (audience) => ({ chat_ai_enabled: true, subscription_active: true, chat_ai_daily_cap: 10, chat_ai_human_pause_minutes: 60, chat_ai_settings: audience === undefined ? {} : { audience } });
const adLead = { lead_type: 'business', is_ad_lead: true, intent_score: 10, lead_state: 'new' };
const hotLead = { lead_type: 'business', is_ad_lead: false, intent_score: 80, lead_state: 'engaged' };
const plainLead = { lead_type: 'business', is_ad_lead: false, intent_score: 20, lead_state: 'new' };

test('nothing saved means everyone, so older businesses keep working', () => {
  assert.deepEqual(audienceOf({}), ['all']);
  assert.deepEqual(audienceOf(null), ['all']);
  assert.equal(audienceAllows(undefined, plainLead), true);
});

test('bad values are dropped; nothing valid is null', () => {
  assert.deepEqual(cleanAudience(['ADS', 'hot', 'ads', 'vip']), ['ads', 'hot']);
  assert.equal(cleanAudience(['vip']), null);
  assert.equal(cleanAudience('ads'), null);
  assert.equal(cleanAudience([]), null);
});

test('ads only: ad leads pass, hot and plain leads do not', () => {
  assert.equal(audienceAllows(['ads'], adLead), true);
  assert.equal(audienceAllows(['ads'], hotLead), false);
  assert.equal(audienceAllows(['ads'], plainLead), false);
});

test('hot only: intent 70+ that is not won or lost', () => {
  assert.equal(isHotLead({ intent_score: 70, lead_state: 'engaged' }), true);
  assert.equal(isHotLead({ intent_score: 69, lead_state: 'engaged' }), false);
  assert.equal(isHotLead({ intent_score: 90, lead_state: 'won' }), false);
  assert.equal(isHotLead({ intent_score: 90, lead_state: 'lost' }), false);
  assert.equal(isHotLead({ intent_score: null }), false);
  assert.equal(audienceAllows(['hot'], hotLead), true);
  assert.equal(audienceAllows(['hot'], adLead), false);
});

test('ads and hot together is a union; all lets everyone in', () => {
  assert.equal(audienceAllows(['ads', 'hot'], adLead), true);
  assert.equal(audienceAllows(['ads', 'hot'], hotLead), true);
  assert.equal(audienceAllows(['ads', 'hot'], plainLead), false);
  assert.equal(audienceAllows(['all'], plainLead), true);
});

test('a chat the AI already answers keeps being answered when the lead stops matching', () => {
  assert.equal(audienceAllows(['hot'], plainLead, { aiHasReplied: true }), true);
  assert.equal(audienceAllows(['hot'], plainLead, { aiHasReplied: false }), false);
});

test('the gate uses the audience saved on the business', () => {
  const run = (audience, contact, extra = {}) => evaluateChatGates({ conversation: convo, contact, business: biz(audience), now: NOW, ...extra });
  assert.equal(run(['ads'], adLead).allow, true);
  assert.deepEqual(run(['ads'], plainLead), { allow: false, reason: 'outside_audience' });
  assert.equal(run(['ads'], plainLead, { aiHasReplied: true }).allow, true);
  assert.equal(run(undefined, plainLead).allow, true);
  assert.equal(run(['all'], plainLead).allow, true);
});

test('words for the owner, and what is offered on a first switch-on', () => {
  assert.equal(describeAudience(['ads', 'hot']), 'people who came from your ads and people who are ready to buy');
  assert.equal(describeAudience(['all']), 'every customer who writes to you');
  assert.deepEqual(DEFAULT_AUDIENCE, ['ads', 'hot']);
});
