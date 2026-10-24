// The setup runner: connect WhatsApp, press one button, this does the rest.
//
//   wait for history  ->  bundle 1 (newest 100: sort customers, find products from text, analyse)  ->  Home is ready
//   then, in the background: persona pack, product images, then the remaining bundles of 500.
//
// Everything outside the logic (database, the analyser, the clock) comes in through `deps`, so the whole flow
// can be tested without a database. The real deps live in setupDeps.js.
//
// Setup runs per WhatsApp account (ACCOUNTS.md): business_setup has one row per account, and the analyser,
// persona pack and product discovery read that account's chats. accountId is passed to every dep as a trailing
// argument (null for a business that has no account yet, which behaves exactly as before).
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

    async function waitForHistory(businessId, accountId) {
        const t0 = deps.now();
        const samples = [];
        // History that landed long before the button was pressed does not need a quiet period.
        const newest = await deps.newestContactCreatedAt?.(businessId, accountId).catch(() => null);
        const alreadyQuiet = newest ? t0 - new Date(newest).getTime() >= cfg.quietMs : false;
        for (;;) {
            const count = await deps.countContacts(businessId, accountId);
            const now = deps.now();
            samples.push({ at: now, count });
            if (count > 0 && alreadyQuiet) return { count };
            if (historySettled({ samples, now, quietMs: cfg.quietMs })) return { count };
            if (now - t0 >= cfg.maxHistoryWaitMs) return { count };
            await deps.sleep(cfg.pollMs);
        }
    }

    // Starts one analyser run and waits for it to finish. Returns { ok, error? }.
    async function runBundle(businessId, body, accountId) {
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
            const run = await deps.latestRun(businessId, sinceIso, accountId);
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

    async function run(businessId, existing, accountId) {
        const { store } = deps;
        const put = (patch) => store.upsert(businessId, patch, accountId);
        const resumeFrom = existing && ['running', 'home_ready', 'finishing', 'failed'].includes(existing.status)
            ? Number(existing.bundles_done || 0) : 0;
        // Where the time goes, so we know which stage to speed up. Kept in business_setup.timings and shown by GET /setup/status.
        const began = deps.now();
        const timings = resumeFrom > 0 ? { ...(existing?.timings || {}) } : { bundles: [] };
        timings.bundles = timings.bundles || [];
        await put({
            status: resumeFrom > 0 ? 'home_ready' : 'waiting_history', error: null, thin: false,
            started_at: existing?.started_at || iso(deps.now()),
        });

        if (resumeFrom === 0) {
            // Optional one-time starter balance (off unless SETUP_STARTER_CREDIT_USD is set). It never stops setup.
            await background('starter_credit', async () => { const r = await deps.grantStarterCredit?.(businessId, accountId); if (r?.grant) log('info', 'setup.starter_credit_granted', { businessId, amountUsd: r.amountUsd }); });
            const waitedFrom = deps.now();
            const { count } = await waitForHistory(businessId, accountId);
            timings.history_wait_ms = deps.now() - waitedFrom;
            if (count === 0) {   // a new number with no chats: nothing to analyse, Home switches to "get your first leads in"
                await put({
                    status: 'done', thin: true, home_ready_at: iso(deps.now()), finished_at: iso(deps.now()), timings,
                });
                return;
            }
        }

        const ids = await deps.listContactIdsNewestFirst(businessId, accountId);
        const bundles = planBundles(ids, { first: cfg.firstBundle, rest: cfg.nextBundle });
        await put({
            status: resumeFrom > 0 ? 'home_ready' : 'running',
            bundles_total: bundles.length, contacts_total: ids.length,
        });

        for (let i = resumeFrom; i < bundles.length; i++) {
            const first = i === 0;
            const body = { businessId, ...(accountId ? { accountId } : {}), contactIds: bundles[i], ...(first ? { discoverProducts: true, productsTextOnly: true } : {}) };
            const bundleStart = deps.now();
            const result = await runBundle(businessId, body, accountId);
            timings.bundles[i] = { size: bundles[i].length, ms: deps.now() - bundleStart, ok: result.ok, discovery_text_only: first || undefined };
            if (!result.ok) { await put({ status: 'failed', error: result.error, timings }); return; }

            if (first) {
                timings.home_ready_ms = deps.now() - began;
                await put({ bundles_done: 1, status: 'home_ready', home_ready_at: iso(deps.now()), timings });
                // Not waited for: the owner already has value. Persona = the brand voice, images = the rest of the products.
                void background('persona', () => deps.kickPersona(businessId, { force: false, ...(accountId ? { accountId } : {}) }));
                void background('product_images', () => deps.kickProductImages(businessId, accountId));
                // The chat AI's starting skills, copied from the shared library. Free, and never overwrites the owner's own.
                void background('chat_skills', async () => {
                    const r = await deps.seedChatAiSkills?.(businessId, accountId);
                    if (r?.added) log('info', 'setup.chat_skills_added', { businessId, added: r.added });
                });
            } else {
                await put({ bundles_done: i + 1, timings });
            }
        }

        await put({ status: 'finishing' });
        if (bundles.length > 1) void background('persona_refresh', () => deps.kickPersona(businessId, { force: true, ...(accountId ? { accountId } : {}) }));
        timings.total_ms = deps.now() - began;
        await put({ status: 'done', finished_at: iso(deps.now()), timings });
    }

    // Returns { started, reason?, done? }. `done` resolves when the whole setup has finished (tests use it).
    const keyOf = (businessId, accountId) => (accountId ? `${businessId}|${accountId}` : businessId);
    async function start(businessId, { restart = false, accountId = null } = {}) {
        const key = keyOf(businessId, accountId);
        if (active.has(key)) return { started: false, reason: 'already_running' };
        const existing = await deps.store.get(businessId, accountId);
        if (existing?.status === 'done' && !restart) return { started: false, reason: 'already_done' };
        active.add(key);
        const done = run(businessId, restart ? null : existing, accountId)
            .catch(async (error) => {
                log('error', 'setup.crashed', { businessId, accountId, error: String(error?.message || error) });
                await deps.store.upsert(businessId, { status: 'failed', error: String(error?.message || error).slice(0, 300) }, accountId).catch(() => {});
            })
            .finally(() => active.delete(key));
        return { started: true, done };
    }

    return { start, isActive: (businessId, accountId = null) => active.has(keyOf(businessId, accountId)) };
}
