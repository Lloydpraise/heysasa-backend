import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWhatsappConnectionRequest } from '../src/api/whatsappConnectionRequest.js';

test('accepts the frontend phoneNumber payload shape', () => {
  const result = normalizeWhatsappConnectionRequest({
    mode: 'phone',
    phoneNumber: '+254 (712) 345-678',
  });

  assert.deepEqual(result, {
    mode: 'phone',
    phoneNumber: '254712345678',
    error: null,
  });
});

test('accepts snake_case and pairing aliases from connected clients', () => {
  const result = normalizeWhatsappConnectionRequest({
    mode: 'pairing',
    phone_number: '+254 712 345 678',
  });

  assert.deepEqual(result, {
    mode: 'phone',
    phoneNumber: '254712345678',
    error: null,
  });
});

test('infers phone pairing when only a number is supplied', () => {
  const result = normalizeWhatsappConnectionRequest({
    phoneNumber: '+254 712 345 678',
  });

  assert.deepEqual(result, {
    mode: 'phone',
    phoneNumber: '254712345678',
    error: null,
  });
});

test('rejects unsupported modes cleanly', () => {
  const result = normalizeWhatsappConnectionRequest({ mode: 'magic-link' });

  assert.deepEqual(result, {
    mode: null,
    phoneNumber: null,
    error: 'mode_must_be_qr_or_phone',
  });
});
