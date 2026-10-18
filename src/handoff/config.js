// Handoff settings: WHO gets told, and for WHICH cases. Pure: no database.
//
// Stored in businesses.chat_ai_settings.handoff:
//   {
//     recipients: [{ id, name, phone }],                 people besides the owner who can be told
//     rules:      [{ id, label, when, to: [...], urgency }],   "when this happens, tell these people"
//     default_to: ['owner'],                             who is told when no rule matches (the owner, unless changed)
//     alert_whatsapp: true                               send the WhatsApp message (Home always shows the handoff)
//   }
// `to` holds the word 'owner' (the business's alerts number) and/or recipient ids.
//
// supabase/functions/sasa-brain/core/handoff.ts has the same rules for the chat AI; keep the two in step.

import { normalizeKenyanPhone } from '../utils/phone.js';

export const MAX_RECIPIENTS = 10;
export const MAX_RULES = 20;
export const OWNER = 'owner';
export const URGENCIES = ['low', 'normal', 'high'];

// Cases offered as one-tap starting points in the dashboard.
export const SUGGESTED_CASES = [
    { label: 'Customer asks for a call', when: 'The customer asks for a call or to talk to someone' },
    { label: 'Ready to pay', when: 'The customer says they are ready to pay or have paid' },
    { label: 'Refund or complaint', when: 'The customer wants a refund, is upset or complains' },
    { label: 'Price the AI does not have', when: 'The customer asks for a price or discount the AI cannot give' },
    { label: 'Custom or bulk order', when: 'The customer wants something custom, or a bulk or wholesale order' },
];

const text = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const slug = (v, fallback) => (String(v ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '').slice(0, 24) || fallback);

export const DEFAULT_CONFIG = Object.freeze({ recipients: [], rules: [], default_to: [OWNER], alert_whatsapp: true });

// Cleans whatever came in. Returns { config, errors }: bad entries are dropped and named in `errors`, never saved.
export function normalizeHandoffConfig(raw) {
    const errors = [];
    const input = raw && typeof raw === 'object' ? raw : {};

    const recipients = [];
    const seenIds = new Set();
    for (const r of Array.isArray(input.recipients) ? input.recipients.slice(0, MAX_RECIPIENTS) : []) {
        const name = text(r?.name, 60);
        const phone = normalizeKenyanPhone(r?.phone);
        if (!name) { errors.push('A person needs a name.'); continue; }
        if (!phone) { errors.push(`"${name}" does not have a valid phone number.`); continue; }
        let id = slug(r?.id, `p${recipients.length + 1}`);
        while (seenIds.has(id) || id === OWNER) id = `${id}x`;
        seenIds.add(id);
        recipients.push({ id, name, phone });
    }

    const known = new Set([OWNER, ...recipients.map((r) => r.id)]);
    const cleanTo = (list) => [...new Set((Array.isArray(list) ? list : []).map(String).filter((id) => known.has(id)))];

    const rules = [];
    const ruleIds = new Set();
    for (const r of Array.isArray(input.rules) ? input.rules.slice(0, MAX_RULES) : []) {
        const label = text(r?.label, 60);
        const when = text(r?.when, 300);
        if (!label && !when) continue;
        if (!when) { errors.push(`"${label}" needs a description of when it applies.`); continue; }
        let id = slug(r?.id, `r${rules.length + 1}`);
        while (ruleIds.has(id)) id = `${id}x`;
        ruleIds.add(id);
        rules.push({ id, label: label || when.slice(0, 40), when, to: cleanTo(r?.to), urgency: URGENCIES.includes(r?.urgency) ? r.urgency : 'normal' });
    }

    const defaultTo = cleanTo(input.default_to);
    return {
        config: { recipients, rules, default_to: defaultTo.length ? defaultTo : [OWNER], alert_whatsapp: input.alert_whatsapp !== false },
        errors,
    };
}

// What the chat AI is told about handoffs, in plain words. '' when the owner set nothing beyond the default.
export function renderHandoffRules(config, ownerLabel = 'the owner') {
    const { config: c } = normalizeHandoffConfig(config);
    if (!c.rules.length) return '';
    const names = (to) => (to.length ? to : c.default_to).map((id) => (id === OWNER ? ownerLabel : c.recipients.find((r) => r.id === id)?.name)).filter(Boolean).join(' and ');
    return c.rules.map((r) => `- ${r.label}: ${r.when}. Hand off with rule_id "${r.id}" (${names(r.to)} will be told${r.urgency === 'high' ? ', urgent' : ''}).`).join('\n');
}

// Who must be told for a handoff. ruleId may be missing or unknown, in which case the default people are told.
// -> { recipients: [{ name, phone }], rule: { id, label, urgency } | null }. People without a number are left out.
export function resolveRecipients(rawConfig, ruleId, ownerPhone) {
    const { config } = normalizeHandoffConfig(rawConfig);
    const rule = ruleId ? config.rules.find((r) => r.id === ruleId) ?? null : null;
    const ids = rule?.to?.length ? rule.to : config.default_to;
    const owner = normalizeKenyanPhone(ownerPhone);
    const out = [];
    const seen = new Set();
    for (const id of ids) {
        const person = id === OWNER ? (owner ? { name: 'Owner', phone: owner } : null) : config.recipients.find((r) => r.id === id);
        if (person && !seen.has(person.phone)) { seen.add(person.phone); out.push({ name: person.name, phone: person.phone }); }
    }
    return { recipients: out, rule: rule ? { id: rule.id, label: rule.label, urgency: rule.urgency } : null };
}
