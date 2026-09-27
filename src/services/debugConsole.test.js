import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveWriterKey, shouldDisableWriterAfterError } from './debugConsole.js';
import { isDebugTokenValid } from '../middleware/debugAuth.js';

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
