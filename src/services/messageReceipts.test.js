import test from 'node:test';
import assert from 'node:assert/strict';
import { extractReceiptUpdates, normalizeReceiptStatus, describePayloadShape } from './messageReceipts.js';

test('reads the Evolution v2 shape (keyId)', () => {
    const payload = { event: 'messages.update', data: { messageId: 'cl123', keyId: 'BAE5A1', remoteJid: '254700000000@s.whatsapp.net', fromMe: true, status: 'DELIVERY_ACK' } };
    assert.deepEqual(extractReceiptUpdates(payload), [{ whatsappMessageId: 'BAE5A1', status: 'DELIVERY_ACK', fromMe: true }]);
});

test('still reads the nested Baileys shape (key.id)', () => {
    const payload = { data: { key: { id: 'ABC', fromMe: true, remoteJid: 'x@s.whatsapp.net' }, status: 'READ' } };
    assert.deepEqual(extractReceiptUpdates(payload), [{ whatsappMessageId: 'ABC', status: 'READ', fromMe: true }]);
});

test('reads arrays and an update.status wrapper', () => {
    const payload = { data: [{ keyId: 'A', fromMe: true, status: 'SERVER_ACK' }, { key: { id: 'B', fromMe: true }, update: { status: 4 } }] };
    assert.deepEqual(extractReceiptUpdates(payload).map((u) => [u.whatsappMessageId, u.status]), [['A', 'SERVER_ACK'], ['B', 'READ']]);
});

test('skips receipts for messages the customer sent, and entries it cannot read', () => {
    const payload = { data: [{ keyId: 'IN1', fromMe: false, status: 'READ' }, { keyId: 'NOSTATUS', fromMe: true }, { fromMe: true, status: 'READ' }, null] };
    assert.deepEqual(extractReceiptUpdates(payload), []);
});

test('keeps receipts that do not say who sent the message (the database only matches our outbound rows)', () => {
    assert.equal(extractReceiptUpdates({ data: { keyId: 'K', status: 'delivery-ack' } })[0].status, 'DELIVERY_ACK');
});

test('normalises numeric and hyphenated statuses', () => {
    assert.equal(normalizeReceiptStatus(3), 'DELIVERY_ACK');
    assert.equal(normalizeReceiptStatus('5'), 'PLAYED');
    assert.equal(normalizeReceiptStatus('server-ack'), 'SERVER_ACK');
    assert.equal(normalizeReceiptStatus(''), null);
    assert.equal(normalizeReceiptStatus(99), null);
});

test('payload shape description never includes values', () => {
    const shape = describePayloadShape({ data: { keyId: 'SECRET', status: 'READ' } });
    assert.deepEqual(shape, { dataType: 'object', keys: ['keyId', 'status'] });
});
