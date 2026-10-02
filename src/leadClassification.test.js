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
  findOpenerTemplates,
  isOpenerOnly,
  normalizeText,
  CLASSIFIER_VERSION,
  ANALYSIS_VERSION,
  cleanCorruptedText,
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
    llm: { lead_type: 'business', confidence: 0.4, reason: 'unclear', evidence: 'Send me the deposit details' },
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

// ── Analyser v3: roles, openers, stages ──────────────────────────────────────
const VENDOR_CHAT = 'Google review of the whole website is clear. Ads are now on. 40 of above products added.';

test('versions were bumped so every existing contact is re-checked', () => {
  assert.equal(ANALYSIS_VERSION, 3);
  assert.equal(CLASSIFIER_VERSION, 2);
});

test('a confident vendor verdict is stored as vendor and kept out of the pipeline', () => {
  const d = decideClassification({
    llm: { lead_type: 'vendor', confidence: 0.85, reason: 'Agency running the owner ads', evidence: 'Ads are now on' },
    transcriptText: VENDOR_CHAT,
  });
  assert.equal(d.leadType, 'vendor');
  assert.equal(d.isBusinessChat, false);
});

test('staff verdicts are stored as staff and are not business chats', () => {
  const d = decideClassification({
    llm: { lead_type: 'staff', confidence: 0.8, reason: 'Welder being vetted for hire', evidence: 'Ads are now on' },
    transcriptText: VENDOR_CHAT,
  });
  assert.equal(d.leadType, 'staff');
  assert.equal(d.isBusinessChat, false);
});

test('the model label "customer" (and legacy "business") both mean business', () => {
  const llm = { confidence: 0.8, reason: 'asks the price of a sink', evidence: 'Ads are now on' };
  assert.equal(decideClassification({ llm: { ...llm, lead_type: 'customer' }, transcriptText: VENDOR_CHAT }).leadType, 'business');
  assert.equal(decideClassification({ llm: { ...llm, lead_type: 'business' }, transcriptText: VENDOR_CHAT }).leadType, 'business');
});

test('a one-line product enquiry at 0.5 confidence is kept as a customer', () => {
  const d = decideClassification({
    llm: { lead_type: 'customer', confidence: 0.5, reason: 'asks about a shawarma machine', evidence: 'Shawarma machine please' },
    transcriptText: 'Shawarma machine please',
  });
  assert.equal(d.leadType, 'business');
});

test('exclusions keep the higher bar: a 0.6 vendor/personal verdict stays unknown', () => {
  const llm = { confidence: 0.6, reason: 'x', evidence: 'Ads are now on' };
  assert.equal(decideClassification({ llm: { ...llm, lead_type: 'vendor' }, transcriptText: VENDOR_CHAT }).leadType, 'unknown');
  assert.equal(decideClassification({ llm: { ...llm, lead_type: 'personal' }, transcriptText: VENDOR_CHAT }).leadType, 'unknown');
});

test('an unknown label is never guessed into a bucket', () => {
  assert.equal(decideClassification({ llm: { lead_type: 'supplier-ish', confidence: 0.9, evidence: 'Ads are now on' }, transcriptText: VENDOR_CHAT }).leadType, 'unknown');
});

const OPENER = 'I have A project I would like you to work on. Can I get more info?';
const firsts = [...Array(6).fill(OPENER), 'Hello', 'Hi', 'Sink price?', OPENER.toUpperCase()];

test('openers: text many contacts opened with word for word is detected, greetings are not', () => {
  const t = findOpenerTemplates(firsts);
  assert.equal(t.size, 1);
  assert.ok(t.has(normalizeText(OPENER)));
  assert.equal(t.has('hello'), false);
});

test('openers: a text only a few contacts used is not a template', () => {
  assert.equal(findOpenerTemplates([OPENER, OPENER, OPENER, OPENER]).size, 0);
});

test('openers: isOpenerOnly is true only when everything typed is the opener', () => {
  const t = findOpenerTemplates(firsts);
  assert.equal(isOpenerOnly([OPENER, OPENER], t), true);
  assert.equal(isOpenerOnly([OPENER, 'Tomorrow at 9am'], t), false);
  assert.equal(isOpenerOnly([], t), false);
  assert.equal(isOpenerOnly([OPENER], new Map()), false);
});

test('openers: an opener-only chat is always browsing / quality 3, whatever the model said', () => {
  const t = findOpenerTemplates(firsts);
  for (const raw of [
    { intent: 'buying', quality_score: 8, intent_evidence: OPENER },
    { intent: 'unknown', quality_score: 2, intent_evidence: null },
    { intent: 'price_check', quality_score: 7, intent_evidence: OPENER },
  ]) {
    const { nlp, flags } = normalizeNlp(raw, { customerText: OPENER, customerMessages: [OPENER], openerTemplates: t });
    assert.equal(nlp.intent, 'browsing');
    assert.equal(nlp.quality_score, 3);
    assert.ok(nlp.intent_evidence.startsWith('I have A project'));
    assert.ok(flags.includes('opener_only'));
  }
});

test('openers: a customer who typed more after the opener is judged on the model answer', () => {
  const t = findOpenerTemplates(firsts);
  const text = `${OPENER}\nI want like this banner. Pin P051106414K`;
  const { nlp, flags } = normalizeNlp(
    { intent: 'buying', quality_score: 8, intent_evidence: 'I want like this banner' },
    { customerText: text, customerMessages: [OPENER, 'I want like this banner.', 'Pin P051106414K'], openerTemplates: t }
  );
  assert.equal(nlp.intent, 'buying');
  assert.equal(nlp.quality_score, 8);
  assert.equal(flags.includes('opener_only'), false);
});

test('openers: evidence that is just the opener is flagged when more was said', () => {
  const t = findOpenerTemplates(firsts);
  const { flags } = normalizeNlp(
    { intent: 'buying', quality_score: 7, intent_evidence: OPENER },
    { customerText: `${OPENER}\nTomorrow at 9am`, customerMessages: [OPENER, 'Tomorrow at 9am'], openerTemplates: t }
  );
  assert.ok(flags.includes('evidence_is_opener'));
});

test('stage: free text is mapped to the closed list, "Closing" is not Closed', () => {
  const run = (conv_stage, extra = {}) => normalizeNlp({ intent: 'browsing', quality_score: 3, conv_stage, ...extra }, { customerText: CHAT }).nlp.conv_stage;
  assert.equal(run('closed'), 'Closed');
  assert.equal(run('Product interest'), 'Product interest');
  assert.equal(run('Closing'), 'Negotiation');
  assert.equal(run('Totally made up'), null);
  assert.equal(run(undefined), null);
});

test('stage: a support chat (already ordered or paid) is Closed, not Negotiation', () => {
  const { nlp, flags } = normalizeNlp(
    { intent: 'support', quality_score: 6, intent_evidence: 'Please naomba tumalizie Leo', conv_stage: 'Negotiation' },
    { customerText: 'Please naomba tumalizie Leo' }
  );
  assert.equal(nlp.conv_stage, 'Closed');
  assert.ok(flags.includes('support_stage_closed'));
});

test('relationship: a quoted vendor verdict is accepted and flagged', () => {
  const { nlp, flags } = normalizeNlp(
    { relationship_check: 'vendor', relationship_evidence: 'Ads are now on', intent: 'buying', quality_score: 8, intent_evidence: 'Ads are now on' },
    { customerText: VENDOR_CHAT, fullText: VENDOR_CHAT }
  );
  assert.equal(nlp.relationship_check, 'vendor');
  assert.ok(flags.includes('not_a_customer'));
});

test('relationship: a vendor verdict with an invented quote is ignored', () => {
  const { nlp, flags } = normalizeNlp(
    { relationship_check: 'vendor', relationship_evidence: 'completely made up line about invoices', intent: 'price_check', quality_score: 6, intent_evidence: 'Ads are now on' },
    { customerText: VENDOR_CHAT, fullText: VENDOR_CHAT }
  );
  assert.equal(nlp.relationship_check, 'customer');
  assert.ok(flags.includes('relationship_unsupported'));
});

test('relationship: a missing or odd value means customer', () => {
  assert.equal(normalizeNlp({ intent: 'browsing', quality_score: 3 }, { customerText: CHAT }).nlp.relationship_check, 'customer');
  assert.equal(normalizeNlp({ relationship_check: 'bank', intent: 'browsing', quality_score: 3 }, { customerText: CHAT }).nlp.relationship_check, 'customer');
});

test('lead quality: a support customer is never hot, a closed sale stays out of the hot list', () => {
  assert.equal(resolveLeadQuality({ leadType: 'business', leadState: 'engaged', aiQuality: 8, aiIntent: 'support' }), 'warm');
  assert.equal(resolveLeadQuality({ leadType: 'vendor', leadState: 'engaged', aiQuality: 8, aiIntent: 'buying' }), null);
  assert.equal(resolveFollowUpUrgency({ leadType: 'staff', awaiting: true }), null);
});


// ── Found in the VVStudios results ───────────────────────────────────────────
test('silent chat: a customer verdict at 0.5-0.64 is NOT kept when the other person never wrote', () => {
  const llm = { lead_type: 'customer', confidence: 0.6, reason: 'owner sent a number', evidence: 'Ads are now on' };
  assert.equal(decideClassification({ llm, transcriptText: VENDOR_CHAT, otherPersonSilent: true }).leadType, 'unknown');
  assert.equal(decideClassification({ llm, transcriptText: VENDOR_CHAT, otherPersonSilent: false }).leadType, 'business');
});

test('silent chat: a clear owner pitch at 0.7 is still a customer (prospect)', () => {
  const llm = { lead_type: 'customer', confidence: 0.7, reason: 'owner pitches marketing services', evidence: 'Ads are now on' };
  assert.equal(decideClassification({ llm, transcriptText: VENDOR_CHAT, otherPersonSilent: true }).leadType, 'business');
});

test('corrupted emoji text is replaced so a real reply is not read as spam', () => {
  assert.equal(cleanCorruptedText('Okay ?f\uFFFD\uFFFD'), 'Okay [emoji]');
  assert.equal(cleanCorruptedText('?f\uFFFD\uFFFD?f\uFFFD?'), '[emoji]');
  assert.equal(cleanCorruptedText('Hello, normal text 👍'), 'Hello, normal text 👍');
  assert.equal(cleanCorruptedText(null), '');
});
