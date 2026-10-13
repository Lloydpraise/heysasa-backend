// The setup runner: connect WhatsApp, press one button, this does the rest.
//
//   wait for history  ->  bundle 1 (newest 100: sort customers, find products from text, analyse)  ->  Home is ready
//   then, in the background: persona pack, product images, then the remaining bundles of 500.
//
// Everything outside the logic (database, the analyser, the clock) comes in through `deps`, so the whole flow
// can be tested without a database. The real deps live in setupDeps.js.
import { planBundles, historySettled, FIRST_BUNDLE, NEXT_BUNDLE } from './bundlePlan.js';

const iso = (ms) => new Date(ms).toISOString();

export function createOrchestrator(deps, options = {}) {
    const cfg = {
        quietMs: 15_000,              // contact count unchanged this long = history has landed
        pollMs: 5_000,
        maxHistoryWaitMs: 5 * 60_000, // never wait longer than this for history
        runPollMs: 4_000,
        runStartGraceMs: 60_000,      // the analyser row must appear within this
        runTimeoutMs: 45 * 60_000,
        busyRetryMs: 15_000,          // another analysis is running (409): wait and try again
        maxBusyRetries: 80,
        firstBundle: FIRST_BUNDLE,
        nextBundle: NEXT_BUNDLE,
        ...options,
    };
    const active = new Set();
    const log = deps.log || (() => {});

    async function waitForHistory(businessId) {
        const t0 = deps.now();
        const samples = [];
        // History that landed long before the button was pressed does not need a quiet period.
        const newest = await deps.newestContactCreatedAt?.(businessId).catch(() => null);
        const alreadyQuiet = newest ? t0 - new Date(newest).getTime() >= cfg.quietMs : false;
        for (;;) {
            const count = await deps.countContacts(businessId);
            const now = deps.now();
            samples.push({ at: now, count });
            if (count > 0 && alreadyQuiet) return { count };
            if (historySettled({ samples, now, quietMs: cfg.quietMs })) return { count };
            if (now - t0 >= cfg.maxHistoryWaitMs) return { count };
            await deps.sleep(cfg.pollMs);
        }
    }

    // Starts one analyser run and waits for it to finish. Returns { ok, error? }.
    async function runBundle(businessId, body) {
        const sinceIso = iso(deps.now() - 5_000);
        let launched = false;
        for (let attempt = 0; attempt <= cfg.maxBusyRetries && !launched; attempt++) {
            const res = await deps.launch('/debug/analysis/start', body);
            if (res.status === 409) { await deps.sleep(cfg.busyRetryMs); continue; }   // someone else's analysis is running
            if (res.status < 200 || res.status >= 300) return { ok: false, error: `analysis_start_${res.status}` };
            launched = true;
        }
        if (!launched) return { ok: false, error: 'analysis_busy_too_long' };

        const t0 = deps.now();
        for (;;) {
            await deps.sleep(cfg.runPollMs);
            const run = await deps.latestRun(businessId, sinceIso);
            if (run && run.status === 'completed') return { ok: true, run };
            if (run && run.status === 'failed') return { ok: false, error: String(run.fatal_error || 'analysis_failed').slice(0, 300) };
            const waited = deps.now() - t0;
            if (!run && waited > cfg.runStartGraceMs) return { ok: false, error: 'analysis_did_not_start' };
            if (waited > cfg.runTimeoutMs) return { ok: false, error: 'analysis_timed_out' };
        }
    }

    async function background(label, fn) {
        try { await fn(); } catch (error) { log('warn', `setup.${label}_failed`, { error: String(error?.message || error) }); }
    }

    async function run(businessId, existing) {
        const { store } = deps;
        const resumeFrom = existing && ['running', 'home_ready', 'finishing', 'failed'].includes(existing.status)
            ? Number(existing.bundles_done || 0) : 0;
        await store.upsert(businessId, {
            status: resumeFrom > 0 ? 'home_ready' : 'waiting_history', error: null, thin: false,
            started_at: existing?.started_at || iso(deps.now()),
        });

        if (resumeFrom === 0) {
            const { count } = await waitForHistory(businessId);
            if (count === 0) {   // a new number with no chats: nothing to analyse, Home switches to "get your first leads in"
                await store.upsert(businessId, {
                    status: 'done', thin: true, home_ready_at: iso(deps.now()), finished_at: iso(deps.now()),
                });
                return;
            }
        }

        const ids = await deps.listContactIdsNewestFirst(businessId);
        const bundles = planBundles(ids, { first: cfg.firstBundle, rest: cfg.nextBundle });
        await store.upsert(businessId, {
            status: resumeFrom > 0 ? 'home_ready' : 'running',
            bundles_total: bundles.length, contacts_total: ids.length,
        });

        for (let i = resumeFrom; i < bundles.length; i++) {
            const first = i === 0;
            const body = { businessId, contactIds: bundles[i], ...(first ? { discoverProducts: true, productsTextOnly: true } : {}) };
            const result = await runBundle(businessId, body);
            if (!result.ok) { await store.upsert(businessId, { status: 'failed', error: result.error }); return; }

            if (first) {
                await store.upsert(businessId, { bundles_done: 1, status: 'home_ready', home_ready_at: iso(deps.now()) });
                // Not waited for: the owner already has value. Persona = the brand voice, images = the rest of the products.
                void background('persona', () => deps.kickPersona(businessId, { force: false }));
                void background('product_images', () => deps.kickProductImages(businessId));
            } else {
                await store.upsert(businessId, { bundles_done: i + 1 });
            }
        }

        await store.upsert(businessId, { status: 'finishing' });
        if (bundles.length > 1) void background('persona_refresh', () => deps.kickPersona(businessId, { force: true }));
        await store.upsert(businessId, { status: 'done', finished_at: iso(deps.now()) });
    }

    // Returns { started, reason?, done? }. `done` resolves when the whole setup has finished (tests use it).
    async function start(businessId, { restart = false } = {}) {
        if (active.has(businessId)) return { started: false, reason: 'already_running' };
        const existing = await deps.store.get(businessId);
        if (existing?.status === 'done' && !restart) return { started: false, reason: 'already_done' };
        active.add(businessId);
        const done = run(businessId, restart ? null : existing)
            .catch(async (error) => {
                log('error', 'setup.crashed', { businessId, error: String(error?.message || error) });
                await deps.store.upsert(businessId, { status: 'failed', error: String(error?.message || error).slice(0, 300) }).catch(() => {});
            })
            .finally(() => active.delete(businessId));
        return { started: true, done };
    }

    return { start, isActive: (businessId) => active.has(businessId) };
}
