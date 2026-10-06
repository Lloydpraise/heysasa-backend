import test from 'node:test';
import assert from 'node:assert/strict';

import { decideSettle, normaliseEvolutionState, readConfirmedState, webhookStateOf } from './connectionSettle.js';

test('maps Evolution and webhook states', () => {
  assert.equal(normaliseEvolutionState({ instance: { state: 'open' } }), 'open');
  assert.equal(normaliseEvolutionState({ state: 'CLOSE' }), 'close');
  assert.equal(normaliseEvolutionState({ instance: { state: 'connecting' } }), 'connecting');
  assert.equal(normaliseEvolutionState({}), null);
  assert.equal(webhookStateOf('open'), 'open');
  assert.equal(webhookStateOf('closed'), 'close');
  assert.equal(webhookStateOf('unknown'), 'connecting');
});

test('Oct 6 Lashes case: a late connecting webhook cannot undo a connection Evolution says is open', () => {
  assert.deepEqual(decideSettle({ webhookState: 'connecting', evolution: 'open', existingStatus: 'connected' }), { action: 'connected' });
  assert.deepEqual(decideSettle({ webhookState: 'connecting', evolution: 'open', existingStatus: 'pending' }), { action: 'connected' });
});

test('a reconnect blip on a connected session is kept; a new or pending one stays pending', () => {
  assert.equal(decideSettle({ webhookState: 'connecting', evolution: 'connecting', existingStatus: 'connected' }).action, 'keep');
  assert.equal(decideSettle({ webhookState: 'connecting', evolution: 'connecting', existingStatus: 'pending' }).action, 'pending');
  assert.equal(decideSettle({ webhookState: 'connecting', evolution: 'connecting' }).action, 'pending');
});

test('a close webhook alone never deletes: Evolution has to confirm it', () => {
  assert.equal(decideSettle({ webhookState: 'close', evolution: 'open', existingStatus: 'connected' }).action, 'connected');
  assert.equal(decideSettle({ webhookState: 'close', evolution: 'connecting', existingStatus: 'connected' }).action, 'keep');
  assert.equal(decideSettle({ webhookState: 'close', evolution: null, existingStatus: 'connected' }).action, 'keep');
});

test('confirmed close or a missing instance is the only path to disconnect', () => {
  assert.equal(decideSettle({ webhookState: 'close', evolution: 'close', existingStatus: 'connected' }).action, 'disconnect');
  assert.equal(decideSettle({ webhookState: 'close', evolution: 'missing', existingStatus: 'connected' }).action, 'disconnect');
});

test('when Evolution cannot be reached: trust an open webhook, never delete or downgrade', () => {
  assert.equal(decideSettle({ webhookState: 'open', evolution: null, existingStatus: 'pending' }).action, 'connected');
  assert.equal(decideSettle({ webhookState: 'connecting', evolution: null, existingStatus: 'connected' }).action, 'keep');
  assert.equal(decideSettle({ webhookState: 'connecting', evolution: null }).action, 'pending');
});

test('readConfirmedState re-reads a close so a reconnect in progress is not mistaken for a disconnect', async () => {
  const reads = ['close', 'open'];
  let waited = 0;
  const state = await readConfirmedState(async () => reads.shift(), { delayMs: 5, wait: async () => { waited += 1; } });
  assert.equal(state, 'open');
  assert.equal(waited, 1);

  const twice = ['close', 'close'];
  assert.equal(await readConfirmedState(async () => twice.shift(), { wait: async () => {} }), 'close');

  let calls = 0;
  assert.equal(await readConfirmedState(async () => { calls += 1; return 'open'; }, { wait: async () => {} }), 'open');
  assert.equal(calls, 1);
});
