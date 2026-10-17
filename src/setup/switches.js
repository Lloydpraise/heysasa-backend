// Turning the follow-up AI and the chat AI on with the recommended settings (or the owner's changes).
// planSwitches is pure: it decides what to write and what to warn about. applySwitches does the write.
import { followupPrefsFor, validateFollowupPrefs, toColumns, RECOMMENDED } from './defaults.js';
import { cleanAudience, DEFAULT_AUDIENCE } from '../chatAi/audience.js';
import { seedChatAiSkills } from './chatAiSkills.js';
import { seedChatAiFlows } from './chatAiFlows.js';

const BUSINESS_COLUMNS = 'business_id, business_type, followup_ai_enabled, chat_ai_enabled, chat_ai_daily_cap, chat_ai_settings, persona_pack_status, subscription_active';

// Can this business pay for AI? HeySasa's own business is free. null = we could not tell.
export function hasBalance(business, balanceUsd) {
    if (business?.business_type === 'heysasa') return true;
    if (balanceUsd === null || balanceUsd === undefined) return null;
    return Number(balanceUsd) > 0;
}

export async function loadBalance(supabase, businessId) {
    const { data } = await supabase.from('business_balances').select('balance_usd').eq('business_id', businessId).maybeSingle();
    return data ? Number(data.balance_usd) : null;
}

// request: { followups?: boolean, chat?: boolean, overrides?: { followups?: {...}, chat?: { daily_cap, audience: ['ads','hot','all'] } } }
export function planSwitches({ business, answers = {}, request = {}, balanceUsd = null }) {
    const patch = {};
    const warnings = [];
    const applied = {};

    if (request.followups === true) {
        const prefs = followupPrefsFor(answers, request.overrides?.followups || {});
        const bad = validateFollowupPrefs(prefs);
        if (bad) return { error: bad, status: 400 };
        Object.assign(patch, toColumns(prefs), { followup_ai_enabled: true });
        applied.followups = { on: true, prefs };
        if (business.subscription_active === false) warnings.push('subscription_inactive');
        if (hasBalance(business, balanceUsd) === false) warnings.push('balance_empty');   // the AI cannot write or answer without balance
    } else if (request.followups === false) {
        patch.followup_ai_enabled = false;
        applied.followups = { on: false };
    }

    if (request.chat === true) {
        if (business.persona_pack_status !== 'ready') return { error: 'persona_not_ready', status: 409 };
        const cap = request.overrides?.chat?.daily_cap ?? RECOMMENDED.chat.daily_cap;
        if (!Number.isInteger(cap) || cap < 1 || cap > 1000) return { error: 'invalid_chat_daily_cap', status: 400 };
        const settings = { ...(business.chat_ai_settings || {}) };
        // Who the chat AI talks to. Not given: keep what was saved; a business that is already on with nothing saved keeps
        // answering everyone (that is what it did until now); a new switch-on starts with ad leads and hot leads.
        const given = request.overrides?.chat?.audience;
        if (given !== undefined && !cleanAudience(given)) return { error: 'invalid_chat_audience', status: 400 };
        const audience = cleanAudience(given) || cleanAudience(settings.audience) || (business.chat_ai_enabled === true ? ['all'] : DEFAULT_AUDIENCE);
        settings.audience = audience;
        if (answers.hours) settings.business_hours = answers.hours;
        if (answers.handoff?.length) settings.handoff_reasons = answers.handoff;
        Object.assign(patch, { chat_ai_enabled: true, chat_ai_daily_cap: cap, chat_ai_settings: settings });
        applied.chat = { on: true, daily_cap: cap, audience };
        if (business.subscription_active === false) warnings.push('subscription_inactive');
        if (hasBalance(business, balanceUsd) === false) warnings.push('balance_empty');   // the AI cannot write or answer without balance
    } else if (request.chat === false) {
        patch.chat_ai_enabled = false;
        applied.chat = { on: false };
    }

    if (!Object.keys(patch).length) return { error: 'nothing_to_change', status: 400 };
    return { patch, warnings: [...new Set(warnings)], applied };
}

export async function applySwitches({ supabase, store, businessId, request }) {
    const { data: business, error } = await supabase.from('businesses').select(BUSINESS_COLUMNS).eq('business_id', businessId).maybeSingle();
    if (error || !business) return { error: 'business_not_found', status: 404 };
    const setup = await store.get(businessId);
    const plan = planSwitches({ business, answers: setup?.answers || {}, request, balanceUsd: await loadBalance(supabase, businessId) });
    if (plan.error) return plan;
    const { error: writeError } = await supabase.from('businesses').update(plan.patch).eq('business_id', businessId);
    if (writeError) return { error: 'could_not_save', status: 500, detail: writeError.message };
    const warnings = [...plan.warnings];
    if (plan.applied.chat?.on) {
        // The chat AI needs its skills and the ad-lead flow to give good answers. Both cost nothing and never touch what the owner has edited.
        try { await seedChatAiSkills(supabase, businessId); await seedChatAiFlows(supabase, businessId); }
        catch (e) { warnings.push('chat_setup_incomplete'); console.error('[switches] chat skills/flows seed failed:', e.message); }
    }
    return { ok: true, applied: plan.applied, warnings };
}
