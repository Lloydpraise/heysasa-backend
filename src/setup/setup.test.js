import test from 'node:test';
import assert from 'node:assert/strict';
import { planBundles, historySettled } from './bundlePlan.js';
import { shapeSetupStatus, percentFor, isHomeReady } from './setupStatus.js';
import { createOrchestrator } from './setupOrchestrator.js';

test('planBundles: newest 100 first, then 500s, no duplicates', () => {
    const ids = Array.from({ length: 1250 }, (_, i) => i + 1);
    const b = planBundles([...ids, 5, 5]);
    assert.deepEqual(b.map((x) => x.length), [100, 500, 500, 150]);
    assert.equal(b[0][0], 1);
    assert.deepEqual(planBundles([]), []);
    assert.deepEqual(planBundles([3, 2, 1]).map((x) => x.length), [3]);
});

test('historySettled: needs a quiet stretch with a steady count', () => {
    const s = [{ at: 0, count: 5 }, { at: 5000, count: 40 }, { at: 10000, count: 40 }, { at: 20000, count: 40 }];
    assert.equal(historySettled({ samples: s, now: 19000, quietMs: 15000 }), false);
    assert.equal(historySettled({ samples: s, now: 25000, quietMs: 15000 }), true);
    assert.equal(historySettled({ samples: [{ at: 0, count: 0 }], now: 99999 }), false);
});

test('status: percent, home_ready and plain words', () => {
    assert.equal(percentFor({ status: 'running', bundles_total: 3 }, { progress_done: 50, progress_total: 100 }), 30);
    assert.equal(percentFor({ status: 'home_ready', bundles_done: 1, bundles_total: 2 }), 73);
    assert.equal(percentFor({ status: 'done' }), 100);
    assert.equal(isHomeReady({ status: 'failed', bundles_done: 1 }), true);
    assert.equal(isHomeReady({ status: 'failed', bundles_done: 0 }), false);
    const s = shapeSetupStatus({ setup: { status: 'failed', bundles_done: 0, error: 'boom' }, counts: { chats: 9 } });
    assert.equal(s.error, 'boom');
    assert.equal(s.counters.chats, 9);
    assert.match(shapeSetupStatus({ setup: { status: 'done', thin: true } }).message, /very few chats/);
});

// A fake world: a clock that only moves when the code sleeps, an in-memory store, a scripted analyser.
function world({ contacts = 1200, history = null, launchStatuses = [], runResults = [] } = {}) {
    let t = 1_700_000_000_000;
    const rows = new Map();
    const calls = { launch: [], persona: [], images: [] };
    const queue = [...runResults];
    let current = null;
    const deps = {
        now: () => t,
        sleep: async (ms) => { t += ms; },
        store: {
            get: async (id) => rows.get(id) || null,
            upsert: async (id, patch) => { rows.set(id, { ...(rows.get(id) || {}), business_id: id, ...patch }); },
        },
        countContacts: async () => (history ? history(t) : contacts),
        newestContactCreatedAt: async () => null,
        listContactIdsNewestFirst: async () => Array.from({ length: contacts }, (_, i) => i + 1),
        launch: async (path, body) => {
            calls.launch.push({ path, body });
            const status = launchStatuses.shift() ?? 202;
            if (status === 202) current = queue.shift() ?? { status: 'completed' };
            return { status, body: {} };
        },
        latestRun: async () => current,
        kickPersona: async (id, o) => { calls.persona.push(o); },
        kickProductImages: async () => { calls.images.push(1); },
    };
    return { deps, rows, calls };
}

test('orchestrator: bundle 1 makes Home ready, the rest follow, background jobs are kicked', async () => {
    const { deps, rows } = world({ contacts: 1200 });
    const o = createOrchestrator(deps, { pollMs: 1000, quietMs: 3000 });
    const r = await o.start('biz');
    assert.equal(r.started, true);
    await r.done;
    const row = rows.get('biz');
    assert.equal(row.status, 'done');
    assert.equal(row.bundles_done, 4);              // 1200 chats = 100 + 500 + 500 + 100
    assert.equal(row.bundles_total, 4);
    assert.ok(row.home_ready_at);
});

test('orchestrator: first bundle asks for product text discovery, later ones do not', async () => {
    const { deps, calls } = world({ contacts: 700 });
    const o = createOrchestrator(deps, { pollMs: 1000, quietMs: 3000 });
    await (await o.start('biz')).done;
    const bodies = calls.launch.map((c) => c.body);
    assert.equal(bodies.length, 3);                 // 100, 500, 100
    assert.equal(bodies[0].discoverProducts, true);
    assert.equal(bodies[0].productsTextOnly, true);
    assert.equal(bodies[0].contactIds.length, 100);
    assert.equal(bodies[1].discoverProducts, undefined);
    assert.equal(calls.images.length, 1);
    assert.deepEqual(calls.persona, [{ force: false }, { force: true }]);
});

test('orchestrator: waits while history is still arriving', async () => {
    const { deps, rows } = world({ contacts: 50, history: (t) => Math.min(50, Math.floor((t - 1_700_000_000_000) / 1000)) });
    const o = createOrchestrator(deps, { pollMs: 1000, quietMs: 3000 });
    await (await o.start('biz')).done;
    assert.equal(rows.get('biz').status, 'done');
    assert.equal(rows.get('biz').contacts_total, 50);
});

test('orchestrator: no chats at all is a thin account, not a failure', async () => {
    const { deps, rows, calls } = world({ contacts: 0 });
    const o = createOrchestrator(deps, { pollMs: 1000, quietMs: 3000, maxHistoryWaitMs: 5000 });
    await (await o.start('biz')).done;
    assert.equal(rows.get('biz').thin, true);
    assert.equal(rows.get('biz').status, 'done');
    assert.equal(calls.launch.length, 0);
});

test('orchestrator: waits and retries when another analysis is running (409)', async () => {
    const { deps, calls } = world({ contacts: 50, launchStatuses: [409, 409, 202] });
    const o = createOrchestrator(deps, { pollMs: 1000, quietMs: 3000, busyRetryMs: 1000 });
    await (await o.start('biz')).done;
    assert.equal(calls.launch.length, 3);
});

test('orchestrator: bundle 1 failing is a failure; a later bundle failing keeps Home ready', async () => {
    let w = world({ contacts: 700, runResults: [{ status: 'failed', fatal_error: 'openai down' }] });
    let o = createOrchestrator(w.deps, { pollMs: 1000, quietMs: 3000 });
    await (await o.start('biz')).done;
    assert.equal(w.rows.get('biz').status, 'failed');
    assert.equal(isHomeReady(w.rows.get('biz')), false);
    assert.equal(w.calls.persona.length, 0);

    w = world({ contacts: 700, runResults: [{ status: 'completed' }, { status: 'failed', fatal_error: 'later' }] });
    o = createOrchestrator(w.deps, { pollMs: 1000, quietMs: 3000 });
    await (await o.start('biz')).done;
    assert.equal(w.rows.get('biz').status, 'failed');
    assert.equal(isHomeReady(w.rows.get('biz')), true);
    assert.equal(w.rows.get('biz').bundles_done, 1);
});

test('orchestrator: resume skips finished bundles; double start and finished setups are refused', async () => {
    const w = world({ contacts: 700 });
    w.rows.set('biz', { business_id: 'biz', status: 'failed', bundles_done: 1, started_at: 'x' });
    const o = createOrchestrator(w.deps, { pollMs: 1000, quietMs: 3000 });
    const r = await o.start('biz');
    assert.equal((await o.start('biz')).reason, 'already_running');
    await r.done;
    assert.equal(w.calls.launch.length, 2);         // bundles 2 and 3 only
    assert.equal(w.calls.launch[0].body.discoverProducts, undefined);
    assert.equal((await o.start('biz')).reason, 'already_done');
});

import { validateAnswers } from './answers.js';
test('answers: good input passes, bad input is named', () => {
    const ok = validateAnswers({ hours: { open: '08:00', close: '18:30', days: [1, 2, 3] }, handoff: ['asks_for_call'], products: { approve: [1, 'a'], dismiss: [2] } });
    assert.equal(ok.error, undefined);
    assert.deepEqual(ok.value.hours.days, [1, 2, 3]);
    assert.equal(validateAnswers({ hours: { open: '8am', close: '18:00', days: [1] } }).error, 'invalid_hours');
    assert.equal(validateAnswers({ hours: { open: '08:00', close: '18:00', days: [7] } }).error, 'invalid_hours');
    assert.equal(validateAnswers({ handoff: ['bogus'] }).error, 'invalid_handoff');
    assert.equal(validateAnswers({ products: { approve: [1], dismiss: [1] } }).error, 'product_in_both_lists');
    assert.deepEqual(validateAnswers({}).value, {});
});
