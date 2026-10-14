import test from 'node:test';
import assert from 'node:assert/strict';
import { renderOwnerRules } from './ownerRules.ts';
import { buildInstructions } from './prompt.ts';

test('opening hours and hand-off reasons become plain rules', () => {
  const text = renderOwnerRules({
    business_hours: { open: '08:00', close: '18:30', days: [1, 2, 3, 4, 5, 6] },
    handoff_reasons: ['asks_for_call', 'ready_to_pay', 'asks_for_call'],
  });
  assert.match(text, /^OWNER RULES/);
  assert.match(text, /open Mon to Sat, 08:00 to 18:30/);
  assert.match(text, /the customer asks for a call; the customer is ready to pay\./);
  assert.equal((text.match(/asks for a call/g) ?? []).length, 1);
});

test('missing or malformed settings give nothing, and unknown reasons are ignored', () => {
  assert.equal(renderOwnerRules(null), '');
  assert.equal(renderOwnerRules({}), '');
  assert.equal(renderOwnerRules({ business_hours: { open: '8am', close: '18:00', days: [1] } }), '');
  assert.equal(renderOwnerRules({ handoff_reasons: ['bogus', 7] }), '');
  assert.match(renderOwnerRules({ business_hours: { open: '09:00', close: '17:00' } }), /open 09:00 to 17:00\./);
  assert.match(renderOwnerRules({ business_hours: { open: '09:00', close: '17:00', days: [1, 3] } }), /Mon, Wed, 09:00/);
});

test('the rules reach the instructions only when there are some', () => {
  const base = { businessName: 'Biz', currency: 'KES', persona: { persona: 'warm' }, categories: [], skillMenu: [] };
  assert.doesNotMatch(buildInstructions(base), /OWNER RULES/);
  assert.match(buildInstructions({ ...base, ownerRules: 'OWNER RULES (set by the owner, always follow them)\n- x' }), /OWNER RULES[\s\S]*SKILL MENU/);
});
