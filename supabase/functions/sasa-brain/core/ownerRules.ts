// What the owner told HeySasa during setup (opening hours, when to hand a customer over), written as plain rules the
// chat AI reads. Pure: no database. Anything that is missing or malformed is simply left out.

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const HANDOFF_TEXT: Record<string, string> = {
  asks_for_call: 'the customer asks for a call',
  ready_to_pay: 'the customer is ready to pay',
  asks_unknown_price: 'the customer asks for a price you do not have',
  angry_or_upset: 'the customer sounds upset',
  asks_for_human: 'the customer asks for a real person',
};

function daysText(days: number[]): string {
  const d = [...new Set(days)].sort((a, b) => a - b);
  const consecutive = d.every((v, i) => i === 0 || v === d[i - 1] + 1);
  return d.length > 2 && consecutive ? `${DAY[d[0]]} to ${DAY[d[d.length - 1]]}` : d.map((x) => DAY[x]).join(', ');
}

export function renderOwnerRules(raw: Record<string, unknown> | null | undefined): string {
  const s = raw ?? {};
  const lines: string[] = [];

  const hours = s.business_hours as { open?: unknown; close?: unknown; days?: unknown } | undefined;
  if (hours && typeof hours.open === 'string' && typeof hours.close === 'string' && TIME.test(hours.open) && TIME.test(hours.close)) {
    const days = Array.isArray(hours.days) ? (hours.days as unknown[]).filter((x): x is number => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 6) : [];
    lines.push(`- The business is open ${days.length ? `${daysText(days)}, ` : ''}${hours.open} to ${hours.close}. Outside these hours you can still help, and you can say the owner will be back when they open. Never promise a call or a delivery outside these hours.`);
  }

  const reasons = Array.isArray(s.handoff_reasons) ? (s.handoff_reasons as unknown[]).filter((r): r is string => typeof r === 'string' && r in HANDOFF_TEXT) : [];
  if (reasons.length) {
    lines.push(`- Hand the customer to the owner with the handoff tool when: ${[...new Set(reasons)].map((r) => HANDOFF_TEXT[r]).join('; ')}.`);
  }

  return lines.length ? `OWNER RULES (set by the owner, always follow them)\n${lines.join('\n')}` : '';
}
