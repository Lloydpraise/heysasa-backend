// The two OpenAI calls Ask HeySasa makes: a streaming Responses call, and an embedding. Plain fetch, so tests can fake it.
// Both honour the shared OpenAI gate (credits gone / bad key latches it; a rate limit only makes callers wait).

import {
  classifyOpenAIFailure, getOpenAICooldownMs, getOpenAIAvailabilityState, noteOpenAIRateLimited, setOpenAIUnavailable, shouldPauseOpenAIRequest,
} from '../services/openAiGate.js';

const BASE = 'https://api.openai.com/v1';
export const EMBEDDING_MODEL = 'text-embedding-3-small';

export class OpenAiError extends Error {
  constructor(message, kind = 'other') { super(message); this.kind = kind; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function guard(sleepFn) {
  const cooldown = getOpenAICooldownMs();
  if (cooldown > 0) await sleepFn(Math.min(cooldown, 8000));
  if (shouldPauseOpenAIRequest()) throw new OpenAiError(getOpenAIAvailabilityState().message || 'OpenAI is unavailable', 'unavailable');
}

async function failFrom(res) {
  const body = await res.text().catch(() => '');
  const failure = classifyOpenAIFailure({ status: res.status, bodyText: body, headers: res.headers });
  if (failure.kind === 'quota' || failure.kind === 'auth') {
    setOpenAIUnavailable({ status: res.status, reason: body.slice(0, 300), message: "cant call ai on debug 'openai 429 or 401 error'" });
  } else if (failure.kind === 'rate_limit') {
    noteOpenAIRateLimited(failure.retryAfterMs);
  }
  return new OpenAiError(`OpenAI returned ${res.status}: ${body.slice(0, 300)}`, failure.kind);
}

// Reads a Server-Sent-Events body and calls onEvent({event, data}) for each event.
async function readSse(body, onEvent) {
  const decoder = new TextDecoder();
  let pending = '';
  const handle = (block) => {
    let event = 'message';
    const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (!data.length) return;
    const raw = data.join('\n');
    if (raw === '[DONE]') return;
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return; }
    onEvent({ event: parsed.type || event, data: parsed });
  };
  for await (const chunk of body) {
    pending += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let at;
    while ((at = pending.indexOf('\n\n')) >= 0) {
      handle(pending.slice(0, at));
      pending = pending.slice(at + 2);
    }
  }
  if (pending.trim()) handle(pending);
}

// Streams one Responses API call. onDelta(text) gets output text as it arrives. Resolves with the final response object.
export function makeStreamingModel({ apiKey, fetchFn = fetch, sleepFn = sleep, timeoutMs = 90_000 }) {
  return async function callModel(body, onDelta = () => {}) {
    if (!apiKey) throw new OpenAiError('OPENAI_API_KEY is not set', 'auth');
    await guard(sleepFn);
    const res = await fetchFn(`${BASE}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ ...body, stream: true }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw await failFrom(res);

    let final = null;
    let failure = null;
    await readSse(res.body, ({ event, data }) => {
      if (event === 'response.output_text.delta' && typeof data.delta === 'string') onDelta(data.delta);
      else if (event === 'response.completed') final = data.response;
      else if (event === 'response.failed') failure = data.response?.error?.message || 'the model call failed';
      else if (event === 'response.incomplete') final = data.response;
      else if (event === 'error') failure = data.message || 'the model call failed';
    });
    if (failure) throw new OpenAiError(String(failure).slice(0, 300), 'transient');
    if (!final) throw new OpenAiError('the model stream ended without a result', 'transient');
    return final;
  };
}

// embed(text, businessId) -> number[]. Billing for the tokens is done by the caller-supplied onUsage.
export function makeEmbedder({ apiKey, fetchFn = fetch, sleepFn = sleep, onUsage = () => {} }) {
  return async function embed(text, businessId) {
    if (!apiKey) throw new OpenAiError('OPENAI_API_KEY is not set', 'auth');
    await guard(sleepFn);
    const res = await fetchFn(`${BASE}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: String(text).slice(0, 2000) }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw await failFrom(res);
    const data = await res.json();
    const vector = data?.data?.[0]?.embedding;
    if (!Array.isArray(vector)) throw new OpenAiError('OpenAI returned no embedding', 'transient');
    onUsage({ businessId, model: EMBEDDING_MODEL, promptTokens: Number(data?.usage?.prompt_tokens ?? data?.usage?.total_tokens ?? 0) });
    return vector;
  };
}
