import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveWriterKey, shouldDisableWriterAfterError } from './debugConsole.js';
import { resolveBusinessProgress } from './businessProgress.js';
import { isDebugTokenValid } from '../middleware/debugAuth.js';
import { getOpenAIAvailabilityState, setOpenAIUnavailable, shouldPauseOpenAIRequest, clearOpenAIUnavailable } from './openAiGate.js';

test('accepts valid debug tokens for console-triggered business actions', () => {
  const original = process.env.DEBUG_TOKEN;
  try {
    process.env.DEBUG_TOKEN = 'console-secret';
    const req = {
      headers: { 'x-debug-token': 'console-secret' },
      query: {},
    };
    assert.equal(isDebugTokenValid(req), true);
  } finally {
    if (original === undefined) delete process.env.DEBUG_TOKEN;
    else process.env.DEBUG_TOKEN = original;
  }
});

test('rejects invalid debug tokens for console-triggered business actions', () => {
  const original = process.env.DEBUG_TOKEN;
  try {
    process.env.DEBUG_TOKEN = 'console-secret';
    const req = {
      headers: { 'x-debug-token': 'wrong-secret' },
      query: {},
    };
    assert.equal(isDebugTokenValid(req), false);
  } finally {
    if (original === undefined) delete process.env.DEBUG_TOKEN;
    else process.env.DEBUG_TOKEN = original;
  }
});

test('prefers the service role key when both Supabase key env vars are present', () => {
  const originalRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const originalLegacy = process.env.SUPABASE_SERVICE_KEY;

  try {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'role-key';
    process.env.SUPABASE_SERVICE_KEY = 'legacy-key';
    assert.equal(resolveWriterKey(), 'role-key');
  } finally {
    if (originalRole === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalRole;

    if (originalLegacy === undefined) delete process.env.SUPABASE_SERVICE_KEY;
    else process.env.SUPABASE_SERVICE_KEY = originalLegacy;
  }
});

test('marks invalid API key errors as non-retriable for the debug logger', () => {
  assert.equal(shouldDisableWriterAfterError({ message: 'Invalid API key' }), true);
  assert.equal(shouldDisableWriterAfterError({ message: 'relation "system_logs" does not exist' }), false);
});

test('resolves the active business run progress from analysis and persona state', () => {
  const state = resolveBusinessProgress({
    analysisRun: { run_type: 'full_pass', status: 'running', phase: 'nlp', progress_done: 6, progress_total: 10 },
    personaRun: { run_type: 'persona_pack', status: 'running', phase: 'voice_mining', progress_done: 2, progress_total: 5 },
  });

  assert.equal(state.active, true);
  assert.equal(state.label, 'Analysis');
  assert.equal(state.percent, 60);
  assert.equal(state.phase, 'nlp');
});

test('returns idle state when no analysis or persona run is active', () => {
  const state = resolveBusinessProgress({
    analysisRun: { run_type: 'full_pass', status: 'completed', progress_done: 10, progress_total: 10 },
    personaRun: { run_type: 'persona_pack', status: 'completed', progress_done: 5, progress_total: 5 },
  });

  assert.equal(state.active, false);
  assert.equal(state.percent, 0);
  assert.equal(state.label, '');
});

test('pauses OpenAI requests after a 401/429 and exposes the unavailable message', () => {
  setOpenAIUnavailable({ status: 429, reason: 'rate limited' });
  const state = getOpenAIAvailabilityState();

  assert.equal(shouldPauseOpenAIRequest(), true);
  assert.equal(state.available, false);
  assert.match(state.message, /cant call ai on debug 'openai 429 or 401 error'/i);

  clearOpenAIUnavailable();
  assert.equal(shouldPauseOpenAIRequest(), false);
});
