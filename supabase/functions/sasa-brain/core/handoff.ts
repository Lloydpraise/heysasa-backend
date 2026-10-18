// Who is told when a chat is handed over, and for which case. Twin of src/handoff/config.js on the backend: keep the
// two in step. Pure: no database. Settings live in businesses.chat_ai_settings.handoff.

export type Recipient = { id: string; name: string; phone: string };
export type HandoffRule = { id: string; label: string; when: string; to: string[]; urgency: 'low' | 'normal' | 'high' };
export type HandoffConfig = { recipients: Recipient[]; rules: HandoffRule[]; default_to: string[]; alert_whatsapp: boolean };
export type Notify = { name: string; phone: string };

const OWNER = 'owner';
const URGENCIES = ['low', 'normal', 'high'];
const text = (v: unknown, n: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const slug = (v: unknown, fallback: string) => (String(v ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '').slice(0, 24) || fallback);

// 07XX, 01XX, +254..., 254..., or the nine digits: all become 254XXXXXXXXX. Anything else is null.
export function normalizeKenyanPhone(input: unknown): string | null {
  if (!input) return null;
  const stripped = String(input).replace(/[^\d+]/g, '').replace(/^\+/, '');
  let national: string;
  if (stripped.startsWith('254') && stripped.length === 12) national = stripped.slice(3);
  else if (stripped.startsWith('0') && stripped.length === 10) national = stripped.slice(1);
  else if (stripped.length === 9) national = stripped;
  else return null;
  return /^[71]\d{8}$/.test(national) ? `254${national}` : null;
}

// deno-lint-ignore no-explicit-any
export function readHandoffConfig(raw: any): HandoffConfig {
  const input = raw && typeof raw === 'object' ? raw : {};
  const recipients: Recipient[] = [];
  const seen = new Set<string>();
  for (const r of Array.isArray(input.recipients) ? input.recipients.slice(0, 10) : []) {
    const name = text(r?.name, 60);
    const phone = normalizeKenyanPhone(r?.phone);
    if (!name || !phone) continue;
    let id = slug(r?.id, `p${recipients.length + 1}`);
    while (seen.has(id) || id === OWNER) id = `${id}x`;
    seen.add(id);
    recipients.push({ id, name, phone });
  }
  const known = new Set([OWNER, ...recipients.map((r) => r.id)]);
  const cleanTo = (list: unknown) => [...new Set((Array.isArray(list) ? list : []).map(String).filter((id) => known.has(id)))];
  const rules: HandoffRule[] = [];
  const ruleIds = new Set<string>();
  for (const r of Array.isArray(input.rules) ? input.rules.slice(0, 20) : []) {
    const label = text(r?.label, 60);
    const when = text(r?.when, 300);
    if (!when) continue;
    let id = slug(r?.id, `r${rules.length + 1}`);
    while (ruleIds.has(id)) id = `${id}x`;
    ruleIds.add(id);
    rules.push({ id, label: label || when.slice(0, 40), when, to: cleanTo(r?.to), urgency: URGENCIES.includes(r?.urgency) ? r.urgency : 'normal' });
  }
  const defaultTo = cleanTo(input.default_to);
  return { recipients, rules, default_to: defaultTo.length ? defaultTo : [OWNER], alert_whatsapp: input.alert_whatsapp !== false };
}

// What the chat AI is told about handoffs. '' when the owner added no cases.
export function renderHandoffRules(config: HandoffConfig): string {
  if (!config.rules.length) return '';
  const names = (to: string[]) => (to.length ? to : config.default_to)
    .map((id) => (id === OWNER ? 'the owner' : config.recipients.find((r) => r.id === id)?.name)).filter(Boolean).join(' and ');
  const lines = config.rules.map((r) => `- ${r.label}: ${r.when}. Hand off with rule_id "${r.id}" (${names(r.to)} will be told${r.urgency === 'high' ? ', urgent' : ''}).`);
  return `HANDOFF CASES (set by the owner)\nWhen a case below matches, call handoff with its rule_id so the right person is told. Any other handoff goes to ${names([])}.\n${lines.join('\n')}`;
}

export function resolveRecipients(config: HandoffConfig, ruleId: string | null | undefined, ownerPhone: unknown): { recipients: Notify[]; rule: HandoffRule | null } {
  const rule = ruleId ? config.rules.find((r) => r.id === ruleId) ?? null : null;
  const ids = rule?.to?.length ? rule.to : config.default_to;
  const owner = normalizeKenyanPhone(ownerPhone);
  const out: Notify[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const person = id === OWNER ? (owner ? { name: 'Owner', phone: owner } : null) : config.recipients.find((r) => r.id === id);
    if (person && !seen.has(person.phone)) { seen.add(person.phone); out.push({ name: person.name, phone: person.phone }); }
  }
  return { recipients: out, rule };
}
