import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeSupabase } from '../test-helpers/fakeSupabase.js';
import { countHomeSummary } from './homeRoutes.js';
import { shapeHomeSummary } from './homeSummary.js';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600_000).toISOString();

test('Home summary counts the live numbers the Right now and Do more cards need', async () => {
    const db = fakeSupabase({
        businesses: [{ business_id: 'b', business_type: 'retail', followup_ai_enabled: true, chat_ai_enabled: false, persona_pack_status: 'ready' }],
        business_balances: [{ business_id: 'b', balance_usd: 2 }],
        billing_prices: [{ key: 'usd_kes_rate', value: '130' }],
        follow_up_queue: [
            { business_id: 'b', status: 'sent', processed_at: hoursAgo(2) },
            { business_id: 'b', status: 'ready_to_send', scheduled_at: hoursAgo(-3) },
            { business_id: 'b', status: 'ready_to_send', scheduled_at: hoursAgo(-1) },
            { business_id: 'other', status: 'sent', processed_at: hoursAgo(1) },
        ],
        chat_ai_turns: [
            { business_id: 'b', mode: 'live', status: 'replied', conversation_id: 'c1', created_at: hoursAgo(1) },
            { business_id: 'b', mode: 'live', status: 'replied', conversation_id: 'c1', created_at: hoursAgo(2) },
            { business_id: 'b', mode: 'simulation', status: 'replied', conversation_id: 'c2', created_at: hoursAgo(1) },
        ],
        conversations: [{ business_id: 'b', handover_flag: true, handover_resolved_at: null }],
        contacts: [
            { business_id: 'b', lead_type: 'business', intent_score: 80, lead_state: 'intent', created_at: hoursAgo(3), is_ad_lead: true, last_outbound_at: null, last_inbound_at: hoursAgo(20) },
            { business_id: 'b', lead_type: 'business', intent_score: 50, lead_state: 'engaged', created_at: hoursAgo(500), last_inbound_at: hoursAgo(24 * 20), last_outbound_at: hoursAgo(24 * 21) },
            { business_id: 'b', lead_type: 'business', intent_score: 90, lead_state: 'won', created_at: hoursAgo(500), last_inbound_at: hoursAgo(30), last_outbound_at: hoursAgo(29) },
            { business_id: 'b', lead_type: 'personal', intent_score: 95, lead_state: 'intent', created_at: hoursAgo(1) },
        ],
        products: [{ business_id: 'b', status: 'approved', price: null }, { business_id: 'b', status: 'approved', price: 100 }],
        ad_playbooks: [],
    });
    const out = shapeHomeSummary(await countHomeSummary(db, 'b', NOW));
    assert.equal(out.sent_24h, 1);
    assert.equal(out.ready_to_buy, 1);
    assert.deepEqual(
        { ...out.live, next_send_at: out.live.next_send_at },
        { followups_on: true, chat_on: false, persona_ready: true, queued_now: 2, next_send_at: hoursAgo(-1), chat_replies_24h: 2, chat_chats_24h: 1, new_leads_24h: 1, handoffs_open: 1, balance_kes: 260, messages_left: 520 },
    );
    assert.deepEqual(out.opportunities, { ad_leads_untouched: 1, waiting_for_reply: 1, dormant_leads: 1, products_without_price: 1 });
});
