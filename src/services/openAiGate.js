// Shared OpenAI availability gate.
//
// This exact file lives in TWO places (they are separate packages/processes and
// each keeps its own in-memory state):
//   - src/services/openAiGate.js            (main backend + analyser + persona child processes)
//   - followup-engine/src/lib/openAiGate.js (follow-up engine)
// Keep them byte-identical.
//
// WHY THIS WAS REWRITTEN
// A 429 from OpenAI means two very different things:
//   1. code "insufficient_quota"  -> credits are gone, or the project's spend
//      limit was hit, or the key belongs to a different org/project than the
//      one holding the credits. Retrying does not help until someone fixes it.
//   2. code "rate_limit_exceeded" -> a per-minute request/token limit (RPM/TPM).
//      This clears by itself in seconds, even with plenty of credit left.
// The old gate treated BOTH as "out of credits" and latched every OpenAI call
// off until someone hit /debug/openai/recheck by hand. A burst of traffic that
// tripped a per-minute limit therefore looked exactly like "ran out of credits
// but it had credits". Now only case 1 (and a bad key) latches; case 2 becomes
// a short shared cooldown that callers wait out and then retry.

const DEFAULT_MESSAGE = "cant call ai on debug 'openai 429 or 401 error'";

// When latched, probe again on this schedule (cheap ~20-token ping) so the
// system recovers on its own once credits are topped up or the key is fixed.
const RECHECK_STEPS_MS = [2, 5, 10, 20, 30].map((m) => m * 60_000);
const MAX_COOLDOWN_MS = 60_000;

let openAiState = freshState();
let cooldownUntil = 0;
let recheckInFlight = null;
let recheckAttempts = 0;

function freshState() {
  return {
    available: true,
    status: null,
    reason: '',
    message: 'OpenAI available',
    lastCheckedAt: null,
    unavailableSince: null,
    nextRecheckAt: null,
  };
}

// ── Failure classification ───────────────────────────────────────────────────

// Turns "1s", "6m0s", "120ms", or a plain number of seconds into milliseconds.
export function parseDurationMs(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().toLowerCase();
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(parseFloat(text) * 1000);
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  let total = 0;
  let matched = false;
  for (const m of text.matchAll(re)) {
    matched = true;
    total += parseFloat(m[1]) * unit[m[2]];
  }
  return matched ? Math.round(total) : null;
}

function readHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  return headers[name] ?? headers[name.toLowerCase()] ?? null;
}

function retryAfterFromHeaders(headers) {
  const candidates = [
    readHeader(headers, 'retry-after-ms'),
    readHeader(headers, 'retry-after'),
    readHeader(headers, 'x-ratelimit-reset-tokens'),
    readHeader(headers, 'x-ratelimit-reset-requests'),
  ];
  for (const c of candidates) {
    const ms = parseDurationMs(c);
    if (ms !== null && ms > 0) return ms;
  }
  return null;
}

// kind: 'quota' | 'auth' | 'rate_limit' | 'transient' | 'other'
//   quota / auth  -> hard stop (latch the gate)
//   rate_limit    -> wait retryAfterMs, then retry; never latch
//   transient     -> network/5xx; retry later, never latch
export function classifyOpenAIFailure({ status = null, bodyText = '', headers = null } = {}) {
  let code = '';
  let type = '';
  try {
    const parsed = JSON.parse(bodyText);
    code = String(parsed?.error?.code ?? '').toLowerCase();
    type = String(parsed?.error?.type ?? '').toLowerCase();
  } catch {
    // body was not JSON; fall back to text matching below
  }
  const text = `${code} ${type} ${String(bodyText || '').toLowerCase()}`;

  if (
    code === 'insufficient_quota' ||
    type === 'insufficient_quota' ||
    /insufficient_quota|billing_hard_limit|exceeded your current quota/.test(text)
  ) {
    return { kind: 'quota', retryAfterMs: null, code: code || 'insufficient_quota' };
  }
  if (status === 401 || status === 403 || code === 'invalid_api_key' || /invalid_api_key|incorrect api key/.test(text)) {
    return { kind: 'auth', retryAfterMs: null, code: code || 'auth' };
  }
  if (status === 429) {
    const retryAfterMs = retryAfterFromHeaders(headers) ?? 20_000;
    return { kind: 'rate_limit', retryAfterMs: Math.min(retryAfterMs, MAX_COOLDOWN_MS), code: code || 'rate_limit_exceeded' };
  }
  if (status === null || status === 408 || (typeof status === 'number' && status >= 500)) {
    return { kind: 'transient', retryAfterMs: null, code: code || 'transient' };
  }
  return { kind: 'other', retryAfterMs: null, code };
}

// ── State ────────────────────────────────────────────────────────────────────

export function getOpenAIAvailabilityState() {
  return {
    available: openAiState.available,
    status: openAiState.status,
    reason: openAiState.reason,
    message: openAiState.message,
    lastCheckedAt: openAiState.lastCheckedAt,
    unavailableSince: openAiState.unavailableSince,
    nextRecheckAt: openAiState.nextRecheckAt,
    cooldownMs: getOpenAICooldownMs(),
    health: openAiState.available ? 'ok' : 'unavailable',
  };
}

// True only while the gate is hard-latched (credits gone / bad key). If the
// scheduled recheck time has passed it also kicks off ONE background probe, so
// the system heals itself without anyone calling /debug/openai/recheck.
export function shouldPauseOpenAIRequest() {
  if (openAiState.available) return false;
  maybeAutoRecheck();
  return true;
}

function maybeAutoRecheck() {
  if (recheckInFlight) return;
  if (!openAiState.nextRecheckAt) return;
  if (Date.now() < new Date(openAiState.nextRecheckAt).getTime()) return;
  recheckInFlight = checkOpenAIAvailability({ force: true })
    .catch(() => {})
    .finally(() => { recheckInFlight = null; });
}

function scheduleNextRecheck() {
  const step = RECHECK_STEPS_MS[Math.min(recheckAttempts, RECHECK_STEPS_MS.length - 1)];
  return new Date(Date.now() + step).toISOString();
}

// Hard latch. Callers should use this ONLY for kind 'quota' or 'auth'.
export function setOpenAIUnavailable({ status = null, reason = '', message = DEFAULT_MESSAGE } = {}) {
  const wasAvailable = openAiState.available;
  openAiState = {
    available: false,
    status: status ?? null,
    reason: String(reason || ''),
    message: message || DEFAULT_MESSAGE,
    lastCheckedAt: new Date().toISOString(),
    unavailableSince: openAiState.unavailableSince || new Date().toISOString(),
    nextRecheckAt: wasAvailable ? scheduleNextRecheck() : openAiState.nextRecheckAt,
  };
  return getOpenAIAvailabilityState();
}

export function clearOpenAIUnavailable() {
  recheckAttempts = 0;
  openAiState = { ...freshState(), lastCheckedAt: new Date().toISOString() };
  return getOpenAIAvailabilityState();
}

// A rate limit is not an outage: record a short shared cooldown so every caller
// in this process backs off together instead of all retrying at once.
export function noteOpenAIRateLimited(retryAfterMs = 20_000) {
  const ms = Math.min(Math.max(Number(retryAfterMs) || 0, 1000), MAX_COOLDOWN_MS);
  cooldownUntil = Math.max(cooldownUntil, Date.now() + ms);
  return ms;
}

export function getOpenAICooldownMs() {
  return Math.max(0, cooldownUntil - Date.now());
}

// ── Probe ────────────────────────────────────────────────────────────────────

export async function checkOpenAIAvailability({ force = false } = {}) {
  if (!force && openAiState.available) {
    return getOpenAIAvailabilityState();
  }

  if (!process.env.OPENAI_API_KEY) {
    return setOpenAIUnavailable({
      status: 401,
      reason: 'missing OPENAI_API_KEY',
      message: 'OpenAI Unavailable: missing OPENAI_API_KEY',
    });
  }

  const startedAt = Date.now();
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        max_tokens: 8,
        temperature: 0,
        messages: [
          { role: 'system', content: 'Return only JSON: {"ok":true}' },
          { role: 'user', content: 'ping' },
        ],
      }),
    });

    const bodyText = await res.text().catch(() => '');
    if (res.ok) return clearOpenAIUnavailable();

    const failure = classifyOpenAIFailure({ status: res.status, bodyText, headers: res.headers });

    if (failure.kind === 'quota' || failure.kind === 'auth') {
      const wasLatched = !openAiState.available;
      setOpenAIUnavailable({
        status: Number(res.status),
        reason: bodyText.slice(0, 300) || 'OpenAI rejected the request',
        message: DEFAULT_MESSAGE,
      });
      if (wasLatched) {
        // Still broken after a probe: back off further before the next one.
        recheckAttempts += 1;
        openAiState.nextRecheckAt = scheduleNextRecheck();
      }
      return { ...getOpenAIAvailabilityState(), durationMs: Date.now() - startedAt };
    }

    if (failure.kind === 'rate_limit') {
      // Credits are fine, the account is just throttled. Not an outage.
      noteOpenAIRateLimited(failure.retryAfterMs);
      return { ...clearOpenAIUnavailable(), durationMs: Date.now() - startedAt };
    }

    return {
      ...getOpenAIAvailabilityState(),
      available: false,
      status: Number(res.status),
      reason: bodyText.slice(0, 300) || 'OpenAI healthcheck failed',
      message: 'OpenAI Unavailable',
      lastCheckedAt: new Date().toISOString(),
      health: 'unavailable',
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    // Network errors and timeouts never latch the gate; they say nothing about credits.
    return {
      ...getOpenAIAvailabilityState(),
      available: false,
      status: null,
      reason: String(error?.message || 'healthcheck failed'),
      message: 'OpenAI Unavailable',
      lastCheckedAt: new Date().toISOString(),
      health: 'unavailable',
    };
  }
}
