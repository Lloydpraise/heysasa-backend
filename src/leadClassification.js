export function resolveLeadClassification(nlp = {}, existingLeadType = null) {
  const normalizedNlp = nlp || {};
  const normalizedExisting = typeof existingLeadType === 'string' ? existingLeadType.trim().toLowerCase() : '';
  const rawLeadType = typeof normalizedNlp.lead_type === 'string' ? normalizedNlp.lead_type.trim().toLowerCase() : '';
  const isBusinessChat = normalizedNlp.is_business_chat === true || rawLeadType === 'business';
  const isPersonalChat = normalizedNlp.is_business_chat === false || rawLeadType === 'personal';

  if (normalizedExisting === 'personal') {
    return {
      leadType: 'personal',
      isBusinessChat: false,
      qualityScore: Number.isFinite(normalizedNlp.quality_score) ? Number(normalizedNlp.quality_score) : 1,
      decision: 'manual_personal',
    };
  }

  if (isPersonalChat) {
    return {
      leadType: 'personal',
      isBusinessChat: false,
      qualityScore: Number.isFinite(normalizedNlp.quality_score) ? Number(normalizedNlp.quality_score) : 1,
      decision: 'nlp_personal',
    };
  }

  if (isBusinessChat || normalizedExisting === 'business' || normalizedExisting === 'pending_analysis' || normalizedExisting === 'pending' || normalizedExisting === 'junk') {
    const strongBusinessSignal = isBusinessChat || rawLeadType === 'business';
    const qualityScore = Number.isFinite(normalizedNlp.quality_score)
      ? Number(normalizedNlp.quality_score)
      : (strongBusinessSignal ? 5 : 1);
    const leadType = strongBusinessSignal || qualityScore >= 3 ? 'business' : 'junk';

    return {
      leadType,
      isBusinessChat: leadType === 'business',
      qualityScore,
      decision: leadType === 'business' ? 'nlp_business' : 'nlp_junk',
    };
  }

  return {
    leadType: normalizedExisting || 'business',
    isBusinessChat: normalizedExisting !== 'junk' && normalizedExisting !== 'personal',
    qualityScore: Number.isFinite(normalizedNlp.quality_score) ? Number(normalizedNlp.quality_score) : 1,
    decision: 'preserve_existing',
  };
}


// ─────────────────────────────────────────────────────────────────────────────
// Analyser v2: separation, verification and single-owner scoring rules.
// Everything below is pure (no DB / network) so it can be unit-tested.
// ─────────────────────────────────────────────────────────────────────────────

// Bump when the analysis prompt/rules change. Contacts analysed under an older
// version are re-analysed on the next run and their old scores are ignored.
export const ANALYSIS_VERSION = 2;

// Below this the classifier's answer is not trusted and the contact stays
// 'unknown' (excluded from scoring) instead of being guessed into a bucket.
export const CONFIDENCE_FLOOR = 0.65;

const CLASS_TYPES = ['business', 'personal', 'junk'];
const INTENTS = ['buying', 'browsing', 'support', 'price_check', 'referral', 'unknown'];
const URGENCIES = ['hot', 'warm', 'cold'];
const COMMERCIAL_INTENTS = ['buying', 'price_check'];
const CLOSED_STATES = ['won', 'lost', 'do_not_contact'];

const lower = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function tokens(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

// True when (almost) every word of `evidence` really appears in `sourceText`.
// Used to catch quotes the model made up or translated instead of copied.
export function evidenceSupported(evidence, sourceText) {
  const ev = tokens(evidence);
  if (ev.length < 2) return false;
  const pool = new Set(tokens(sourceText));
  const hits = ev.filter((t) => pool.has(t)).length;
  return hits / ev.length >= 0.7;
}

function classification(leadType, source, confidence, reason, needsReview = false) {
  return {
    leadType,
    isBusinessChat: leadType === 'business' ? true : leadType === 'unknown' ? null : false,
    source,
    confidence: Math.round(confidence * 100) / 100,
    reason: String(reason || '').trim(),
    needsReview,
  };
}

// Step 0 decision: business / personal / junk / unknown for one contact.
export function decideClassification({
  isAdLead = false,
  hasAdReferral = false,
  leadState = null,
  llm = null,
  transcriptText = '',
} = {}) {
  if (hasAdReferral || isAdLead) {
    return classification('business', 'ad', 1, 'Arrived through a click-to-WhatsApp ad');
  }
  if (leadState === 'won' || leadState === 'lost') {
    return classification('business', 'state', 1, `Lead state is ${leadState}`);
  }
  if (!llm) return classification('unknown', 'llm', 0, 'No classifier output', true);

  const type = lower(llm.lead_type);
  let confidence = Number(llm.confidence);
  confidence = Number.isFinite(confidence) ? clamp(confidence, 0, 1) : 0;
  const reason = llm.reason || '';

  if (!CLASS_TYPES.includes(type)) {
    return classification('unknown', 'llm', 0, `Unrecognised label "${llm.lead_type}"`, true);
  }

  // The model has to point at something in the chat. Made-up evidence and
  // missing evidence both lower trust.
  if (!llm.evidence) confidence = Math.max(0, confidence - 0.1);
  else if (!evidenceSupported(llm.evidence, transcriptText)) confidence = Math.max(0, confidence - 0.2);

  if (confidence < CONFIDENCE_FLOOR) {
    return classification('unknown', 'llm', confidence, `Low confidence (${type}): ${reason}`, true);
  }
  return classification(type, 'llm', confidence, reason);
}

// Cleans the model's analysis and enforces internal consistency, so a claim
// with nothing behind it cannot inflate quality or urgency.
export function normalizeNlp(raw, { customerText = '' } = {}) {
  const n = { ...(raw || {}) };
  const flags = [];

  n.intent = INTENTS.includes(lower(n.intent)) ? lower(n.intent) : 'unknown';
  n.follow_up_urgency = URGENCIES.includes(lower(n.follow_up_urgency)) ? lower(n.follow_up_urgency) : 'cold';

  let quality = Math.round(Number(n.quality_score));
  if (!Number.isFinite(quality)) quality = 1;
  quality = clamp(quality, 1, 10);

  const sentiment = Number(n.sentiment_score);
  n.sentiment_score = Number.isFinite(sentiment) ? clamp(sentiment, -1, 1) : null;

  for (const key of ['competitor_mentions', 'objection_tags', 'pre_purchase_questions', 'product_tags', 'matched_products']) {
    if (!Array.isArray(n[key])) n[key] = [];
  }
  n.price_objection = n.price_objection === true;

  const evidenceOk = evidenceSupported(n.intent_evidence, customerText);
  n.intent_evidence = evidenceOk ? String(n.intent_evidence).trim().slice(0, 240) : null;

  if (!evidenceOk && COMMERCIAL_INTENTS.includes(n.intent)) {
    flags.push('intent_downgraded_no_evidence');
    n.intent = 'unknown';
  }
  if (!evidenceOk && quality >= 5) {
    flags.push('quality_capped_no_evidence');
    quality = 4;
  }
  if (n.intent === 'unknown' && quality > 3) {
    flags.push('quality_capped_unknown_intent');
    quality = 3;
  }

  n.quality_score = quality;
  return { nlp: n, flags };
}

// The ONE place lead_quality is decided. Only confirmed business contacts get
// one, and 'hot' needs real commercial intent from the analysis.
export function resolveLeadQuality({ leadType, leadState, intentScore, aiQuality, aiIntent } = {}) {
  if (leadType !== 'business') return null;
  if (leadState === 'won') return 'hot';
  if (leadState === 'lost' || leadState === 'do_not_contact') return 'cold';

  let quality;
  if (Number.isFinite(aiQuality)) {
    quality = aiQuality >= 7 ? 'hot' : aiQuality >= 4 ? 'warm' : 'cold';
    if (quality === 'hot' && !COMMERCIAL_INTENTS.includes(aiIntent)) quality = 'warm';
  } else {
    // No content analysis yet: behaviour alone can never make a lead hot.
    quality = Number.isFinite(intentScore) && intentScore >= 40 ? 'warm' : 'cold';
  }
  if (leadState === 'ghosted' && quality === 'hot') quality = 'warm';
  return quality;
}

// The ONE place follow_up_urgency is decided ("who needs a reply now").
export function resolveFollowUpUrgency({
  leadType,
  leadState,
  aiUrgency,
  aiQuality,
  aiIntent,
  awaiting = false,
  daysSinceLastInbound = null,
} = {}) {
  if (leadType !== 'business') return null;
  if (CLOSED_STATES.includes(leadState)) return 'cold';

  const analysed = Number.isFinite(aiQuality);
  const strong = COMMERCIAL_INTENTS.includes(aiIntent) || (analysed && aiQuality >= 6);
  const noSignal = analysed && aiQuality <= 2 && (!aiIntent || aiIntent === 'unknown');
  if (noSignal) return 'cold';

  const days = Number.isFinite(daysSinceLastInbound) ? daysSinceLastInbound : null;
  if (awaiting) {
    if (days !== null && days > 7) return strong ? 'warm' : 'cold';
    return strong ? 'hot' : 'warm';
  }
  if (leadState === 'ghosted') return 'cold';
  const ai = URGENCIES.includes(aiUrgency) ? aiUrgency : 'cold';
  return ai === 'hot' ? 'warm' : ai; // hot needs a customer actually waiting on us
}


// ─────────────────────────────────────────────────────────────────────────────
// Failure handling shared by the analyser and the persona pack generator.
// A bad chat is skipped. A systemic problem (bad key, no quota, DB or network
// down) stops the run instead of grinding through every remaining item.
// ─────────────────────────────────────────────────────────────────────────────

// Throw this to abort the whole run. Per-item catch blocks must rethrow it.
export class FatalRunError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FatalRunError';
  }
}

export const BREAKER = {
  maxConsecutive: 10,        // this many failures in a row = systemic
  sampleSize: 30,            // judge the failure rate on the first N attempted items
  maxSampleFailureRate: 0.3, // more than this in that sample = systemic
};

// A run is only trusted downstream ("healthy") if it had almost no item errors.
export const HEALTHY_ERROR_RATE = 0.05;
export const HEALTHY_MIN_ALLOWED_ERRORS = 3;

export function isHealthyRun(totalErrors, attempted) {
  const allowed = Math.max(HEALTHY_MIN_ALLOWED_ERRORS, Math.ceil(attempted * HEALTHY_ERROR_RATE));
  return totalErrors <= allowed;
}

export class FailureGuard {
  constructor(label, limits = BREAKER) {
    this.label = label;
    this.limits = limits;
    this.attempted = 0;
    this.failed = 0;
    this.consecutive = 0;
    this.lastError = '';
  }

  ok() {
    this.attempted++;
    this.consecutive = 0;
    this.#checkSample();
  }

  fail(message) {
    this.attempted++;
    this.failed++;
    this.consecutive++;
    this.lastError = String(message || 'unknown error');
    if (this.consecutive >= this.limits.maxConsecutive) {
      throw new FatalRunError(
        `${this.label}: stopped after ${this.consecutive} failures in a row (last error: ${this.lastError}). ` +
        'This looks systemic (API key, quota, network or database), not a single bad chat.'
      );
    }
    this.#checkSample();
  }

  #checkSample() {
    if (this.attempted !== this.limits.sampleSize) return;
    const rate = this.failed / this.attempted;
    if (rate > this.limits.maxSampleFailureRate) {
      throw new FatalRunError(
        `${this.label}: ${this.failed} of the first ${this.attempted} items failed (${Math.round(rate * 100)}%). ` +
        `Last error: ${this.lastError}. Stopping instead of processing the rest.`
      );
    }
  }
}