import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeSupabase } from '../test-helpers/fakeSupabase.js';
import { saveAccountSettings } from './accountSettings.js';

const A1 = '11111111-1111-1111-1111-111111111111';
const A2 = '22222222-2222-2222-2222-222222222222';

test('an account of a business with several numbers saves into accounts.settings', async () => {
    const db = fakeSupabase({
        businesses: [{ business_id: 'b', followup_daily_cap: 40 }],
        accounts: [{ id: A1, business_id: 'b', status: 'connected', settings: { followup_quiet_start: 22 } }, { id: A2, business_id: 'b', status: 'connected', settings: {} }],
    });
    const out = await saveAccountSettings(db, { businessId: 'b', accountId: A1 }, { followup_daily_cap: 10 });
    assert.equal(out.target, 'account');
    assert.deepEqual(db.tables.accounts[0].settings, { followup_quiet_start: 22, followup_daily_cap: 10 });
    assert.equal(db.tables.businesses[0].followup_daily_cap, 40);
});

test('the only account (and the business-wide view) writes the business row and drops overrides', async () => {
    const db = fakeSupabase({
        businesses: [{ business_id: 'b', followup_daily_cap: 40 }],
        accounts: [{ id: A1, business_id: 'b', status: 'connected', settings: { followup_daily_cap: 5, other: 1 } }],
    });
    const out = await saveAccountSettings(db, { businessId: 'b', accountId: A1 }, { followup_daily_cap: 12 });
    assert.equal(out.target, 'business');
    assert.equal(db.tables.businesses[0].followup_daily_cap, 12);
    assert.deepEqual(db.tables.accounts[0].settings, { other: 1 });

    await saveAccountSettings(db, { businessId: 'b', accountId: null }, { followup_daily_cap: 20 });
    assert.equal(db.tables.businesses[0].followup_daily_cap, 20);
});
