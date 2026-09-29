import test from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyOpenAIFailure,
  parseDurationMs,
  getOpenAIAvailabilityState,
  getOpenAICooldownMs,
  noteOpenAIRateLimited,
  setOpenAIUnavailable,
  clearOpenAIUnavailable,
  shouldPauseOpenAIRequest,
} from '../src/lib/openAiGate.js'

const quotaBody = JSON.stringify({ error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', code: 'insufficient_quota' } })
const rateBody = JSON.stringify({ error: { message: 'Rate limit reached for gpt-4.1-mini on tokens per min (TPM)', type: 'tokens', code: 'rate_limit_exceeded' } })

test('a 429 with insufficient_quota is a hard quota failure', () => {
  assert.equal(classifyOpenAIFailure({ status: 429, bodyText: quotaBody }).kind, 'quota')
})

test('a 429 with rate_limit_exceeded is NOT a quota failure (this was the "had credits but got 429" bug)', () => {
  const f = classifyOpenAIFailure({ status: 429, bodyText: rateBody })
  assert.equal(f.kind, 'rate_limit')
  assert.ok(f.retryAfterMs > 0)
})

test('rate limit wait honours retry headers and is capped', () => {
  const headers = new Headers({ 'x-ratelimit-reset-tokens': '6s' })
  assert.equal(classifyOpenAIFailure({ status: 429, bodyText: rateBody, headers }).retryAfterMs, 6000)
  const long = new Headers({ 'retry-after': '3600' })
  assert.equal(classifyOpenAIFailure({ status: 429, bodyText: rateBody, headers: long }).retryAfterMs, 60000)
})

test('rejected keys are auth failures; 5xx and network errors are transient', () => {
  assert.equal(classifyOpenAIFailure({ status: 401, bodyText: '{}' }).kind, 'auth')
  assert.equal(classifyOpenAIFailure({ status: 400, bodyText: JSON.stringify({ error: { code: 'invalid_api_key' } }) }).kind, 'auth')
  assert.equal(classifyOpenAIFailure({ status: 503, bodyText: '' }).kind, 'transient')
  assert.equal(classifyOpenAIFailure({ status: null, bodyText: '' }).kind, 'transient')
  assert.equal(classifyOpenAIFailure({ status: 400, bodyText: '{}' }).kind, 'other')
})

test('parses OpenAI duration strings', () => {
  assert.equal(parseDurationMs('6m0s'), 360000)
  assert.equal(parseDurationMs('120ms'), 120)
  assert.equal(parseDurationMs('1.5s'), 1500)
  assert.equal(parseDurationMs('20'), 20000)
  assert.equal(parseDurationMs('nonsense'), null)
  assert.equal(parseDurationMs(null), null)
})

test('a rate limit sets a shared cooldown but never pauses the gate', () => {
  clearOpenAIUnavailable()
  noteOpenAIRateLimited(5000)
  assert.ok(getOpenAICooldownMs() > 0 && getOpenAICooldownMs() <= 5000)
  assert.equal(shouldPauseOpenAIRequest(), false)
  assert.equal(getOpenAIAvailabilityState().available, true)
})

test('a hard latch pauses requests, schedules its own recheck, and can be cleared', () => {
  setOpenAIUnavailable({ status: 429, reason: 'insufficient_quota' })
  assert.equal(shouldPauseOpenAIRequest(), true)
  const state = getOpenAIAvailabilityState()
  assert.equal(state.available, false)
  assert.match(state.message, /cant call ai on debug 'openai 429 or 401 error'/i)
  assert.ok(new Date(state.nextRecheckAt).getTime() > Date.now(), 'auto-recheck is scheduled in the future')
  clearOpenAIUnavailable()
  assert.equal(shouldPauseOpenAIRequest(), false)
})
