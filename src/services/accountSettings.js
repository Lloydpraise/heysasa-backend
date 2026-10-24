// Writing WhatsApp-related settings (follow-up caps, quiet hours, chat AI switches, persona status...).
// See ACCOUNTS.md rule 7: the businesses row is the business default, accounts.settings overrides it per account.
//
//   - business-wide view (scope.accountId null): writes the businesses row (the default for every account);
//   - an account of a business with SEVERAL accounts: merges into that account's accounts.settings;
//   - the only account of a business: writes the businesses row and drops any override of those keys, so a
//     single-number business keeps behaving exactly as before (and the old readers of businesses still agree).
//
// Returns { target: 'account' | 'business' }. Read the merged view back with loadAccountSettings (services/accounts.js).
// No other imports, so the standalone scripts (generate-persona-pack.js...) can use it with their own client.
export async function saveAccountSettings(db, scope, row) {
    const businessId = scope?.businessId;
    if (!businessId) throw Object.assign(new Error('missing_business_id'), { status: 400 });
    const keys = Object.keys(row || {});
    const accountId = scope?.accountId ?? null;

    if (accountId && (await businessHasSeveralAccounts(db, businessId))) {
        const { data: account, error } = await db.from('accounts').select('id, settings').eq('id', accountId).eq('business_id', businessId).maybeSingle();
        if (error) throw error;
        if (!account) throw Object.assign(new Error('account_not_found'), { status: 404 });
        const merged = { ...(account.settings && typeof account.settings === 'object' ? account.settings : {}) };
        for (const key of keys) {
            if (row[key] === undefined) continue;
            merged[key] = row[key];
        }
        const { error: updateError } = await db.from('accounts').update({ settings: merged, updated_at: new Date().toISOString() }).eq('id', accountId);
        if (updateError) throw updateError;
        return { target: 'account' };
    }

    if (keys.length) {
        const { error } = await db.from('businesses').update(row).eq('business_id', businessId);
        if (error) throw error;
    }
    if (accountId) await dropOverrides(db, accountId, keys);
    return { target: 'business' };
}

export async function businessHasSeveralAccounts(db, businessId) {
    const { data, error } = await db.from('accounts').select('id').eq('business_id', businessId).neq('status', 'closed');
    if (error) throw error;
    return (data || []).length > 1;
}

async function dropOverrides(db, accountId, keys) {
    if (!keys.length) return;
    const { data: account } = await db.from('accounts').select('settings').eq('id', accountId).maybeSingle();
    const current = account?.settings && typeof account.settings === 'object' ? account.settings : null;
    if (!current || !keys.some((k) => k in current)) return;
    const next = { ...current };
    for (const key of keys) delete next[key];
    await db.from('accounts').update({ settings: next }).eq('id', accountId);
}
