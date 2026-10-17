import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateMessages, shapeHomeSummary } from './homeSummary.js';

test('empty input gives zeros and nulls, never NaN', () => {
    const out = shapeHomeSummary();
    assert.equal(out.sent_24h, 0);
    assert.equal(out.live.balance_kes, null);
    assert.equal(out.live.messages_left, null);
    assert.equal(out.live.followups_on, false);
    assert.equal(out.opportunities.dormant_leads, 0);
});

test('old keys keep their names and bad values become zero', () => {
    const out = shapeHomeSummary({ sent_24h: 12, ready_to_buy: '3', waiting_messages: -4, waiting_plans: 'x' });
    assert.deepEqual([out.sent_24h, out.ready_to_buy, out.waiting_messages, out.waiting_plans], [12, 3, 0, 0]);
});

test('message estimate is 2 per KES and rounds down to a friendly number', () => {
    assert.equal(estimateMessages(0), 0);
    assert.equal(estimateMessages(-5), 0);
    assert.equal(estimateMessages(7), 14);
    assert.equal(estimateMessages(57), 110);
    assert.equal(estimateMessages(5123), 10200);
});

test('a zero balance is reported as zero, not as unknown', () => {
    const out = shapeHomeSummary({ balance_kes: 0 });
    assert.equal(out.live.balance_kes, 0);
    assert.equal(out.live.messages_left, 0);
});

test('flags only turn on when exactly true', () => {
    const out = shapeHomeSummary({ followups_on: 'yes', chat_on: true, persona_ready: 1 });
    assert.equal(out.live.followups_on, false);
    assert.equal(out.live.chat_on, true);
    assert.equal(out.live.persona_ready, false);
});
