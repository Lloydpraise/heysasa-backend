// Supabase request guard: traces, rate-limits and circuit-breaks every REST call.
//
// This exact file lives in TWO places (separate processes, separate in-memory state):
//   - src/services/dbGuard.js            (analyser run-local.js and other root-process children)
//   - followup-engine/src/lib/dbGuard.js (follow-up engine)
// Keep them byte-identical.
//
// WHY: a failing query repeated 5x/second (conversations.lead_state) went unseen because the
// analyser and the engine used plain Supabase clients. This gives every client:
//   1. a per-minute usage summary by table/rpc ("db.stats") so a runaway shows up immediately;
//   2. de-duplicated error logging (one line per distinct error per minute, with a repeat count);
//   3. a global request-rate cap (SUPABASE_MAX_RPS, default 40) that DELAYS calls, never drops them;
//   4. a per-endpoint circuit breaker: 100 consecutive failures with no success in between opens
//      the breaker for 60s, answering that endpoint with a synthetic 503 instead of hammering Supabase.

const DEFAULT_MAX_RPS = 40;
const BREAKER_FAILURES = 100;
const BREAKER_WINDOW_MS = 30_000;
const BREAKER_OPEN_MS = 60_000;
const STATS_EVERY_MS = 60_000;
const ERROR_LOG_EVERY_MS = 60_000;
const HIGH_VOLUME_RPS = 15;

export function describeRequest(input, init = {}) {
    const method = String(init.method || input?.method || 'GET').toUpperCase();
    const url = typeof input === 'string' ? input : (input?.url || String(input));
    let path = '';
    try { path = new URL(url).pathname; } catch { path = String(url).split('?')[0]; }
    const rest = path.match(/\/rest\/v1\/(rpc\/)?([^/?]+)/);
    const target = rest ? (rest[1] ? `rpc:${rest[2]}` : rest[2]) : (path.split('/').slice(0, 4).join('/') || 'unknown');
    return { method, url, target, key: `${method} ${target}` };
}

export function createDbGuard({ label = 'db', onLog = () => {}, env = process.env, fetchImpl = null, now = () => Date.now() } = {}) {
    const maxRps = Number(env.SUPABASE_MAX_RPS) > 0 ? Number(env.SUPABASE_MAX_RPS) : DEFAULT_MAX_RPS;
    const gapMs = 1000 / maxRps;
    let nextSlot = 0;

    const counts = new Map();          // key -> calls this window
    const errorCounts = new Map();     // key -> errors this window
    const breakers = new Map();        // key -> { fails: number[], openUntil: number }
    const lastErrorLog = new Map();    // signature -> { at, suppressed }
    let windowStart = now();
    let blocked = 0;

    async function acquire() {
        const t = now();
        const slot = Math.max(t, nextSlot);
        nextSlot = slot + gapMs;
        const wait = slot - t;
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    }

    function breakerFor(key) {
        let b = breakers.get(key);
        if (!b) { b = { fails: [], openUntil: 0 }; breakers.set(key, b); }
        return b;
    }

    function noteSuccess(key) {
        const b = breakers.get(key);
        if (b && b.fails.length) b.fails.length = 0;
    }

    function noteFailure(key) {
        const b = breakerFor(key);
        const t = now();
        b.fails.push(t);
        while (b.fails.length && t - b.fails[0] > BREAKER_WINDOW_MS) b.fails.shift();
        if (b.fails.length >= BREAKER_FAILURES && b.openUntil <= t) {
            b.openUntil = t + BREAKER_OPEN_MS;
            b.fails.length = 0;
            onLog('error', 'db.circuit_open',
                `[${label}] ${key} failed ${BREAKER_FAILURES} times in a row; pausing that call for ${BREAKER_OPEN_MS / 1000}s so it stops hammering Supabase`,
                { key });
        }
    }

    function logError(key, status, url, bodyText) {
        const signature = `${key} ${status} ${String(bodyText).slice(0, 80)}`;
        const t = now();
        const prev = lastErrorLog.get(signature);
        if (prev && t - prev.at < ERROR_LOG_EVERY_MS) { prev.suppressed++; return; }
        const repeats = prev?.suppressed || 0;
        lastErrorLog.set(signature, { at: t, suppressed: 0 });
        onLog('error', 'db.error',
            `[${label}] ${key} -> ${status}${repeats ? ` (+${repeats} identical in the last minute)` : ''}: ${String(bodyText).slice(0, 300)}`,
            { key, status, url: String(url).slice(0, 400), repeats });
    }

    function flushStats() {
        const t = now();
        const elapsed = Math.max(1, (t - windowStart) / 1000);
        let total = 0;
        for (const n of counts.values()) total += n;
        if (total || blocked) {
            const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
                .map(([k, n]) => `${k}=${n}${errorCounts.get(k) ? `(${errorCounts.get(k)} err)` : ''}`).join(', ');
            const rps = total / elapsed;
            onLog(rps > HIGH_VOLUME_RPS ? 'warn' : 'info', rps > HIGH_VOLUME_RPS ? 'db.high_volume' : 'db.stats',
                `[${label}] ${total} Supabase calls in ${Math.round(elapsed)}s (${rps.toFixed(1)}/s${blocked ? `, ${blocked} blocked by breaker` : ''}). Top: ${top}`,
                { total, perSecond: Number(rps.toFixed(2)), blocked, top: Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) });
        }
        counts.clear(); errorCounts.clear(); blocked = 0; windowStart = t;
        for (const [sig, v] of lastErrorLog) if (t - v.at > ERROR_LOG_EVERY_MS * 5) lastErrorLog.delete(sig);
    }

    const timer = setInterval(flushStats, STATS_EVERY_MS);
    if (typeof timer.unref === 'function') timer.unref();

    async function guardedFetch(input, init = {}) {
        const { key, url } = describeRequest(input, init);
        const b = breakers.get(key);
        if (b && b.openUntil > now()) {
            blocked++;
            return new Response(JSON.stringify({ code: 'CIRCUIT_OPEN', message: `${key} paused after repeated failures` }), {
                status: 503, headers: { 'content-type': 'application/json' },
            });
        }
        await acquire();
        counts.set(key, (counts.get(key) || 0) + 1);
        try {
            const response = await (fetchImpl || fetch)(input, init);
            if (response.ok) {
                noteSuccess(key);
            } else {
                // A single() lookup that finds nothing answers 406; that is normal flow, not a failure streak.
                if (response.status !== 406) noteFailure(key);
                errorCounts.set(key, (errorCounts.get(key) || 0) + 1);
                let text = '';
                try { text = await response.clone().text(); } catch { /* body unavailable */ }
                logError(key, response.status, url, text);
            }
            return response;
        } catch (error) {
            noteFailure(key);
            errorCounts.set(key, (errorCounts.get(key) || 0) + 1);
            logError(key, 'network', url, error?.message || error);
            throw error;
        }
    }

    return { fetch: guardedFetch, flushStats, maxRps };
}
