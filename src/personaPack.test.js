import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeSupabase } from './test-helpers/fakeSupabase.js';
import { loadActivePack, packGaps, mergeAnswers, savePackVersion } from './personaPack.js';

const A1 = '11111111-1111-1111-1111-111111111111';
const A2 = '22222222-2222-2222-2222-222222222222';

test('an account uses its own pack, and falls back to the business-wide pack', async () => {
    const db = fakeSupabase({
        persona_packs: [
            { id: 'biz', business_id: 'b', account_id: null, version: 1, is_active: true, pack: { persona: { voice_tone: 'warm' } } },
            { id: 'own', business_id: 'b', account_id: A1, version: 2, is_active: true, pack: { persona: { voice_tone: 'short' } } },
        ],
    });
    const own = await loadActivePack(db, 'b', A1);
    assert.equal(own.source, 'account'); assert.equal(own.row.id, 'own');
    const fallback = await loadActivePack(db, 'b', A2);
    assert.equal(fallback.source, 'business'); assert.equal(fallback.row.id, 'biz');
    assert.equal((await loadActivePack(fakeSupabase({}), 'b', A1)).source, null);
});

test('gaps list the empty key fields; a missing pack has every gap', () => {
    assert.equal(packGaps(null).length, 8);
    const gaps = packGaps({ persona: { voice_tone: 'warm', typical_greeting: '' }, business_context: { core_offer: 'Shoes', payment_methods: [] }, objection_playbook: [] });
    const keys = gaps.map((g) => g.key);
    assert.ok(!keys.includes('tone') && !keys.includes('products'));
    assert.ok(keys.includes('greeting') && keys.includes('pricing') && keys.includes('faqs'));
    assert.ok(gaps.every((g) => g.question));
});

test('answers are merged into a copy of the pack; unknown and empty answers are ignored', () => {
    const base = { persona: { voice_tone: '' }, business_context: {}, human_handoff_triggers: ['refund'] };
    const { pack, applied } = mergeAnswers(base, { tone: 'Warm, Sheng mix', pricing: 'M-Pesa, cash', handoff: 'angry customer', nonsense: 'x', products: '  ' });
    assert.deepEqual(applied.sort(), ['handoff', 'pricing', 'tone']);
    assert.equal(pack.persona.voice_tone, 'Warm, Sheng mix');
    assert.deepEqual(pack.business_context.payment_methods, ['M-Pesa', 'cash']);
    assert.deepEqual(pack.human_handoff_triggers, ['refund', 'angry customer']);
    assert.equal(base.persona.voice_tone, '');   // the original is untouched
});

test("saving retires only that account's active pack and numbers versions across the business", async () => {
    const db = fakeSupabase({
        persona_packs: [
            { id: 'biz', business_id: 'b', account_id: null, version: 3, is_active: true, pack: {} },
            { id: 'own', business_id: 'b', account_id: A1, version: 4, is_active: true, pack: {} },
        ],
    });
    const saved = await savePackVersion(db, { businessId: 'b', accountId: A1, pack: { persona: {} } });
    assert.equal(saved.version, 5);
    const rows = db.tables.persona_packs;
    assert.equal(rows.find((r) => r.id === 'own').is_active, false);
    assert.equal(rows.find((r) => r.id === 'biz').is_active, true);
    assert.equal(rows.filter((r) => r.account_id === A1 && r.is_active).length, 1);
});
