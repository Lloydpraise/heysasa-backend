import test from 'node:test';
import assert from 'node:assert/strict';

import { describeConnectionUpdate, summariseClose } from './connectionDiagnostics.js';

test('reads the close code from an Evolution connection.update and explains it', () => {
  const info = describeConnectionUpdate({
    event: 'connection.update',
    instance: 'lashesbyshazz-abc',
    apikey: 'secret-key',
    data: { instance: 'lashesbyshazz-abc', state: 'close', statusReason: 401 },
  });

  assert.equal(info.state, 'close');
  assert.equal(info.statusCode, 401);
  assert.match(info.meaning, /logged out/);
  assert.match(summariseClose(info), /code 401/);
  assert.equal(info.raw.data.statusReason, 401);
});

test('finds the code inside a Baileys lastDisconnect error and keeps the error text', () => {
  const info = describeConnectionUpdate({
    instance: 'x',
    data: { state: 'close', lastDisconnect: { error: { message: 'Stream Errored (conflict)', output: { statusCode: 440 } } } },
  });

  assert.equal(info.statusCode, 440);
  assert.match(info.meaning, /replaced/);
  assert.equal(info.reasonText, 'Stream Errored (conflict)');
});

test('says so plainly when the payload carries no close code', () => {
  const info = describeConnectionUpdate({ instance: 'x', data: { state: 'close' } });

  assert.equal(info.statusCode, null);
  assert.match(summariseClose(info), /no close code/);
});

test('never keeps QR codes, pairing codes or API keys in the logged payload', () => {
  const info = describeConnectionUpdate({
    instance: 'x',
    apikey: 'secret-key',
    data: { state: 'connecting', qrcode: { base64: 'AAAA', code: 'ABCD' }, pairingCode: 'WXYZ1234' },
  });
  const text = JSON.stringify(info.raw);

  assert.equal(text.includes('AAAA'), false);
  assert.equal(text.includes('WXYZ1234'), false);
  assert.equal(text.includes('secret-key'), false);
});
