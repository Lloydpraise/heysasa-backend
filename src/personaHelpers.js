// Pure helpers for the persona pack generator. No DB, no network, so they can be unit-tested.

// Lowercase letters+digits only, so "M-Pesa", "m pesa" and "MPESA" all compare equal.
export const squash = (text) => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

// Personal identifiers must never reach a prompt or a saved pack.
export function redact(text) {
  return String(text || '')
    .replace(/\b[AP]\d{9}[A-Z]\b/gi, '[pin]')                                   // KRA PIN
    .replace(/(?:\+?254|\b0)[\s-]?[17]\d{2}[\s-]?\d{3}[\s-]?\d{3}\b/g, '[phone]') // Kenyan mobile numbers
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{10}\b/g, '[code]')      // M-Pesa style receipt codes
    .replace(/\b\d{9,}\b/g, '[number]');                                          // account / id numbers
}

export const wordCount = (text) => String(text || '').trim().split(/\s+/).filter(Boolean).length;

const AMOUNT_ONLY = /^[^\p{L}\p{N}]*(?:ksh|kes|sh)?\s*[\d.,]+\s*(?:k|m|ksh|kes|\/=|bob)?[^\p{L}\p{N}]*$/iu;

// Messages that carry no style information about how the owner talks to a customer.
export function isLowValueVoiceMessage(text, minWords = 3) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (AMOUNT_ONLY.test(t)) return true;                    // "135k", "Pay 300" style lines are handled by word count; bare amounts here
  if (/^\[(?:pin|phone|email|code|number)\]$/i.test(t)) return true;
  return wordCount(t) < minWords;
}

// One long chat must not become "the owner's voice". Keeps an even spread within each conversation.
export function capPerConversation(messages, max, evenSample) {
  const byConv = new Map();
  for (const m of messages) {
    const key = m.conversation_id || m.contact_id || 'none';
    if (!byConv.has(key)) byConv.set(key, []);
    byConv.get(key).push(m);
  }
  const keep = new Set();
  for (const list of byConv.values()) for (const m of evenSample(list, max)) keep.add(m);
  return messages.filter(m => keep.has(m));
}

// How many separate messages contain the phrase. A "signature phrase" has to be a real habit.
export function phraseSupport(phrase, texts) {
  const q = squash(phrase);
  if (q.length < 3) return 0;
  let n = 0;
  for (const t of texts) if (squash(t).includes(q)) n++;
  return n;
}

const OBJECTION_TYPES = ['price', 'not_ready', 'found_elsewhere', 'trust_concerns', 'size_availability', 'delivery', 'payment_terms'];

// Keeps only playbook entries whose customer words really came from a CUSTOMER line and whose
// owner reply really came from an OWNER line. This is what stops the owner's own buying chats,
// or a customer's sentence, from being shipped as "how to reply".
export function validateObjectionEntries(entries, { customerCorpus, ownerCorpus }) {
  const kept = [], dropped = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    const objection = String(e?.objection || '').trim();
    const reply = String(e?.owner_reply || '').trim();
    const reasons = [];
    if (squash(objection).length < 6 || !customerCorpus.includes(squash(objection))) reasons.push('objection_not_from_customer');
    if (squash(reply).length < 3 || !ownerCorpus.includes(squash(reply))) reasons.push('reply_not_from_owner');
    if (reasons.length === 0 && ownerCorpus.includes(squash(objection)) && !customerCorpus.includes(squash(objection))) reasons.push('objection_is_owner_text');
    if (!String(e?.suggested_language || '').trim()) reasons.push('no_suggested_language');
    if (reasons.length) { dropped.push({ objection, reasons }); continue; }
    kept.push({
      objection_type: OBJECTION_TYPES.includes(e.objection_type) ? e.objection_type : 'price',
      objection,
      owner_reply: reply,
      response_strategy: String(e.response_strategy || '').trim(),
      suggested_language: redact(String(e.suggested_language).trim()),
      escalation_if_repeated: String(e.escalation_if_repeated || '').trim()
    });
  }
  return { kept, dropped };
}

// Closing / handoff triggers are short generalised phrases: no numbers, no identifiers, no sentences.
export function cleanTriggers(list, max = 8) {
  const seen = new Set(), out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const t = redact(String(raw || '').trim());
    if (!t || t.includes('[') || /\d{3,}/.test(t) || wordCount(t) > 10) continue;
    const key = squash(t);
    if (key.length < 3 || seen.has(key)) continue;
    seen.add(key); out.push(t);
    if (out.length >= max) break;
  }
  return out;
}
