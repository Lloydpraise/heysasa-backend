import { createClient } from '@supabase/supabase-js';
import { supabase } from '../config/supabase.js';

// HeySasa accounts: one per WhatsApp number, owned by a business. See ACCOUNTS.md.

const ACCOUNT_SETTING_KEYS = null; // every key in accounts.settings overrides the business column of the same name

// Digits only, 8 to 15 long, from a phone or a WhatsApp JID ("2547...:12@s.whatsapp.net"). Null when unusable.
export function phoneFromJid(value) {
    const raw = String(value ?? '').split('@')[0].split(':')[0];
    const digits = raw.replace(/\D/g, '');
    return /^\d{8,15}$/.test(digits) ? digits : null;
}

// The account an Evolution instance serves now, with its business. Falls back to the session row and to the
// legacy businesses.evolution_instance_id for instances created before accounts existed.
export async function resolveInstance(instanceName, db = supabase) {
    if (!instanceName) throw new Error('evolution_instance_missing');
    const { data: account } = await db.from('accounts').select('*').eq('instance_name', instanceName).maybeSingle();
    if (account) return { businessId: account.business_id, accountId: account.id, account };

    const { data: session } = await db.from('whatsapp_sessions').select('business_id, account_id')
        .eq('instance_name', instanceName).order('updated_at', { ascending: false }).limit(1).maybeSingle();
    if (session) {
        let row = null;
        if (session.account_id) ({ data: row } = await db.from('accounts').select('*').eq('id', session.account_id).maybeSingle());
        return { businessId: session.business_id, accountId: session.account_id ?? null, account: row };
    }

    const { data: business } = await db.from('businesses').select('business_id').eq('evolution_instance_id', instanceName).maybeSingle();
    if (business) {
        const { data: rows } = await db.from('accounts').select('*').eq('business_id', business.business_id).neq('status', 'closed');
        const only = rows?.length === 1 ? rows[0] : null;
        return { businessId: business.business_id, accountId: only?.id ?? null, account: only };
    }
    throw new Error(`unknown_evolution_instance:${instanceName}`);
}

export async function getAccount(accountId, db = supabase) {
    if (!accountId) return null;
    const { data, error } = await db.from('accounts').select('*').eq('id', accountId).maybeSingle();
    if (error) throw error;
    return data;
}

export async function listAccounts(businessId, db = supabase) {
    const { data, error } = await db.from('accounts').select('*').eq('business_id', businessId).neq('status', 'closed').order('created_at');
    if (error) throw error;
    return data || [];
}

// The account's view of the business settings: the businesses row with accounts.settings laid over it.
export async function loadAccountSettings(db, accountId, businessId = null) {
    const account = accountId ? await getAccount(accountId, db) : null;
    const bizId = account?.business_id ?? businessId;
    if (!bizId) return null;
    const { data: business, error } = await db.from('businesses').select('*').eq('business_id', bizId).maybeSingle();
    if (error) throw error;
    if (!business) return null;
    const overrides = account?.settings && typeof account.settings === 'object' ? account.settings : {};
    const merged = { ...business };
    for (const [key, value] of Object.entries(overrides)) {
        if (ACCOUNT_SETTING_KEYS && !ACCOUNT_SETTING_KEYS.includes(key)) continue;
        merged[key] = value;
    }
    return merged;
}

// A service-role client that stamps x-account-id on every request, so rows it inserts are filled with that
// account by the database (see fill_account_id). Reads still need forAccount / .eq('account_id', ...).
const accountClients = new Map();
export function dbForAccount(accountId) {
    if (!accountId) return supabase;
    let client = accountClients.get(accountId);
    if (!client) {
        const url = process.env.SUPABASE_URL?.trim();
        const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY)?.trim();
        client = createClient(url, key, {
            auth: { persistSession: false, autoRefreshToken: false },
            global: { headers: { 'x-account-id': accountId } },
        });
        if (accountClients.size > 500) accountClients.clear();
        accountClients.set(accountId, client);
    }
    return client;
}

// Locked number check. The first number to connect an account is saved and locked; any other number is refused.
// Returns { ok: true, phone } or { ok: false, reason: 'phone_mismatch', expected, actual }.
export async function checkAccountPhone(accountId, phone, db = supabase) {
    const account = await getAccount(accountId, db);
    if (!account) return { ok: true, phone };
    if (!phone) return { ok: true, phone: account.phone_number ?? null };
    if (account.phone_number && account.phone_number !== phone) {
        return { ok: false, reason: 'phone_mismatch', expected: account.phone_number, actual: phone, account };
    }
    if (!account.phone_number) {
        const { error } = await db.from('accounts').update({ phone_number: phone }).eq('id', accountId);
        if (error && !/phone_locked/.test(error.message || '')) {
            // Another account already holds this number (accounts_phone_key).
            if (/accounts_phone_key|duplicate key/.test(error.message || '')) return { ok: false, reason: 'phone_in_use', actual: phone, account };
            throw error;
        }
    }
    return { ok: true, phone };
}

// Has database part B run? Until it has, a business must not get a second account (the business-level unique
// keys would merge its contacts). See ACCOUNTS.md "Deploy order".
export async function multiAccountReady(db = supabase) {
    const { data, error } = await db.rpc('accounts_part_b_applied');
    if (error) return false;
    return data === true;
}

// Creates an account (a slot for one WhatsApp number). The first account of a business is free until its trial
// ends; every further account is invoiced KES 10,000 straight away (to the business, or to the account itself
// on separate billing). Returns the account row.
export async function createAccount({ businessId, label, billingMode = 'business', createdBy = null }, db = supabase) {
    if (!['business', 'separate'].includes(billingMode)) {
        const error = new Error('invalid_billing_mode'); error.status = 400; throw error;
    }
    const existing = await listAccounts(businessId, db);
    if (existing.length && !(await multiAccountReady(db))) {
        const error = new Error('multi_account_not_ready'); error.status = 409; throw error;
    }
    const { data: account, error } = await db.from('accounts').insert({
        business_id: businessId,
        label: String(label ?? '').trim().slice(0, 80) || `WhatsApp ${existing.length + 1}`,
        billing_mode: billingMode,
        is_primary: existing.length === 0,
        status: 'pending',
        created_by: createdBy,
        subscription_status: existing.length ? 'active' : 'trial',
        paid_until: existing.length ? null : new Date(Date.now() + 30 * 86400000).toISOString(),
    }).select().single();
    if (error) throw error;

    if (billingMode === 'separate') {
        await db.from('account_balances').insert({ account_id: account.id, business_id: businessId, balance_usd: 0 });
    }
    if (existing.length) {
        // Issues this account's first access invoice now (due today).
        const { error: billError } = await db.rpc('account_billing_daily');
        if (billError) console.warn('[accounts] first invoice not issued:', billError.message);
    }
    return account;
}

// Owner/admin view: every account with its number, state, subscription and this month's AI spend.
export async function accountsOverview(businessId, db = supabase) {
    const accounts = await listAccounts(businessId, db);
    if (!accounts.length) return [];
    const since = new Date(); since.setUTCDate(1); since.setUTCHours(0, 0, 0, 0);
    const ids = accounts.map((a) => a.id);
    const [{ data: spend }, { data: invoices }] = await Promise.all([
        db.from('balance_transactions').select('account_id, amount, type, category').in('account_id', ids).gte('created_at', since.toISOString()),
        db.from('account_invoices').select('account_id, status, amount_kes, due_at, period_start, period_end').in('account_id', ids).eq('status', 'due'),
    ]);
    return accounts.map((a) => ({
        ...a,
        month_spent_usd: (spend || []).filter((t) => t.account_id === a.id && t.type === 'debit' && t.category !== 'adjustment')
            .reduce((sum, t) => sum - Number(t.amount || 0), 0),
        open_invoices: (invoices || []).filter((i) => i.account_id === a.id),
    }));
}
