import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLiveAccount, resolveUserAccess } from './access.ts';
import { resolveTools, type ToolRow } from './tools.ts';

type Row = Record<string, any>;
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const OTHER = '33333333-3333-3333-3333-333333333333';

// Just enough of the query builder for eq / neq filters and maybeSingle.
function db(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      let single = false;
      const api: any = {
        select: () => api,
        eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return api; },
        neq: (c: string, v: unknown) => { filters.push((r) => r[c] !== v); return api; },
        maybeSingle: () => { single = true; return api; },
        then: (resolve: any) => { const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r))); resolve({ data: single ? rows[0] ?? null : rows, error: null }); },
      };
      return api;
    },
  };
}

const tables = () => ({
  businesses: [{ business_id: 'b1', user_id: 'owner' }, { business_id: 'b2', user_id: 'someone' }],
  business_users: [
    { id: 'bu1', business_id: 'b1', user_id: 'admin', role: 'admin', status: 'active' },
    { id: 'bu2', business_id: 'b1', user_id: 'member1', role: 'member', status: 'active' },
    { id: 'bu3', business_id: 'b1', user_id: 'member2', role: 'member', status: 'active' },
    { id: 'bu4', business_id: 'b1', user_id: 'gone', role: 'admin', status: 'removed' },
  ],
  business_user_accounts: [{ business_user_id: 'bu2', account_id: A }, { business_user_id: 'bu3', account_id: A }, { business_user_id: 'bu3', account_id: B }],
  accounts: [{ id: A, business_id: 'b1', status: 'connected' }, { id: B, business_id: 'b1', status: 'connected' }, { id: OTHER, business_id: 'b2', status: 'connected' }],
});

test('owners and admins may use any account of the business; strangers and removed members may not', async () => {
  const d = db(tables());
  assert.deepEqual(await resolveUserAccess(d, { userId: 'owner', businessId: 'b1', accountId: B }), { ok: true, accountId: B, role: 'owner' });
  assert.deepEqual(await resolveUserAccess(d, { userId: 'admin', businessId: 'b1', accountId: A }), { ok: true, accountId: A, role: 'admin' });
  assert.equal((await resolveUserAccess(d, { userId: 'gone', businessId: 'b1', accountId: A }) as any).status, 403);
  assert.equal((await resolveUserAccess(d, { userId: 'stranger', businessId: 'b1', accountId: A }) as any).status, 403);
  assert.equal((await resolveUserAccess(d, { userId: 'owner', businessId: 'b1', accountId: OTHER }) as any).status, 403, 'an account of another business');
  assert.equal((await resolveUserAccess(d, { userId: 'owner', businessId: 'b1', accountId: 'not-a-uuid' }) as any).status, 400);
});

test('members only reach their assigned accounts; with one it is picked for them, with several they must choose', async () => {
  const d = db(tables());
  assert.deepEqual(await resolveUserAccess(d, { userId: 'member1', businessId: 'b1', accountId: A }), { ok: true, accountId: A, role: 'member' });
  assert.equal((await resolveUserAccess(d, { userId: 'member1', businessId: 'b1', accountId: B }) as any).status, 403);
  assert.deepEqual(await resolveUserAccess(d, { userId: 'member1', businessId: 'b1' }), { ok: true, accountId: A, role: 'member' });
  assert.deepEqual(await resolveUserAccess(d, { userId: 'member2', businessId: 'b1' }), { ok: false, status: 400, error: 'account_required' });
  assert.deepEqual(await resolveUserAccess(d, { userId: 'owner', businessId: 'b1' }), { ok: false, status: 400, error: 'account_required' });
});

test('a business with one account uses it; one from before accounts runs business-wide for the owner', async () => {
  const t = tables();
  t.accounts = t.accounts.filter((a) => a.id !== B);
  assert.deepEqual(await resolveUserAccess(db(t), { userId: 'owner', businessId: 'b1' }), { ok: true, accountId: A, role: 'owner' });
  t.accounts = [];
  assert.deepEqual(await resolveUserAccess(db(t), { userId: 'owner', businessId: 'b1' }), { ok: true, accountId: null, role: 'owner' });
});

test('a live turn takes the account from the conversation and refuses one that does not match', async () => {
  const d = db({ conversations: [{ id: 'c1', business_id: 'b1', account_id: A }, { id: 'old', business_id: 'b1', account_id: null }] });
  assert.deepEqual(await resolveLiveAccount(d, { business_id: 'b1', conversation_id: 'c1' }), { ok: true, accountId: A });
  assert.deepEqual(await resolveLiveAccount(d, { business_id: 'b1', account_id: A, conversation_id: 'c1' }), { ok: true, accountId: A });
  assert.equal((await resolveLiveAccount(d, { business_id: 'b1', account_id: B, conversation_id: 'c1' }) as any).status, 400);
  assert.equal((await resolveLiveAccount(d, { business_id: 'b2', conversation_id: 'c1' }) as any).status, 404);
  assert.deepEqual(await resolveLiveAccount(d, { business_id: 'b1', conversation_id: 'old' }), { ok: true, accountId: null });
});

test('tools: the account\'s own beats the business\'s, which beats the global one; other accounts\' tools are hidden', () => {
  const t = (name: string, business_id: string | null, account_id: string | null, target: string): ToolRow =>
    ({ name, business_id, account_id, description: target, parameters: {}, kind: 'builtin', target, phase: 'lookup' });
  const rows = [t('x', null, null, 'global'), t('x', 'b1', null, 'business'), t('x', 'b1', A, 'mine'), t('y', 'b1', B, 'theirs'), t('z', 'b1', null, 'z')];
  assert.deepEqual(resolveTools(rows, 'b1', A).map((r) => `${r.name}:${r.target}`), ['x:mine', 'z:z']);
  assert.deepEqual(resolveTools(rows, 'b1', B).map((r) => `${r.name}:${r.target}`), ['x:business', 'y:theirs', 'z:z']);
  assert.deepEqual(resolveTools(rows, 'b1').map((r) => `${r.name}:${r.target}`), ['x:business', 'z:z']);
});
