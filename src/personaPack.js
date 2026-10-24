// Persona packs per WhatsApp account (ACCOUNTS.md rule 8). Each account generates its own pack (account_id set);
// while an account has none, readers fall back to the business-wide pack (account_id null). The persona screen
// shows `gaps` (key fields still empty) so the owner can answer them; answers are merged into the account's pack.

// The active pack an account (or the business-wide view) uses: { row, pack, source: 'account'|'business'|null }.
export async function loadActivePack(db, businessId, accountId = null, columns = 'id, version, pack, account_id, generated_by, generated_at') {
    if (accountId) {
        const { data, error } = await db.from('persona_packs').select(columns)
            .eq('business_id', businessId).eq('account_id', accountId).eq('is_active', true)
            .order('version', { ascending: false }).limit(1).maybeSingle();
        if (error) throw error;
        if (data) return { row: data, pack: data.pack || {}, source: 'account' };
    }
    const { data, error } = await db.from('persona_packs').select(columns)
        .eq('business_id', businessId).is('account_id', null).eq('is_active', true)
        .order('version', { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    if (data) return { row: data, pack: data.pack || {}, source: 'business' };
    return { row: null, pack: null, source: null };
}

// The fields the chat AI and follow-ups lean on most. Each one the owner can answer in a sentence.
export const PACK_GAPS = [
    { key: 'tone', question: 'How do you talk to customers? (e.g. warm and casual, short and formal, a mix of English and Swahili)', path: ['persona', 'voice_tone'] },
    { key: 'greeting', question: 'How do you usually greet a new customer?', path: ['persona', 'typical_greeting'] },
    { key: 'products', question: 'What do you sell, in a sentence or two?', path: ['business_context', 'core_offer'] },
    { key: 'customers', question: 'Who usually buys from you?', path: ['business_context', 'target_customer'] },
    { key: 'pricing', question: 'How do customers pay, and what do your main items cost?', path: ['business_context', 'payment_methods'] },
    { key: 'delivery', question: 'How does delivery or pick-up work, and what does it cost?', path: ['business_context', 'delivery_info'] },
    { key: 'faqs', question: 'What do customers often hesitate about (price, trust, timing), and how do you answer?', path: ['objection_playbook'] },
    { key: 'handoff', question: 'When should HeySasa stop and call you in?', path: ['human_handoff_triggers'] },
];

const isEmpty = (v) => v == null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length)
    || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);
const dig = (obj, path) => path.reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);

// Which key fields of the pack are empty: [{ key, question }]. A missing pack has every gap.
export function packGaps(pack) {
    return PACK_GAPS.filter((g) => isEmpty(dig(pack || {}, g.path))).map(({ key, question }) => ({ key, question }));
}

const splitList = (text) => String(text).split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean).slice(0, 12);

// Lays the owner's answers ({ tone: '...', products: '...' }) over a copy of the pack. Unknown keys and empty
// answers are ignored. Returns { pack, applied: [keys] }.
export function mergeAnswers(pack, answers) {
    const next = structuredClone(pack && typeof pack === 'object' ? pack : {});
    next.persona = { ...(next.persona || {}) };
    next.business_context = { ...(next.business_context || {}) };
    const applied = [];
    for (const gap of PACK_GAPS) {
        const raw = answers?.[gap.key];
        if (typeof raw !== 'string' || !raw.trim()) continue;
        const text = raw.trim().slice(0, 1000);
        switch (gap.key) {
            case 'tone': next.persona.voice_tone = text; break;
            case 'greeting': next.persona.typical_greeting = text; break;
            case 'products': next.business_context.core_offer = text; break;
            case 'customers': next.business_context.target_customer = text; break;
            case 'pricing': next.business_context.payment_methods = splitList(text); next.business_context.pricing_notes = text; break;
            case 'delivery': next.business_context.delivery_info = text; break;
            case 'faqs':
                next.objection_playbook = [...(Array.isArray(next.objection_playbook) ? next.objection_playbook : []),
                    { objection_type: 'price', objection: '', owner_reply: text, response_strategy: text, suggested_language: text, escalation_if_repeated: '', source: 'owner' }];
                break;
            case 'handoff': next.human_handoff_triggers = [...(Array.isArray(next.human_handoff_triggers) ? next.human_handoff_triggers : []), ...splitList(text)]; break;
            default: break;
        }
        applied.push(gap.key);
    }
    return { pack: next, applied };
}

// Saves a new active version for the account (or business-wide when accountId is null), retiring the old one.
// Versions are numbered across the whole business so the business-level unique key (dropped in part B) holds.
export async function savePackVersion(db, { businessId, accountId = null, pack, generatedBy = 'owner', now = new Date() }) {
    const { data: latest, error: latestError } = await db.from('persona_packs').select('version')
        .eq('business_id', businessId).order('version', { ascending: false }).limit(1).maybeSingle();
    if (latestError) throw latestError;
    const version = (latest?.version || 0) + 1;

    let retire = db.from('persona_packs').update({ is_active: false }).eq('business_id', businessId).eq('is_active', true);
    retire = accountId ? retire.eq('account_id', accountId) : retire.is('account_id', null);
    const { error: retireError } = await retire;
    if (retireError) throw retireError;

    const { data, error } = await db.from('persona_packs').insert({
        business_id: businessId, account_id: accountId, version, pack, is_active: true,
        generated_by: generatedBy, generated_at: now.toISOString(),
    }).select('id, version, account_id').single();
    if (error) throw error;
    return data;
}
