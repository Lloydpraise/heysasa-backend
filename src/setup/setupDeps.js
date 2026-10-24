// The real dependencies for the setup runner: Supabase for state, and the backend's own doors
// (the same ones the admin console uses) for the analyser, persona pack and product discovery.
import { supabase } from '../config/supabase.js';
import { logEvent } from '../services/debugConsole.js';
import { decideStarterCredit, starterAmountFromEnv } from './starterCredit.js';
import { seedChatAiSkills } from './chatAiSkills.js';

const PAGE = 1000;

// Narrows a query on an account-scoped table to one WhatsApp account (setup runs per account; ACCOUNTS.md).
const onAccount = (query, accountId) => (accountId ? query.eq('account_id', accountId) : query);
const MAX_IDS = 20_000;

// Where "newest chat first" lives is not the same in every database yet, so try the likely columns in turn.
const RECENCY_CANDIDATES = [
    { table: 'contacts', order: 'last_inbound_at', pick: 'id' },   // the Leads page reads last_inbound_at from contacts
    { table: 'conversations', order: 'last_inbound_at', pick: 'contact_id' },
    { table: 'conversations', order: 'last_message_at', pick: 'contact_id' },
    { table: 'contacts', order: 'id', pick: 'id' },   // always works: newest-created first
];

async function pageIds(businessId, { table, order, pick }, accountId = null) {
    const out = [];
    for (let from = 0; from < MAX_IDS; from += PAGE) {
        const { data, error } = await onAccount(supabase.from(table).select(pick).eq('business_id', businessId), accountId)
            .order(order, { ascending: false, nullsFirst: false }).range(from, from + PAGE - 1);
        if (error) throw error;
        out.push(...(data || []).map((row) => row[pick]));
        if (!data || data.length < PAGE) break;
    }
    return out;
}

export function buildSetupDeps() {
    const port = process.env.PORT || 3000;
    const call = async (path, body) => {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-debug-token': process.env.DEBUG_TOKEN || '' },
            body: JSON.stringify(body),
        });
        let json = null;
        try { json = await res.json(); } catch { /* not json */ }
        return { status: res.status, body: json };
    };

    return {
        now: () => Date.now(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        log: (level, event, details) => logEvent({ level, area: 'setup', event, message: event, details }),

        // business_setup: one row per account (key account_id). A business with no account yet keeps its
        // business-level row (key business_id), as before.
        store: {
            async get(businessId, accountId = null) {
                const query = supabase.from('business_setup').select('*').eq('business_id', businessId);
                const { data } = await (accountId ? query.eq('account_id', accountId) : query).limit(1).maybeSingle();
                return data || null;
            },
            async upsert(businessId, patch, accountId = null) {
                const row = { business_id: businessId, ...(accountId ? { account_id: accountId } : {}), ...patch, updated_at: new Date().toISOString() };
                const { error } = await supabase.from('business_setup')
                    .upsert(row, { onConflict: accountId ? 'account_id' : 'business_id' });
                if (error) throw new Error(`business_setup write failed: ${error.message}`);
            },
        },

        async countContacts(businessId, accountId = null) {
            const { count, error } = await onAccount(supabase.from('contacts').select('id', { count: 'exact', head: true }).eq('business_id', businessId), accountId);
            if (error) throw error;
            return count || 0;
        },
        async newestContactCreatedAt(businessId, accountId = null) {
            const { data, error } = await onAccount(supabase.from('contacts').select('created_at').eq('business_id', businessId), accountId)
                .order('created_at', { ascending: false }).limit(1);
            return error ? null : (data?.[0]?.created_at || null);
        },
        async listContactIdsNewestFirst(businessId, accountId = null) {
            let lastError = null;
            for (const candidate of RECENCY_CANDIDATES) {
                try { return await pageIds(businessId, candidate, accountId); } catch (error) { lastError = error; }
            }
            throw lastError || new Error('could_not_list_contacts');
        },
        async latestRun(businessId, sinceIso, accountId = null) {
            const { data } = await onAccount(supabase.from('enrichment_runs')
                .select('id, run_type, status, phase, progress_done, progress_total, summary, fatal_error, started_at')
                .eq('business_id', businessId).in('run_type', ['full_pass', 'contact_pass']).gte('started_at', sinceIso), accountId)
                .order('started_at', { ascending: false }).limit(1);
            return data?.[0] || null;
        },

        // One-time starter balance, only when SETUP_STARTER_CREDIT_USD is set. Returns the decision (never throws on "no").
        // The wallet is the business's, so the credit is given once per business (any account's setup row counts).
        async grantStarterCredit(businessId, accountId = null) {
            const amountUsd = starterAmountFromEnv();
            if (!amountUsd) return { grant: false, reason: 'off' };
            const [setup, business, balance] = await Promise.all([
                supabase.from('business_setup').select('starter_credit_at').eq('business_id', businessId).not('starter_credit_at', 'is', null).limit(1).maybeSingle().then((r) => r.data),
                supabase.from('businesses').select('business_type').eq('business_id', businessId).maybeSingle(),
                supabase.from('business_balances').select('balance_usd').eq('business_id', businessId).maybeSingle(),
            ]);
            const decision = decideStarterCredit({
                amountUsd, alreadyGiven: Boolean(setup?.starter_credit_at),
                balanceUsd: balance.data ? Number(balance.data.balance_usd) : null, businessType: business.data?.business_type,
            });
            if (!decision.grant) return decision;
            const { error } = await supabase.rpc('admin_credit_wallet', { p_business_id: businessId, p_currency: 'USD', p_amount: amountUsd, p_note: 'Starter credit' });
            if (error) throw new Error(`starter credit failed: ${error.message}`);
            await this.store.upsert(businessId, { starter_credit_at: new Date().toISOString() }, accountId);
            return decision;
        },

        seedChatAiSkills: (businessId, accountId = null) => seedChatAiSkills(supabase, businessId, accountId),

        launch: call,
        async kickPersona(businessId, { force, accountId = null }) { await call('/debug/persona/generate', { businessId, ...(accountId ? { accountId } : {}), force: Boolean(force) }); },
        async kickProductImages(businessId, accountId = null) { await call('/debug/products/discover', { businessId, ...(accountId ? { accountId } : {}) }); },
    };
}
