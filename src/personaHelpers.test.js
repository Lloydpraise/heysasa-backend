import test from 'node:test';
import assert from 'node:assert/strict';
import {
  squash, redact, isLowValueVoiceMessage, capPerConversation, phraseSupport,
  validateObjectionEntries, cleanTriggers,
} from './personaHelpers.js';

const evenSample = (arr, cap) => {
  if (arr.length <= cap) return arr;
  const step = arr.length / cap;
  return Array.from({ length: cap }, (_, i) => arr[Math.floor(i * step)]);
};

test('redact strips tax PINs, phone numbers, emails, receipt codes and long numbers', () => {
  assert.equal(redact('Pin P051106414K'), 'Pin [pin]');
  assert.equal(redact('call 0712 345 678 or +254712345678'), 'call [phone] or [phone]');
  assert.equal(redact('mail me a@b.co.ke'), 'mail me [email]');
  assert.equal(redact('Confirmed SJK4L9QW2X paid'), 'Confirmed [code] paid');
  assert.equal(redact('acc 0123456789012'), 'acc [number]');
  assert.equal(redact('Hello, we have it in stock'), 'Hello, we have it in stock');
});

test('redact does not eat ordinary words or short uppercase tokens', () => {
  assert.equal(redact('M-Pesa and KRA are fine'), 'M-Pesa and KRA are fine');
  assert.equal(redact('2 burner at 17k'), '2 burner at 17k');
});

test('low-value voice messages: amounts, acknowledgements and identifiers are dropped', () => {
  for (const t of ['135k', '10k', 'Ok', 'Done', 'Pay 300', '[pin]', '', '  ', 'ok thanks']) {
    assert.equal(isLowValueVoiceMessage(t), true, t);
  }
  for (const t of ["Hello it's available in stock", 'Received with thanks. Be blessed', 'Kindly share the receipt']) {
    assert.equal(isLowValueVoiceMessage(t), false, t);
  }
});

test('one long chat cannot dominate: per-conversation cap spreads evenly', () => {
  const msgs = [
    ...Array.from({ length: 300 }, (_, i) => ({ id: `a${i}`, conversation_id: 'agency' })),
    ...Array.from({ length: 5 }, (_, i) => ({ id: `b${i}`, conversation_id: 'cust1' })),
  ];
  const out = capPerConversation(msgs, 20, evenSample);
  assert.equal(out.filter(m => m.conversation_id === 'agency').length, 20);
  assert.equal(out.filter(m => m.conversation_id === 'cust1').length, 5);
  assert.deepEqual(out.map(m => m.id), msgs.filter(m => out.includes(m)).map(m => m.id)); // order preserved
});

test('phrase support counts separate messages and ignores punctuation/case', () => {
  const texts = ['Received with thanks. Be blessed', 'received with thanks', 'Hello', 'Be blessed'];
  assert.equal(phraseSupport('Received with thanks', texts), 2);
  assert.equal(phraseSupport('Be blessed', texts), 2);
  assert.equal(phraseSupport('Niprompt', texts), 0);
  assert.equal(phraseSupport('ok', texts), 0);
});

const customerCorpus = squash('Is it negotiable ?\nbest price\n85 k to be negotiated\nnataka kupewa quote na transporter');
const ownerCorpus = squash('Yes it\'s negotiable\n17k\nHello it\'s available in stock\nOraimo ndio human na moto sana');

test('objection entries are kept only when customer words and owner reply come from the right side', () => {
  const { kept, dropped } = validateObjectionEntries([
    { objection_type: 'price', objection: 'Is it negotiable ?', owner_reply: "Yes it's negotiable", response_strategy: 's', suggested_language: "Yes it's negotiable", escalation_if_repeated: 'e' },
    // customer's sentence presented as the owner's reply
    { objection_type: 'price', objection: 'best price', owner_reply: 'nataka kupewa quote na transporter', suggested_language: 'x' },
    // owner text presented as the objection
    { objection_type: 'price', objection: 'Oraimo ndio human na moto sana', owner_reply: '17k', suggested_language: 'x' },
    // invented
    { objection_type: 'price', objection: 'It is too expensive for me', owner_reply: 'We can discount', suggested_language: 'x' },
  ], { customerCorpus, ownerCorpus });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].objection, 'Is it negotiable ?');
  assert.equal(dropped.length, 3);
  assert.ok(dropped[0].reasons.includes('reply_not_from_owner'));
  assert.ok(dropped[1].reasons.includes('objection_not_from_customer'));
});

test('suggested_language is redacted and unknown objection types fall back safely', () => {
  const { kept } = validateObjectionEntries([
    { objection_type: 'weird', objection: 'best price', owner_reply: '17k', suggested_language: 'Pay to 0712345678 please' },
  ], { customerCorpus, ownerCorpus });
  assert.equal(kept[0].suggested_language, 'Pay to [phone] please');
  assert.equal(kept[0].objection_type, 'price');
});

test('trigger cleaning removes identifiers, amounts-as-numbers, duplicates and long sentences', () => {
  const out = cleanTriggers([
    'Nitume', 'nitume', 'Nitume 58k', 'Pin P051106414K', 'Naomba waybill', 'Kindly share the receipt',
    'refund us the money', 'this is a very long sentence that is clearly not a short trigger phrase at all',
    'call 0712345678',
  ]);
  assert.deepEqual(out, ['Nitume', 'Nitume 58k', 'Naomba waybill', 'Kindly share the receipt', 'refund us the money']);
});
