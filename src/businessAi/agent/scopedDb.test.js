import '../../test-helpers/testEnv.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fakeDb.js';
import { scopedDb } from './scopedDb.js';

const A1 = '11111111-1111-1111-1111-111111111111';
const A2 = '22222222-2222-2222-2222-222222222222';
const seed = () => fakeDb({
  contacts: [{ id: 1, business_id: 'b', account_id: A1 }, { id: 2, business_id: 'b', account_id: A2 }],
  products: [{ id: 'p1', business_id: 'b', account_id: A1 }, { id: 'p2', business_id: 'b', account_id: A2 }, { id: 'p3', business_id: 'b', account_id: null }],
  businesses: [{ business_id: 'b' }],
});

test('an account sees only its own rows, plus the shared catalog', async () => {
  const db = scopedDb(seed(), { businessId: 'b', accountId: A1, isAdmin: true, accountIds: [A1, A2] });
  assert.deepEqual((await db.from('contacts').select('id').eq('business_id', 'b')).data.map((r) => r.id), [1]);
  assert.deepEqual((await db.from('products').select('id')).data.map((r) => r.id).sort(), ['p1', 'p3']);
  assert.equal((await db.from('businesses').select('*')).data.length, 1);
});

test('updates and deletes cannot reach another account; inserts get the account', async () => {
  const raw = seed();
  const db = scopedDb(raw, { businessId: 'b', accountId: A1, isAdmin: false, accountIds: [A1] });
  await db.from('contacts').update({ name: 'x' }).eq('business_id', 'b');
  assert.deepEqual(raw.tables.contacts.map((r) => r.name ?? null), ['x', null]);
  await db.from('contacts').insert({ id: 3, business_id: 'b' });
  assert.equal(raw.tables.contacts.find((r) => r.id === 3).account_id, A1);
});

test('the business-wide view of an owner is unchanged; a member without a selection sees only their accounts', async () => {
  const raw = seed();
  assert.equal(scopedDb(raw, { businessId: 'b', accountId: null, isAdmin: true, accountIds: [A1, A2] }), raw);
  const member = scopedDb(raw, { businessId: 'b', accountId: null, isAdmin: false, accountIds: [A2] });
  assert.deepEqual((await member.from('contacts').select('id')).data.map((r) => r.id), [2]);
});
