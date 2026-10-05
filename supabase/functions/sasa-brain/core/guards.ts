// Checks every reply before the customer sees it. Pure functions.

export const NO_REPLY = '<no_reply>';
export const MAX_REPLY_CHARS = 700;

// The "how can I assist you today" family. The AI is a sales rep, not an assistant.
const HELPFUL_PHRASES: RegExp[] = [
  /how (can|may|could|should) i (help|assist)/i,
  /how may i be of (service|assistance)/i,
  /\bi('| a)?m here to (help|assist)/i,
  /\bhappy to (help|assist)/i,
  /\bassist you\b/i,
  /feel free to (ask|reach|contact|let)/i,
  /(please )?don'?t hesitate to/i,
  /is there anything else/i,
  /anything else (i can|you('d| would) like)/i,
  /let me know if you (need|have|want) (anything|any )/i,
  /if you have any (other )?questions/i,
  /as an ai( language model)?\b/i,
];

const MARKDOWN_LINE = /^\s*(#{1,6}\s|[-*•]\s|\d+\.\s)/m;

const CURRENCY_BEFORE = /(?:ksh?s?\.?|kes|usd|us\$|\$|tsh|tzs|ugx)\s*([0-9][0-9,]*(?:\.[0-9]+)?)/gi;
const CURRENCY_AFTER = /([0-9][0-9,]*(?:\.[0-9]+)?)\s*(?:\/=|ksh|kes|bob\b|shillings?)/gi;
const ANY_NUMBER = /[0-9][0-9,]*(?:\.[0-9]+)?/g;

const toNumber = (raw: string): number => Number(raw.replace(/,/g, ''));

export function extractPrices(text: string): number[] {
  const found: number[] = [];
  for (const re of [CURRENCY_BEFORE, CURRENCY_AFTER]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const n = toNumber(m[1]);
      if (Number.isFinite(n)) found.push(n);
    }
  }
  return found;
}

export function extractNumbers(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(ANY_NUMBER)) {
    const n = toNumber(m[0]);
    if (Number.isFinite(n)) out.add(n);
  }
  return out;
}

export type ReplyCheck = { ok: boolean; problems: string[] };

// `corpus` is every piece of text the AI was legitimately given this turn: tool results, skills, flow, persona,
// history. A price in the reply that appears nowhere in it was made up.
export function checkReply(text: string, corpus: string): ReplyCheck {
  const problems: string[] = [];
  const reply = String(text ?? '').trim();
  if (!reply) return { ok: false, problems: ['The reply is empty.'] };
  if (reply.length > MAX_REPLY_CHARS) problems.push(`The reply is ${reply.length} characters. Keep it under ${MAX_REPLY_CHARS}, as a short WhatsApp message.`);
  for (const re of HELPFUL_PHRASES) {
    const m = reply.match(re);
    if (m) problems.push(`Remove the assistant-style phrase "${m[0]}". You are a sales rep: answer, then move the sale forward.`);
  }
  if (MARKDOWN_LINE.test(reply)) problems.push('Do not use bullet lists, numbered lists or headings. Write plain WhatsApp sentences.');

  const known = extractNumbers(corpus);
  const unknown = extractPrices(reply).filter((n) => !known.has(n));
  if (unknown.length) problems.push(`The price ${unknown.map((n) => n.toLocaleString('en-US')).join(', ')} did not come from a tool, skill or the conversation. Use only prices you were given, or say you will confirm.`);

  return { ok: problems.length === 0, problems };
}
