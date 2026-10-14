import test from 'node:test';
import assert from 'node:assert/strict';
import { RECOMMENDED, hoursToQuiet, followupPrefsFor, validateFollowupPrefs, toColumns, describeFollowups, describeChat, clock, daysText, prefsFromColumns } from './defaults.js';
import { planSwitches } from './switches.js';
import { groupApprovals } from './homeApprovals.js';
import { createReadyNotifier, READY_TEXT } from './readyNotifier.js';

test('hours become quiet hours: open 08:00, close 18:30 -> quiet from 7 pm until 8 am', () => {
    assert.deepEqual(hoursToQuiet({ open: '08:00', close: '18:30', days: [1, 2, 3] }), { quiet_start: 19, quiet_end: 8, active_days: [1, 2, 3] });
    assert.equal(hoursToQuiet({ open: '09:00', close: '17:00' }).quiet_start, 17);
    assert.deepEqual(hoursToQuiet(undefined), {});
});

test('recommended settings are valid, ask-first, and use the answers', () => {
    assert.equal(validateFollowupPrefs(RECOMMENDED.followups), null);
    const prefs = followupPrefsFor({ hours: { open: '07:00', close: '20:00', days: [1, 2, 3, 4, 5] } });
    assert.equal(prefs.quiet_start, 20);
    assert.equal(prefs.quiet_end, 7);
    assert.deepEqual(prefs.active_days, [1, 2, 3, 4, 5]);
    assert.equal(prefs.zone_recent_mode, 'approval');
    assert.ok(prefs.max_per_lead >= 13);
    assert.equal(followupPrefsFor({}, { daily_cap: 10 }).daily_cap, 10);
    assert.equal(validateFollowupPrefs({ daily_cap: -1 }), 'invalid_daily_cap');
    assert.equal(validateFollowupPrefs({ active_days: [] }), 'invalid_active_days');
    assert.equal(validateFollowupPrefs({ zone_old_mode: 'yolo' }), 'invalid_zone_old_mode');
    const cols = toColumns({ daily_cap: 5, quiet_start: 21 });
    assert.deepEqual(cols, { followup_daily_cap: 5, followup_quiet_start: 21 });
    assert.equal(prefsFromColumns({ followup_daily_cap: 7 }).daily_cap, 7);
    assert.equal(prefsFromColumns({}).min_gap_hours, 20);
});

test('plain words: clock, days and the description lines', () => {
    assert.equal(clock(0), '12 am'); assert.equal(clock(12), '12 pm'); assert.equal(clock(21), '9 pm'); assert.equal(clock(8), '8 am');
    assert.equal(daysText([1, 2, 3, 4, 5, 6]), 'Mon to Sat');
    assert.equal(daysText([1, 3]), 'Mon, Wed');
    const lines = describeFollowups(RECOMMENDED.followups);
    assert.equal(lines.find((l) => l.key === 'approval').value, 'Ask me first');
    assert.match(lines.find((l) => l.key === 'quiet').plain, /9 pm and 8 am/);
    assert.ok(lines.every((l) => l.label && l.plain && l.edit));
    assert.match(describeChat(30)[0].plain, /30/);
});

const business = { business_id: 'b', persona_pack_status: 'ready', subscription_active: true, chat_ai_settings: { keep: 1 } };

test('switches: follow-ups on writes recommended columns and turns the AI on', () => {
    const plan = planSwitches({ business, answers: { hours: { open: '08:00', close: '18:00', days: [1, 2, 3] } }, request: { followups: true } });
    assert.equal(plan.patch.followup_ai_enabled, true);
    assert.equal(plan.patch.followup_quiet_start, 18);
    assert.equal(plan.patch.followup_zone_recent_mode, 'approval');
    assert.deepEqual(plan.warnings, []);
});

test('switches: chat needs a ready brand voice, a valid cap, and keeps existing settings', () => {
    assert.deepEqual(planSwitches({ business: { ...business, persona_pack_status: 'running' }, request: { chat: true } }), { error: 'persona_not_ready', status: 409 });
    assert.equal(planSwitches({ business, request: { chat: true, overrides: { chat: { daily_cap: 0 } } } }).error, 'invalid_chat_daily_cap');
    const plan = planSwitches({ business, answers: { hours: { open: '08:00', close: '18:00', days: [1] }, handoff: ['asks_for_call'] }, request: { chat: true } });
    assert.equal(plan.patch.chat_ai_enabled, true);
    assert.equal(plan.patch.chat_ai_daily_cap, 30);
    assert.equal(plan.patch.chat_ai_settings.keep, 1);
    assert.deepEqual(plan.patch.chat_ai_settings.handoff_reasons, ['asks_for_call']);
});

test('switches: off, warnings, bad overrides and empty requests', () => {
    assert.deepEqual(planSwitches({ business, request: { followups: false, chat: false } }).patch, { followup_ai_enabled: false, chat_ai_enabled: false });
    assert.deepEqual(planSwitches({ business: { ...business, subscription_active: false }, request: { followups: true } }).warnings, ['subscription_inactive']);
    assert.equal(planSwitches({ business, request: { followups: true, overrides: { followups: { min_gap_hours: 0 } } } }).error, 'invalid_min_gap_hours');
    assert.equal(planSwitches({ business, request: {} }).error, 'nothing_to_change');
});

test('approvals: groups by plan, counts, samples, blocked, plans first', () => {
    const out = groupApprovals({
        messages: [
            { id: 1, campaign_id: 'c1', draft_message: 'Hi A', qc_passed: true, scheduled_at: '2026-10-14T09:00:00Z' },
            { id: 2, campaign_id: 'c1', draft_message: 'Hi B', qc_passed: false, scheduled_at: '2026-10-14T08:00:00Z' },
            { id: 3, campaign_id: 'c1', draft_message: 'Hi C', qc_passed: null },
            { id: 4, campaign_id: 'c1', draft_message: 'Hi D' }, { id: 5, campaign_id: 'c1', draft_message: 'Hi E' },
            { id: 6, campaign_id: null, draft_message: 'Loose one', scheduled_at: '2026-10-13T09:00:00Z' },
        ],
        campaigns: [{ id: 'c1', name: 'Ad leads, 7 days' }],
        playbooks: [{ id: 'p1', ad_id: 'ad9', auto_headline: 'Lashes sale' }],
    });
    assert.equal(out.total_messages, 6);
    assert.equal(out.total_playbooks, 1);
    assert.equal(out.groups[0].kind, 'playbook');
    assert.equal(out.groups[0].title, 'Lashes sale');
    const c1 = out.groups.find((g) => g.key === 'c1');
    assert.equal(c1.title, 'Ad leads, 7 days');
    assert.equal(c1.count, 5);
    assert.equal(c1.blocked, 1);
    assert.equal(c1.samples.length, 3);
    assert.equal(c1.first_at, '2026-10-14T08:00:00Z');
    assert.equal(out.groups.find((g) => g.key === 'other').title, 'Follow-up messages');
    assert.deepEqual(groupApprovals({}), { total_messages: 0, total_playbooks: 0, groups: [] });
});

function notifierWorld({ waiting = ['a'], business = {}, pending = 2, sendOk = true } = {}) {
    const sent = [], marked = [], logs = [];
    const deps = {
        appUrl: 'https://app.test',
        log: (level, event) => logs.push(event),
        listWaiting: async () => waiting.map((id) => ({ business_id: id })),
        getBusiness: async (id) => ({ business_id: id, business_type: 'retail', owner_phone: '254700000000', followup_ai_enabled: true, ...business }),
        countPending: async () => pending,
        send: async (to, text) => { sent.push({ to, text }); return sendOk ? { ok: true } : { ok: false, error: 'down' }; },
        markSent: async (id) => { marked.push(id); },
    };
    return { notifier: createReadyNotifier(deps), sent, marked, logs };
}

test('ready message: sent once there is something to approve, with the agreed words', async () => {
    const w = notifierWorld();
    assert.equal(await w.notifier.checkOnce(), 1);
    assert.equal(w.sent[0].to, '254700000000');
    assert.match(w.sent[0].text, /^Aha! Set up is done\. Now you can preview and approve your first follow-ups! Let's get these people buying!/);
    assert.match(w.sent[0].text, /https:\/\/app\.test/);
    assert.deepEqual(w.marked, ['a']);
    assert.equal(READY_TEXT('').includes('http'), false);
});

test('ready message: waits when follow-ups are off or nothing is ready, skips HeySasa itself, never marks a failed send', async () => {
    for (const opts of [{ business: { followup_ai_enabled: false } }, { pending: 0 }, { business: { business_type: 'heysasa' } }]) {
        const w = notifierWorld(opts);
        assert.equal(await w.notifier.checkOnce(), 0);
        assert.equal(w.sent.length, 0);
    }
    const failed = notifierWorld({ sendOk: false });
    assert.equal(await failed.notifier.checkOnce(), 0);
    assert.deepEqual(failed.marked, []);
    assert.ok(failed.logs.includes('setup.ready_message_failed'));
    const noPhone = notifierWorld({ business: { owner_phone: null, phone: null } });
    await noPhone.notifier.checkOnce(); await noPhone.notifier.checkOnce();
    assert.equal(noPhone.logs.filter((l) => l === 'setup.ready_no_phone').length, 1);
});

import { validateAnswers } from './answers.js';
test('answers: finished flag must be a boolean', () => {
    assert.equal(validateAnswers({ finished: true }).value.finished, true);
    assert.equal(validateAnswers({ finished: 'yes' }).error, 'invalid_finished');
});

test('number settings carry their current value for the screen', () => {
    const lines = describeFollowups(RECOMMENDED.followups).filter((l) => l.edit?.type === 'number');
    assert.deepEqual(lines.map((l) => [l.edit.field, l.edit.current]), [['min_gap_hours', 20], ['silence_hours', 12], ['daily_cap', 40], ['max_per_lead', 13]]);
    assert.equal(describeChat(25)[0].edit.current, 25);
});

import { hasBalance } from './switches.js';
test('wallet: warns when the balance is empty, never for HeySasa itself, quiet when unknown', () => {
    assert.equal(hasBalance({ business_type: 'retail' }, 0), false);
    assert.equal(hasBalance({ business_type: 'retail' }, 1.2), true);
    assert.equal(hasBalance({ business_type: 'retail' }, null), null);
    assert.equal(hasBalance({ business_type: 'heysasa' }, 0), true);
    const biz = { business_id: 'b', persona_pack_status: 'ready', subscription_active: null, chat_ai_settings: {} };
    assert.deepEqual(planSwitches({ business: biz, request: { followups: true }, balanceUsd: 0 }).warnings, ['balance_empty']);
    assert.deepEqual(planSwitches({ business: biz, request: { followups: true }, balanceUsd: 5 }).warnings, []);
    assert.deepEqual(planSwitches({ business: { ...biz, subscription_active: false }, request: { chat: true }, balanceUsd: 0 }).warnings, ['subscription_inactive', 'balance_empty']);
});
