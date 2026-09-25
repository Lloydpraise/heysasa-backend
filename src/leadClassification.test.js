import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLeadClassification } from './leadClassification.js';

test('marks personal chats as personal when NLP says it is not a business chat', () => {
  const result = resolveLeadClassification({
    lead_type: 'personal',
    is_business_chat: false,
    quality_score: 1,
  }, 'pending_analysis');

  assert.equal(result.leadType, 'personal');
  assert.equal(result.isBusinessChat, false);
});

test('keeps manually set personal contacts untouched', () => {
  const result = resolveLeadClassification({
    lead_type: 'business',
    is_business_chat: true,
    quality_score: 7,
  }, 'personal');

  assert.equal(result.leadType, 'personal');
  assert.equal(result.isBusinessChat, false);
});

test('promotes pending contacts to business when the chat is clearly business', () => {
  const result = resolveLeadClassification({
    lead_type: 'business',
    is_business_chat: true,
    quality_score: 7,
  }, 'pending');

  assert.equal(result.leadType, 'business');
  assert.equal(result.isBusinessChat, true);
});
