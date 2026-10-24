// Turning the follow-up AI and the chat AI on with the recommended settings (or the owner's changes).
// planSwitches is pure: it decides what to write and what to warn about. applySwitches does the write.
import { followupPrefsFor, validateFollowupPrefs, toColumns, RECOMMENDED } from './defaults.js';
import { cleanAudience, DEFAULT_AUDIENCE } from '../chatAi/audience.js';
import { seedChatAiSkills } from './chatAiSkills.js';
import { seedChatAiFlows } from './chatAiFlows.js';
import { loadAccountSettings } from '../services/accounts.js';
import { saveAccountSettings } from '../services/accountSettings.js';
import { loadActivePack } from '../personaPack.js';

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

// scope: the request scope (ACCOUNTS.md). The switches are per WhatsApp account: an account reads the business
// default with its own overrides (loadAccountSettings) and saves into accounts.settings when the business has
// several numbers (saveAccountSettings); the business-wide view saves the business default.
export async function applySwitches({ supabase, store, businessId, request, scope = null }) {
    const accountId = scope?.accountId ?? null;
    let business;
    try {
        business = await loadAccountSettings(supabase, accountId, businessId);
    } catch {
        business = null;
    }
    if (!business) return { error: 'business_not_found', status: 404 };
    // A pack the account can use (its own, or the business-wide fallback) counts as a ready persona.
    if (business.persona_pack_status !== 'ready' && request?.chat === true) {
        const active = await loadActivePack(supabase, businessId, accountId, 'id').catch(() => ({ row: null }));
        if (active.row) business = { ...business, persona_pack_status: 'ready' };
    }
    const setup = await store.get(businessId, accountId);
    const plan = planSwitches({ business, answers: setup?.answers || {}, request, balanceUsd: await loadBalance(supabase, businessId) });
    if (plan.error) return plan;
    try {
        await saveAccountSettings(supabase, scope?.businessId ? scope : { businessId, accountId }, plan.patch);
    } catch (writeError) {
        return { error: 'could_not_save', status: 500, detail: writeError.message };
    }
    const warnings = [...plan.warnings];
    if (plan.applied.chat?.on) {
        // The chat AI needs its skills and the ad-lead flow to give good answers. Both cost nothing and never touch what the owner has edited.
        // Skills and flows belong to an account: the business-wide view seeds every account.
        const targets = accountId ? [accountId] : (scope?.accountIds?.length ? scope.accountIds : [null]);
        try { for (const target of targets) { await seedChatAiSkills(supabase, businessId, target); await seedChatAiFlows(supabase, businessId, target); } }
        catch (e) { warnings.push('chat_setup_incomplete'); console.error('[switches] chat skills/flows seed failed:', e.message); }
    }
    return { ok: true, applied: plan.applied, warnings };
}
