import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandoffNotifier, handoffMessage } from './notifier.js';
import { fakeSupabase } from '../test-helpers/fakeSupabase.js';

const event = (over = {}) => ({
    id: 'e1', business_id: 'b1', notify_status: 'pending', notify_attempts: 0, urgency: 'normal', contact_name: 'Amina', contact_phone: '254799888777',
    reason: 'wants a refund', summary: 'Amina wants her money back.', rule_label: 'Refund', created_at: '1',
    recipients: [{ name: 'Owner', phone: '254711000111' }, { name: 'Wanjiru', phone: '254722333444' }], ...over,
});

test('the alert names the customer, the case and the reason, and links straight to the chat', () => {
    const text = handoffMessage(event(), 'https://app.heysasa.co.ke');
    assert.match(text, /Handoff — Amina needs you/);
    assert.match(text, /Case: Refund/);
    assert.match(text, /https:\/\/wa\.me\/254799888777/);
    assert.match(text, /app\.heysasa\.co\.ke/);
    assert.match(handoffMessage(event({ urgency: 'high' })), /Urgent/);
});

test('every person is messaged and the event is marked sent', async () => {
    const db = fakeSupabase({ handoff_events: [event()] });
    const sent = [];
    const n = createHandoffNotifier({ supabase: db, send: async (to) => { sent.push(to); return { ok: true }; } });
    assert.equal(await n.checkOnce(), 1);
    assert.deepEqual(sent, ['254711000111', '254722333444']);
    assert.equal(db.tables.handoff_events[0].notify_status, 'sent');
    assert.equal(await n.checkOnce(), 0, 'a sent alert is never sent twice');
});

test('a failed send is retried, and only the last attempt gives up', async () => {
    const db = fakeSupabase({ handoff_events: [event()] });
    const n = createHandoffNotifier({ supabase: db, send: async (to) => (to === '254722333444' ? { ok: false, error: 'offline' } : { ok: true }) });
    await n.checkOnce();
    assert.equal(db.tables.handoff_events[0].notify_status, 'pending');
    await n.checkOnce();
    await n.checkOnce();
    assert.equal(db.tables.handoff_events[0].notify_status, 'partial');
    assert.match(db.tables.handoff_events[0].notify_error, /Wanjiru: offline/);
});

test('no recipient number means skipped, not stuck, and a thrown send does not crash the loop', async () => {
    const db = fakeSupabase({ handoff_events: [event({ id: 'a', recipients: [] }), event({ id: 'b' })] });
    const n = createHandoffNotifier({ supabase: db, send: async () => { throw new Error('boom'); } });
    await n.checkOnce();
    assert.equal(db.tables.handoff_events.find((e) => e.id === 'a').notify_status, 'skipped');
    assert.equal(db.tables.handoff_events.find((e) => e.id === 'b').notify_attempts, 1);
});
