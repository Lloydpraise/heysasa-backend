import test from 'node:test';
import assert from 'node:assert/strict';

import { pauseCampaignsForDisconnectedInstance } from './disconnectCampaigns.js';

function createSupabase({ data = [], error = null } = {}) {
    const query = {
        filters: [],
        from(table) {
            this.table = table;
            return this;
        },
        update(values) {
            this.values = values;
            return this;
        },
        eq(column, value) {
            this.filters.push([column, value]);
            return this;
        },
        select(columns) {
            this.columns = columns;
            return Promise.resolve({ data, error });
        },
    };
    return query;
}

test('pauses active campaigns for only the disconnected business instance', async () => {
    const supabase = createSupabase({ data: [{ id: 'campaign-1' }] });

    const paused = await pauseCampaignsForDisconnectedInstance(supabase, {
        businessId: 'business-1',
        instanceName: 'whatsapp-1',
    });

    assert.deepEqual(paused, [{ id: 'campaign-1' }]);
    assert.equal(supabase.table, 'campaigns');
    assert.deepEqual(supabase.values, {
        status: 'paused',
        failure_reason: 'whatsapp_disconnected',
        failed_at: null,
    });
    assert.deepEqual(supabase.filters, [
        ['business_id', 'business-1'],
        ['whatsapp_instance_name', 'whatsapp-1'],
        ['status', 'active'],
    ]);
    assert.equal(supabase.columns, 'id');
});

test('surfaces database errors while pausing disconnected-instance campaigns', async () => {
    const databaseError = new Error('database unavailable');
    const supabase = createSupabase({ error: databaseError });

    await assert.rejects(
        pauseCampaignsForDisconnectedInstance(supabase, {
            businessId: 'business-1',
            instanceName: 'whatsapp-1',
        }),
        databaseError,
    );
});
