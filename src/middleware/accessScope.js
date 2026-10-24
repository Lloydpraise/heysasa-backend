import { supabase } from '../config/supabase.js';

// Who is asking, for which business, and which WhatsApp account(s) they may see. See ACCOUNTS.md.
//
// scope = {
//   userId, businessId,
//   role: 'owner' | 'admin' | 'member',
//   isAdmin,            // owner or admin: every account, business-wide view, billing, team
//   accountIds,         // accounts this user may open (non-closed)
//   accountId,          // the selected account, or null = business-wide (owners/admins, or a member's several)
// }
//
// The dashboard sends X-Business-Id and, when an account is selected, X-Account-Id. A business with a single
// account always resolves to it, so single-number businesses behave exactly as before.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sameEmail = (a, b) => typeof a === 'string' && typeof b === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();
const pick = (...values) => values.find((v) => typeof v === 'string' && v.trim())?.trim() || null;

export class ScopeError extends Error {
    constructor(status, code) { super(code); this.status = status; this.code = code; }
}

export function createScopeResolver(db) {
    // Businesses the user may open: owned (user_id, or owner_email on older rows) or joined through business_users.
    async function businessesFor(user, businessId = null) {
        const owned = db.from('businesses').select('business_id, user_id, owner_email').eq('user_id', user.id);
        const byEmail = user.email ? db.from('businesses').select('business_id, user_id, owner_email').ilike('owner_email', user.email.trim()) : null;
        const member = db.from('business_users').select('business_id, id, role').eq('user_id', user.id).eq('status', 'active');
        const [o, e, m] = await Promise.all([
            businessId ? owned.eq('business_id', businessId) : owned,
            byEmail ? (businessId ? byEmail.eq('business_id', businessId) : byEmail) : Promise.resolve({ data: [] }),
            businessId ? member.eq('business_id', businessId) : member,
        ]);
        if (o.error && m.error) throw new ScopeError(500, 'lookup_failed');
        const out = new Map();
        for (const row of [...(o.data || []), ...(e.data || [])]) {
            if (row.user_id === user.id || sameEmail(row.owner_email, user.email)) out.set(row.business_id, { role: 'owner' });
        }
        for (const row of m.data || []) {
            if (!out.has(row.business_id)) out.set(row.business_id, { role: row.role === 'admin' ? 'admin' : 'member', businessUserId: row.id });
        }
        return out;
    }

    async function accountIdsFor(businessId, access) {
        const { data, error } = await db.from('accounts').select('id').eq('business_id', businessId).neq('status', 'closed');
        if (error) throw new ScopeError(500, 'lookup_failed');
        const all = (data || []).map((a) => a.id);
        if (access.role !== 'member') return all;
        const { data: links, error: linkError } = await db.from('business_user_accounts').select('account_id').eq('business_user_id', access.businessUserId);
        if (linkError) throw new ScopeError(500, 'lookup_failed');
        const mine = new Set((links || []).map((l) => l.account_id));
        return all.filter((id) => mine.has(id));
    }

    // Resolves the scope for a dashboard request, or throws ScopeError.
    async function resolve(req) {
        const header = req.headers?.authorization ?? '';
        const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
        if (!token) throw new ScopeError(401, 'missing_auth_token');
        const { data: userData, error: userError } = await db.auth.getUser(token);
        if (userError || !userData?.user?.id) throw new ScopeError(401, 'invalid_auth_token');
        const user = userData.user;

        const requested = pick(req.headers?.['x-business-id'], req.body?.businessId, req.query?.businessId);
        const businesses = await businessesFor(user, requested);
        let businessId = requested;
        if (requested) {
            if (!businesses.has(requested)) throw new ScopeError(403, 'no_business_for_user');
        } else {
            if (!businesses.size) throw new ScopeError(403, 'no_business_for_user');
            if (businesses.size > 1) throw new ScopeError(400, 'missing_business_id');
            businessId = [...businesses.keys()][0];
        }
        const access = businesses.get(businessId);
        const accountIds = await accountIdsFor(businessId, access);
        const isAdmin = access.role !== 'member';
        if (!isAdmin && !accountIds.length) throw new ScopeError(403, 'no_account_access');

        let accountId = pick(req.headers?.['x-account-id'], req.body?.accountId, req.query?.accountId);
        if (accountId) {
            if (!UUID.test(accountId) || !accountIds.includes(accountId)) throw new ScopeError(403, 'account_not_allowed');
        } else if (accountIds.length === 1) {
            accountId = accountIds[0];
        }
        return { userId: user.id, email: user.email ?? null, businessId, role: access.role, isAdmin, accountIds, accountId: accountId || null };
    }

    return { resolve };
}

const resolver = createScopeResolver(supabase);
export const resolveScope = (req) => resolver.resolve(req);

function attach(req, scope) {
    req.scope = scope;
    req.businessId = scope.businessId;
    req.accountId = scope.accountId;
    req.userId = scope.userId;
}

function fail(res, error) {
    if (error instanceof ScopeError) return res.status(error.status).json({ ok: false, error: error.code });
    return null;
}

// Express middleware factory. Options: { account: true } refuses requests with no single account selected
// (400 account_required); { admin: true } refuses members (403 admin_only).
export function makeScopeMiddleware(resolveFn, { account = false, admin = false } = {}) {
    return async function scopeMiddleware(req, res, next) {
        try {
            const scope = await resolveFn(req);
            if (admin && !scope.isAdmin) return res.status(403).json({ ok: false, error: 'admin_only' });
            if (account && !scope.accountId) return res.status(400).json({ ok: false, error: 'account_required' });
            attach(req, scope);
            return next();
        } catch (error) {
            if (fail(res, error)) return undefined;
            return next(error);
        }
    };
}

export const requireScope = makeScopeMiddleware(resolveScope);
export const requireAccountScope = makeScopeMiddleware(resolveScope, { account: true });
export const requireBusinessAdmin = makeScopeMiddleware(resolveScope, { admin: true });

// For handlers that resolve inline: returns the scope, or sends the error response and returns null.
export async function scopeOrRespond(req, res, { account = false, admin = false } = {}) {
    try {
        const scope = await resolveScope(req);
        if (admin && !scope.isAdmin) { res.status(403).json({ ok: false, error: 'admin_only' }); return null; }
        if (account && !scope.accountId) { res.status(400).json({ ok: false, error: 'account_required' }); return null; }
        attach(req, scope);
        return scope;
    } catch (error) {
        if (fail(res, error)) return null;
        throw error;
    }
}

// Query helpers for account-scoped tables (service-role client, so these filters are the only fence).
// forAccount: rows of the selected account; business-wide owners see every account; a member with several
// accounts and none selected sees only theirs.
export function forAccount(query, scope, column = 'account_id') {
    if (!scope) return query;
    if (scope.accountId) return query.eq(column, scope.accountId);
    if (!scope.isAdmin) return query.in(column, scope.accountIds?.length ? scope.accountIds : ['00000000-0000-0000-0000-000000000000']);
    return query;
}

// forAccountOrShared: the account's own rows plus business-level ones (the shared catalog: products,
// knowledge, persona fallback, materials, chat tools).
export function forAccountOrShared(query, scope, column = 'account_id') {
    if (!scope) return query;
    if (scope.accountId) return query.or(`${column}.eq.${scope.accountId},${column}.is.null`);
    if (!scope.isAdmin) {
        const ids = scope.accountIds?.length ? scope.accountIds.join(',') : '00000000-0000-0000-0000-000000000000';
        return query.or(`${column}.in.(${ids}),${column}.is.null`);
    }
    return query;
}

// The account_id to stamp on a new row, or null to let the database fill it (single-account businesses).
export const accountIdFor = (scope) => scope?.accountId ?? null;
