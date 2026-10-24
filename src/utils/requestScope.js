import { supabase } from '../config/supabase.js';
import { isDebugTokenValid } from '../middleware/debugAuth.js';
import { scopeOrRespond } from '../middleware/accessScope.js';

// Routes that the dashboard calls with a Supabase token AND the debug console calls with DEBUG_TOKEN
// (/persona/generate, /products/discover, /analysis/start...). Signed-in users go through the shared
// scope (owner, admin or team member; see ACCOUNTS.md); the debug token gets a full owner-like scope on the
// business named in X-Business-Id (or the body), with the account from X-Account-Id when given, else the
// business's only account. Returns the scope, or sends the error response and returns null.
export async function scopeOrDebug(req, res, opts = {}, db = supabase) {
    if (!isDebugTokenValid(req)) return scopeOrRespond(req, res, opts);

    const pick = (...values) => values.find((v) => typeof v === 'string' && v.trim())?.trim() || null;
    const businessId = pick(req.headers?.['x-business-id'], req.body?.businessId, req.query?.businessId);
    if (!businessId) { res.status(400).json({ ok: false, error: 'missing_business_id' }); return null; }

    const { data: accounts, error } = await db.from('accounts').select('id').eq('business_id', businessId).neq('status', 'closed');
    if (error) { res.status(500).json({ ok: false, error: 'lookup_failed' }); return null; }
    const accountIds = (accounts || []).map((a) => a.id);
    let accountId = pick(req.headers?.['x-account-id'], req.body?.accountId, req.query?.accountId);
    if (accountId && !accountIds.includes(accountId)) { res.status(403).json({ ok: false, error: 'account_not_allowed' }); return null; }
    if (!accountId && accountIds.length === 1) accountId = accountIds[0];
    if (opts.account && !accountId) { res.status(400).json({ ok: false, error: 'account_required' }); return null; }

    const scope = { userId: null, email: null, businessId, role: 'owner', isAdmin: true, accountIds, accountId: accountId || null, debug: true };
    req.scope = scope;
    req.businessId = businessId;
    req.accountId = scope.accountId;
    return scope;
}
