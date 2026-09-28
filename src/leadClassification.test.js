import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveLeadClassification,
  decideClassification,
  normalizeNlp,
  evidenceSupported,
  resolveLeadQuality,
  resolveFollowUpUrgency,
  FailureGuard,
  FatalRunError,
  isHealthyRun,
} from './leadClassification.js';

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

// ── Analyser v2 ──────────────────────────────────────────────────────────────
const CHAT = 'Waiting for the funds shall be well. Send me the deposit details. Where to pay rent';

test('confident personal verdict makes the contact personal and not a business chat', () => {
  const d = decideClassification({
    llm: { lead_type: 'personal', confidence: 0.92, reason: 'Rent and church matters', evidence: 'Where to pay rent' },
    transcriptText: CHAT,
  });
  assert.equal(d.leadType, 'personal');
  assert.equal(d.isBusinessChat, false);
});

test('low-confidence verdicts stay unknown and are flagged for review', () => {
  const d = decideClassification({
    llm: { lead_type: 'business', confidence: 0.5, reason: 'unclear', evidence: 'Send me the deposit details' },
    transcriptText: CHAT,
  });
  assert.equal(d.leadType, 'unknown');
  assert.equal(d.isBusinessChat, null);
  assert.equal(d.needsReview, true);
});

test('made-up classifier evidence lowers trust below the floor', () => {
  const d = decideClassification({
    llm: { lead_type: 'personal', confidence: 0.7, reason: 'x', evidence: 'totally invented quote here' },
    transcriptText: CHAT,
  });
  assert.equal(d.leadType, 'unknown');
});

test('ad leads and won/lost leads are business without asking the model', () => {
  assert.equal(decideClassification({ hasAdReferral: true }).leadType, 'business');
  assert.equal(decideClassification({ leadState: 'won' }).leadType, 'business');
});

test('evidenceSupported accepts real quotes and rejects invented ones', () => {
  assert.equal(evidenceSupported('Send me the deposit details', CHAT), true);
  assert.equal(evidenceSupported('I want to buy three laptops today', CHAT), false);
  assert.equal(evidenceSupported('Send', CHAT), false);
});

test('normalizeNlp downgrades commercial intent that has no supporting quote', () => {
  const { nlp, flags } = normalizeNlp(
    { intent: 'buying', quality_score: 9, follow_up_urgency: 'hot', intent_evidence: 'I want to buy three laptops' },
    { customerText: CHAT }
  );
  assert.equal(nlp.intent, 'unknown');
  assert.ok(nlp.quality_score <= 3);
  assert.ok(flags.includes('intent_downgraded_no_evidence'));
});

test('normalizeNlp keeps a well-supported buying signal', () => {
  const { nlp, flags } = normalizeNlp(
    { intent: 'price_check', quality_score: 7, intent_evidence: 'Where to pay rent' },
    { customerText: CHAT }
  );
  assert.equal(nlp.intent, 'price_check');
  assert.equal(nlp.quality_score, 7);
  assert.equal(flags.length, 0);
});

test('lead quality: non-business contacts never get one', () => {
  assert.equal(resolveLeadQuality({ leadType: 'personal', intentScore: 90 }), null);
  assert.equal(resolveLeadQuality({ leadType: 'unknown', intentScore: 90 }), null);
});

test('lead quality: behaviour alone (no analysis) can never be hot', () => {
  assert.equal(resolveLeadQuality({ leadType: 'business', leadState: 'engaged', intentScore: 95 }), 'warm');
});

test('lead quality: hot needs commercial intent, ghosted caps at warm', () => {
  assert.equal(resolveLeadQuality({ leadType: 'business', leadState: 'engaged', aiQuality: 8, aiIntent: 'buying' }), 'hot');
  assert.equal(resolveLeadQuality({ leadType: 'business', leadState: 'engaged', aiQuality: 8, aiIntent: 'support' }), 'warm');
  assert.equal(resolveLeadQuality({ leadType: 'business', leadState: 'ghosted', aiQuality: 8, aiIntent: 'buying' }), 'warm');
  assert.equal(resolveLeadQuality({ leadType: 'business', leadState: 'engaged', aiQuality: 2, aiIntent: 'unknown' }), 'cold');
});

test('urgency: a waiting customer with buying intent is hot', () => {
  assert.equal(resolveFollowUpUrgency({ leadType: 'business', leadState: 'engaged', aiQuality: 7, aiIntent: 'buying', awaiting: true, daysSinceLastInbound: 1 }), 'hot');
});

test('urgency: waiting customer with weak signal is warm; no signal at all is cold', () => {
  assert.equal(resolveFollowUpUrgency({ leadType: 'business', leadState: 'engaged', aiQuality: 4, aiIntent: 'browsing', awaiting: true, daysSinceLastInbound: 1 }), 'warm');
  assert.equal(resolveFollowUpUrgency({ leadType: 'business', leadState: 'engaged', aiQuality: 1, aiIntent: 'unknown', awaiting: true, daysSinceLastInbound: 1 }), 'cold');
});

test('urgency: hot requires someone waiting; closed and ghosted leads are cold', () => {
  assert.equal(resolveFollowUpUrgency({ leadType: 'business', leadState: 'engaged', aiUrgency: 'hot', aiQuality: 8, aiIntent: 'buying', awaiting: false, daysSinceLastInbound: 1 }), 'warm');
  assert.equal(resolveFollowUpUrgency({ leadType: 'business', leadState: 'won', awaiting: true }), 'cold');
  assert.equal(resolveFollowUpUrgency({ leadType: 'business', leadState: 'ghosted', aiUrgency: 'warm', awaiting: false }), 'cold');
  assert.equal(resolveFollowUpUrgency({ leadType: 'personal', awaiting: true }), null);
});

// ── Failure handling ─────────────────────────────────────────────────────────
test('guard: isolated failures never stop a run', () => {
  const g = new FailureGuard('T');
  for (let i = 0; i < 100; i++) { if (i % 10 === 3) g.fail('bad chat'); else g.ok(); }
  assert.equal(g.failed, 10);
});

test('guard: 10 failures in a row stops the run', () => {
  const g = new FailureGuard('T');
  for (let i = 0; i < 9; i++) g.fail('boom');
  assert.throws(() => g.fail('boom'), (e) => e instanceof FatalRunError && /10 failures in a row/.test(e.message));
});

test('guard: a success resets the consecutive count', () => {
  const g = new FailureGuard('T');
  for (let i = 0; i < 9; i++) g.fail('boom');
  g.ok();
  for (let i = 0; i < 9; i++) g.fail('boom');
  assert.equal(g.consecutive, 9);
});

test('guard: a high failure rate in the first 30 items stops the run', () => {
  const g = new FailureGuard('T');
  // pattern F F ok F F ok ... keeps failures scattered (never 10 in a row) at ~67%
  assert.throws(() => {
    for (let i = 0; i < 30; i++) { if (i % 3 === 2) g.ok(); else g.fail('api 500'); }
  }, (e) => e instanceof FatalRunError && /of the first 30 items failed/.test(e.message));
});

test('guard: a modest failure rate in the first 30 items is tolerated', () => {
  const g = new FailureGuard('T');
  for (let i = 0; i < 30; i++) { if (i % 5 === 4) g.fail('x'); else g.ok(); } // 20%
  assert.equal(g.failed, 6);
});

test('healthy: tiny error counts are fine, large ones are not', () => {
  assert.equal(isHealthyRun(0, 500), true);
  assert.equal(isHealthyRun(3, 20), true);      // floor of 3 allowed
  assert.equal(isHealthyRun(25, 500), true);    // 5%
  assert.equal(isHealthyRun(26, 500), false);
  assert.equal(isHealthyRun(4, 20), false);
});