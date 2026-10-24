import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeSupabase } from '../test-helpers/fakeSupabase.js';

process.env.SUPABASE_URL ??= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
const { createScopeResolver, forAccount, forAccountOrShared, ScopeError } = await import('./accessScope.js');

const A1 = '11111111-1111-1111-1111-111111111111';
const A2 = '22222222-2222-2222-2222-222222222222';

function db() {
    return fakeSupabase({
        __users: [{ token: 'owner', id: 'u-owner', email: 'o@x' }, { token: 'member', id: 'u-member', email: 'm@x' }, { token: 'stranger', id: 'u-s', email: 's@x' }],
        businesses: [{ business_id: 'biz', user_id: 'u-owner', owner_email: null }, { business_id: 'solo', user_id: 'u-s', owner_email: null }],
        business_users: [{ id: 'bu1', business_id: 'biz', user_id: 'u-member', role: 'member', status: 'active' }],
        business_user_accounts: [{ business_user_id: 'bu1', account_id: A2 }],
        accounts: [{ id: A1, business_id: 'biz', status: 'connected' }, { id: A2, business_id: 'biz', status: 'disconnected' }, { id: 'solo-acct', business_id: 'solo', status: 'connected' }],
    });
}
const req = (token, headers = {}) => ({ headers: { authorization: `Bearer ${token}`, ...headers }, body: {}, query: {} });

test('owner without an account header gets the business-wide view', async () => {
    const s = await createScopeResolver(db()).resolve(req('owner', { 'x-business-id': 'biz' }));
    assert.equal(s.role, 'owner'); assert.equal(s.isAdmin, true); assert.equal(s.accountId, null);
    assert.deepEqual(s.accountIds.sort(), [A1, A2].sort());
});

test('owner can pick an account', async () => {
    const s = await createScopeResolver(db()).resolve(req('owner', { 'x-business-id': 'biz', 'x-account-id': A1 }));
    assert.equal(s.accountId, A1);
});

test('member is pinned to their only account and refused others', async () => {
    const r = createScopeResolver(db());
    const s = await r.resolve(req('member', { 'x-business-id': 'biz' }));
    assert.equal(s.role, 'member'); assert.equal(s.isAdmin, false); assert.equal(s.accountId, A2);
    await assert.rejects(r.resolve(req('member', { 'x-business-id': 'biz', 'x-account-id': A1 })), (e) => e instanceof ScopeError && e.code === 'account_not_allowed');
});

test('a single-account business resolves to that account without headers', async () => {
    const s = await createScopeResolver(db()).resolve(req('stranger'));
    assert.equal(s.businessId, 'solo'); assert.equal(s.accountId, 'solo-acct');
});

test('strangers and bad tokens are refused', async () => {
    const r = createScopeResolver(db());
    await assert.rejects(r.resolve(req('stranger', { 'x-business-id': 'biz' })), (e) => e.code === 'no_business_for_user');
    await assert.rejects(r.resolve(req('nope', { 'x-business-id': 'biz' })), (e) => e.code === 'invalid_auth_token');
    await assert.rejects(r.resolve({ headers: {} }), (e) => e.code === 'missing_auth_token');
});

test('query helpers filter by account', async () => {
    const d = fakeSupabase({ contacts: [{ id: 1, account_id: A1 }, { id: 2, account_id: A2 }], products: [{ id: 'p', account_id: null }, { id: 'q', account_id: A1 }, { id: 'r', account_id: A2 }] });
    const ids = async (q) => (await q).data.map((r) => r.id);
    assert.deepEqual(await ids(forAccount(d.from('contacts').select('*'), { accountId: A1, isAdmin: true })), [1]);
    assert.deepEqual(await ids(forAccount(d.from('contacts').select('*'), { accountId: null, isAdmin: true })), [1, 2]);
    assert.deepEqual(await ids(forAccount(d.from('contacts').select('*'), { accountId: null, isAdmin: false, accountIds: [A2] })), [2]);
    assert.deepEqual(await ids(forAccountOrShared(d.from('products').select('*'), { accountId: A1, isAdmin: true })), ['p', 'q']);
    assert.deepEqual(await ids(forAccountOrShared(d.from('products').select('*'), { accountId: null, isAdmin: false, accountIds: [A2] })), ['p', 'r']);
});
