import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { fakeSupabase } from '../test-helpers/fakeSupabase.js';
import { createAccountsRouter } from './routes.js';

const A1 = '11111111-1111-1111-1111-111111111111';
const A2 = '22222222-2222-2222-2222-222222222222';

function setup(scope) {
    const db = fakeSupabase({
        __users: [{ token: 'newbie', id: 'u-new', email: 'new@x' }],
        accounts: [{ id: A1, business_id: 'biz', label: 'Town', status: 'connected', created_at: '1' }, { id: A2, business_id: 'biz', label: 'Mall', status: 'pending', created_at: '2' }],
        billing_prices: [{ key: 'account_monthly_kes', value: 10000 }],
        business_users: [], business_user_accounts: [], businesses: [{ business_id: 'biz', user_id: 'u-owner' }],
    });
    const attach = (req, _res, next) => { req.scope = scope; req.businessId = 'biz'; req.accountId = scope.accountId; req.userId = scope.userId; next(); };
    const admin = (req, res, next) => (scope.isAdmin ? attach(req, res, next) : res.status(403).json({ ok: false, error: 'admin_only' }));
    const accounts = {
        listAccounts: async (biz) => db.tables.accounts.filter((a) => a.business_id === biz),
        createAccount: async ({ businessId, label, billingMode }) => { const a = { id: 'new', business_id: businessId, label, billing_mode: billingMode }; db.tables.accounts.push(a); return a; },
        accountsOverview: async () => [],
    };
    const app = express(); app.use(express.json());
    app.use(createAccountsRouter({ scope: attach, admin, db, accounts, appUrl: 'https://app.test' }));
    return { app, db };
}

async function call(app, method, path, body, headers = {}) {
    const server = app.listen(0);
    try {
        const { port } = server.address();
        const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, body: await res.json() };
    } finally { server.close(); }
}

const owner = { userId: 'u-owner', role: 'owner', isAdmin: true, accountIds: [A1, A2], accountId: null };
const member = { userId: 'u-m', role: 'member', isAdmin: false, accountIds: [A2], accountId: A2 };

test('a member lists only their accounts and cannot create one', async () => {
    const { app } = setup(member);
    const list = await call(app, 'GET', '/accounts');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.accounts.map((a) => a.label), ['Mall']);
    assert.equal(list.body.monthlyPriceKes, 10000);
    assert.equal((await call(app, 'POST', '/accounts', { label: 'X' })).status, 403);
});

test('owner creates an account with separate billing', async () => {
    const { app } = setup(owner);
    const made = await call(app, 'POST', '/accounts', { label: 'Branch', billingMode: 'separate' });
    assert.equal(made.status, 201);
    assert.equal(made.body.account.billing_mode, 'separate');
});

test('invite, assign and accept', async () => {
    const { app, db } = setup(owner);
    const invite = await call(app, 'POST', '/team/invite', { email: 'Exec@Shop.com', role: 'member', accountIds: [A2] });
    assert.equal(invite.status, 201);
    assert.match(invite.body.invite_link, /^https:\/\/app\.test\/invite\//);
    assert.deepEqual(db.tables.business_user_accounts.map((l) => l.account_id), [A2]);
    const bad = await call(app, 'POST', '/team/invite', { email: 'x@y.z', accountIds: ['33333333-3333-3333-3333-333333333333'] });
    assert.equal(bad.status, 404);

    const token = invite.body.invite_link.split('/').pop();
    const accepted = await call(app, 'POST', '/team/accept', { token }, { authorization: 'Bearer newbie' });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.businessId, 'biz');
    const person = db.tables.business_users.find((p) => p.email === 'exec@shop.com');
    assert.equal(person.status, 'active');
    assert.equal(person.user_id, 'u-new');
    assert.equal((await call(app, 'POST', '/team/accept', { token }, { authorization: 'Bearer newbie' })).status, 404);
});
