import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedOrigin, normalizeAllowedOrigins } from './cors.js';

test('normalizes trailing slashes from configured origins', () => {
  assert.deepEqual(normalizeAllowedOrigins('https://heysasa.co.ke/,http://localhost:5173/'), [
    'https://heysasa.co.ke',
    'http://localhost:5173',
  ]);
});

test('allows localhost dev origins with or without a trailing slash', () => {
  assert.equal(isAllowedOrigin('http://localhost:5173', ['http://localhost:5173/']), true);
  assert.equal(isAllowedOrigin('http://localhost:5173/', ['http://localhost:5173']), true);
  assert.equal(isAllowedOrigin('http://localhost:5173', []), true);
});

test('blocks unlisted origins even when they are not localhost', () => {
  assert.equal(isAllowedOrigin('https://evil.example', ['http://localhost:5173']), false);
});
