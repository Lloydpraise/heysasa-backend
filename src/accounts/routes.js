// Accounts (one per WhatsApp number) and the business's team. See ACCOUNTS.md.
//
//   GET    /accounts                    accounts the caller may open, plus their role
//   POST   /accounts                    (owner/admin) create an account: { label, billingMode: 'business'|'separate' }
//   PATCH  /accounts/:id                (owner/admin) { label, settings }  settings are merged into accounts.settings
//   POST   /accounts/:id/import         copy products/knowledge into the account: { kind, ids?, fromAccountId? }
//   GET    /accounts/overview           (owner/admin) every account with this month's spend and open invoices
//
//   GET    /team                        (owner/admin) people with access and the accounts each controls
//   POST   /team/invite                 (owner/admin) { email, name, role: 'admin'|'member', accountIds } -> invite link
//   PATCH  /team/:id                    (owner/admin) { role, accountIds }
//   DELETE /team/:id                    (owner/admin) remove access
//   POST   /team/accept                 any signed-in user: { token } -> joins the business
import { Router } from 'express';
import { randomBytes } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLES = new Set(['admin', 'member']);

function httpError(status, code) { return Object.assign(new Error(code), { status, code }); }

// deps: { scope (middleware), admin (middleware), db, accounts: { listAccounts, createAccount, accountsOverview }, appUrl, log }
export function createAccountsRouter({ scope, admin, db, accounts, appUrl = '', log = () => {} }) {
    const router = Router();
    const wrap = (fn) => async (req, res) => {
        try {
            const out = await fn(req, res);
            if (!res.headersSent) res.json({ ok: true, ...out });
        } catch (error) {
            const status = Number(error.status) || 500;
            if (status >= 500) log('error', 'accounts.route_failed', { path: req.path, error: error.message });
            res.status(status).json({ ok: false, error: error.code || error.message });
        }
    };
    const accountInBusiness = async (req, id) => {
        if (!UUID.test(String(id))) throw httpError(400, 'invalid_account_id');
        const { data, error } = await db.from('accounts').select('*').eq('id', id).eq('business_id', req.businessId).maybeSingle();
        if (error) throw error;
        if (!data || !req.scope.accountIds.includes(data.id)) throw httpError(404, 'account_not_found');
        return data;
    };

    // ── accounts ────────────────────────────────────────────────────────────────────────────────────

    router.get('/accounts', scope, wrap(async (req) => {
        const all = await accounts.listAccounts(req.businessId, db);
        const mine = all.filter((a) => req.scope.accountIds.includes(a.id));
        const { data: prices } = await db.from('billing_prices').select('key, value').in('key', ['account_monthly_kes']);
        return {
            role: req.scope.role,
            isAdmin: req.scope.isAdmin,
            selectedAccountId: req.scope.accountId,
            monthlyPriceKes: Number(prices?.[0]?.value ?? 10000),
            accounts: mine.map((a) => ({
                id: a.id, label: a.label, phone_number: a.phone_number, status: a.status, is_primary: a.is_primary,
                instance_name: a.instance_name, billing_mode: a.billing_mode, subscription_status: a.subscription_status,
                paid_until: a.paid_until, connect_error: a.connect_error, created_at: a.created_at,
                settings: req.scope.isAdmin ? a.settings : undefined,
            })),
        };
    }));

    router.get('/accounts/overview', admin, wrap(async (req) => ({ accounts: await accounts.accountsOverview(req.businessId, db) })));

    router.post('/accounts', admin, wrap(async (req, res) => {
        const account = await accounts.createAccount({
            businessId: req.businessId,
            label: req.body?.label,
            billingMode: req.body?.billingMode === 'separate' ? 'separate' : 'business',
            createdBy: req.userId,
        }, db);
        log('info', 'accounts.created', { businessId: req.businessId, accountId: account.id, billingMode: account.billing_mode });
        res.status(201);
        return { account };
    }));

    router.patch('/accounts/:id', admin, wrap(async (req) => {
        const current = await accountInBusiness(req, req.params.id);
        const patch = { updated_at: new Date().toISOString() };
        if (typeof req.body?.label === 'string') patch.label = req.body.label.trim().slice(0, 80) || current.label;
        if (req.body?.settings && typeof req.body.settings === 'object' && !Array.isArray(req.body.settings)) {
            const merged = { ...(current.settings || {}) };
            for (const [key, value] of Object.entries(req.body.settings)) {
                if (value === null) delete merged[key]; else merged[key] = value;
            }
            patch.settings = merged;
        }
        if (req.body?.billingMode && ['business', 'separate'].includes(req.body.billingMode)) {
            patch.billing_mode = req.body.billingMode;
            if (req.body.billingMode === 'separate') {
                await db.from('account_balances').upsert({ account_id: current.id, business_id: req.businessId }, { onConflict: 'account_id', ignoreDuplicates: true });
            }
        }
        const { data, error } = await db.from('accounts').update(patch).eq('id', current.id).select().single();
        if (error) throw error;
        return { account: data };
    }));

    router.post('/accounts/:id/import', scope, wrap(async (req) => {
        const account = await accountInBusiness(req, req.params.id);
        const kind = req.body?.kind;
        if (!['products', 'knowledge'].includes(kind)) throw httpError(400, 'invalid_kind');
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, 1000) : null;
        let fromAccountId = req.body?.fromAccountId || null;
        if (fromAccountId) fromAccountId = (await accountInBusiness(req, fromAccountId)).id;
        const { data, error } = await db.rpc('copy_business_items_to_account', {
            p_account_id: account.id, p_kind: kind, p_ids: ids, p_from_account: fromAccountId,
        });
        if (error) throw error;
        return { copied: data ?? 0 };
    }));

    // ── team ────────────────────────────────────────────────────────────────────────────────────────

    router.get('/team', admin, wrap(async (req) => {
        const [{ data: people, error }, { data: links }, { data: owner }] = await Promise.all([
            db.from('business_users').select('id, user_id, email, display_name, role, status, invite_token, created_at, accepted_at')
                .eq('business_id', req.businessId).neq('status', 'removed').order('created_at'),
            db.from('business_user_accounts').select('business_user_id, account_id, business_users!inner(business_id)').eq('business_users.business_id', req.businessId),
            db.from('businesses').select('user_id, owner_email').eq('business_id', req.businessId).maybeSingle(),
        ]);
        if (error) throw error;
        const byPerson = new Map();
        for (const l of links || []) byPerson.set(l.business_user_id, [...(byPerson.get(l.business_user_id) || []), l.account_id]);
        return {
            owner: { user_id: owner?.user_id ?? null, email: owner?.owner_email ?? null },
            members: (people || []).map((p) => ({
                ...p,
                invite_token: undefined,
                invite_link: p.status === 'invited' && p.invite_token ? `${appUrl.replace(/\/$/, '')}/invite/${p.invite_token}` : null,
                account_ids: byPerson.get(p.id) || [],
            })),
        };
    }));

    async function setAccounts(req, businessUserId, accountIds) {
        const wanted = [...new Set((accountIds || []).map(String))];
        for (const id of wanted) await accountInBusiness(req, id);
        const { error: delError } = await db.from('business_user_accounts').delete().eq('business_user_id', businessUserId);
        if (delError) throw delError;
        if (wanted.length) {
            const { error } = await db.from('business_user_accounts').insert(wanted.map((account_id) => ({ business_user_id: businessUserId, account_id })));
            if (error) throw error;
        }
        return wanted;
    }

    router.post('/team/invite', admin, wrap(async (req, res) => {
        const email = String(req.body?.email || '').trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpError(400, 'invalid_email');
        const role = ROLES.has(req.body?.role) ? req.body.role : 'member';
        if (role === 'admin' && req.scope.role !== 'owner') throw httpError(403, 'owner_only');
        if (role === 'member') for (const id of req.body?.accountIds || []) await accountInBusiness(req, id);
        const token = randomBytes(24).toString('base64url');
        const { data: person, error } = await db.from('business_users').insert({
            business_id: req.businessId, email, display_name: String(req.body?.name || '').trim().slice(0, 80) || null,
            role, status: 'invited', invite_token: token, invited_by: req.userId,
        }).select('id').single();
        if (error) throw error;
        const accountIds = role === 'member' ? await setAccounts(req, person.id, req.body?.accountIds) : [];
        log('info', 'team.invited', { businessId: req.businessId, role, accounts: accountIds.length });
        res.status(201);
        return { id: person.id, invite_link: `${appUrl.replace(/\/$/, '')}/invite/${token}`, account_ids: accountIds };
    }));

    const personInBusiness = async (req, id) => {
        const { data, error } = await db.from('business_users').select('*').eq('id', id).eq('business_id', req.businessId).maybeSingle();
        if (error) throw error;
        if (!data || data.status === 'removed') throw httpError(404, 'person_not_found');
        return data;
    };

    router.patch('/team/:id', admin, wrap(async (req) => {
        const person = await personInBusiness(req, req.params.id);
        const patch = { updated_at: new Date().toISOString() };
        if (req.body?.role && ROLES.has(req.body.role)) {
            if ((req.body.role === 'admin' || person.role === 'admin') && req.scope.role !== 'owner') throw httpError(403, 'owner_only');
            patch.role = req.body.role;
        }
        const { error } = await db.from('business_users').update(patch).eq('id', person.id);
        if (error) throw error;
        const accountIds = Array.isArray(req.body?.accountIds) ? await setAccounts(req, person.id, req.body.accountIds) : undefined;
        return { id: person.id, role: patch.role ?? person.role, account_ids: accountIds };
    }));

    router.delete('/team/:id', admin, wrap(async (req) => {
        const person = await personInBusiness(req, req.params.id);
        if (person.role === 'admin' && req.scope.role !== 'owner') throw httpError(403, 'owner_only');
        const { error } = await db.from('business_users').update({ status: 'removed', invite_token: null, updated_at: new Date().toISOString() }).eq('id', person.id);
        if (error) throw error;
        return { id: person.id };
    }));

    // The invitee is signed in but not part of the business yet, so this checks the token, not the scope.
    router.post('/team/accept', wrap(async (req) => {
        const header = req.headers.authorization ?? '';
        const jwt = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
        if (!jwt) throw httpError(401, 'missing_auth_token');
        const { data: userData, error: userError } = await db.auth.getUser(jwt);
        if (userError || !userData?.user?.id) throw httpError(401, 'invalid_auth_token');
        const token = String(req.body?.token || '').trim();
        if (!token) throw httpError(400, 'missing_token');
        const { data: invite, error } = await db.from('business_users').select('id, business_id, status, email')
            .eq('invite_token', token).eq('status', 'invited').maybeSingle();
        if (error) throw error;
        if (!invite) throw httpError(404, 'invite_not_found');
        const { data: already } = await db.from('business_users').select('id').eq('business_id', invite.business_id)
            .eq('user_id', userData.user.id).neq('status', 'removed').maybeSingle();
        if (already) throw httpError(409, 'already_member');
        const { error: updateError } = await db.from('business_users').update({
            user_id: userData.user.id, status: 'active', invite_token: null,
            accepted_at: new Date().toISOString(), updated_at: new Date().toISOString(),
            email: invite.email || userData.user.email || null,
        }).eq('id', invite.id);
        if (updateError) throw updateError;
        log('info', 'team.accepted', { businessId: invite.business_id });
        return { businessId: invite.business_id };
    }));

    return router;
}
