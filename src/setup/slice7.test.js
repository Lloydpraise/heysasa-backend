import test from 'node:test';
import assert from 'node:assert/strict';
import { planSkillSeed, seedChatAiSkills } from './chatAiSkills.js';
import { createOrchestrator } from './setupOrchestrator.js';

const LIBRARY = [
    { key: 'price_question', title: 'Price questions', when_to_use: 'asks the price', instructions: 'Quote the catalog price.', sort_order: 30 },
    { key: 'first_reply', title: 'First reply', when_to_use: 'writes first', instructions: 'Acknowledge, ask one question.', sort_order: 10 },
    { key: 'broken', title: 'No instructions', when_to_use: 'x', instructions: '', sort_order: 5 },
];

test('planSkillSeed: copies only what the business lacks, in library order, and skips incomplete library rows', () => {
    const plan = planSkillSeed(LIBRARY, [{ key: 'price_question' }]);
    assert.deepEqual(plan.map((r) => r.key), ['first_reply']);
    assert.equal(plan[0].enabled, true);
    assert.equal(plan[0].source_default_key, 'first_reply');
    assert.deepEqual(planSkillSeed(LIBRARY, []).map((r) => r.key), ['first_reply', 'price_question']);
    assert.deepEqual(planSkillSeed([], []), []);
    assert.deepEqual(planSkillSeed(null, null), []);
});

test('planSkillSeed: a skill the owner switched off or edited is still "had", so it is never re-added or reset', () => {
    assert.deepEqual(planSkillSeed(LIBRARY, [{ key: 'first_reply', enabled: false }, { key: 'price_question', enabled: true }]), []);
});

// A tiny fake of the two tables and the upsert the seeder uses.
function fakeSupabase({ library = LIBRARY, own = [], libraryError = null, saveError = null } = {}) {
    const saved = [];
    const from = (table) => {
        if (table === 'chat_ai_default_skills') return { select: async () => ({ data: library, error: libraryError }) };
        if (table === 'chat_ai_skills') {
            return {
                select: () => ({ eq: async () => ({ data: own, error: null }) }),
                upsert: async (rows, options) => { saved.push({ rows, options }); return { error: saveError }; },
            };
        }
        throw new Error(`unexpected table ${table}`);
    };
    return { from, saved };
}

test('seedChatAiSkills: writes the missing skills for this business with duplicate protection', async () => {
    const db = fakeSupabase({ own: [{ key: 'price_question' }] });
    const result = await seedChatAiSkills(db, 'biz-1');
    assert.deepEqual(result, { added: 1, total: 2 });
    assert.equal(db.saved.length, 1);
    assert.equal(db.saved[0].rows[0].business_id, 'biz-1');
    assert.equal(db.saved[0].rows[0].key, 'first_reply');
    assert.deepEqual(db.saved[0].options, { onConflict: 'business_id,key', ignoreDuplicates: true });
});

test('seedChatAiSkills: nothing to add means no write; errors are loud', async () => {
    const full = fakeSupabase({ own: [{ key: 'price_question' }, { key: 'first_reply' }] });
    assert.deepEqual(await seedChatAiSkills(full, 'biz-1'), { added: 0, total: 2 });
    assert.equal(full.saved.length, 0);
    await assert.rejects(() => seedChatAiSkills(fakeSupabase({ libraryError: { message: 'denied' } }), 'b'), /library unreadable/);
    await assert.rejects(() => seedChatAiSkills(fakeSupabase({ saveError: { message: 'nope' } }), 'b'), /not saved/);
});

// Setup runner: the skills are seeded once bundle 1 is done, and a failure there never breaks setup.
function world({ seed }) {
    let t = 1_700_000_000_000;
    const rows = new Map();
    const seeded = [];
    const deps = {
        now: () => t,
        sleep: async (ms) => { t += ms; },
        store: { get: async (id) => rows.get(id) || null, upsert: async (id, patch) => { rows.set(id, { ...(rows.get(id) || {}), business_id: id, ...patch }); } },
        countContacts: async () => 150,
        newestContactCreatedAt: async () => null,
        listContactIdsNewestFirst: async () => Array.from({ length: 150 }, (_, i) => i + 1),
        launch: async () => ({ status: 202, body: {} }),
        latestRun: async () => ({ status: 'completed' }),
        kickPersona: async () => {},
        kickProductImages: async () => {},
        seedChatAiSkills: seed ? async (id) => { seeded.push(id); return seed(id); } : undefined,
    };
    return { deps, rows, seeded };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('orchestrator: chat AI skills are seeded once, after bundle 1', async () => {
    const { deps, seeded } = world({ seed: async () => ({ added: 8, total: 8 }) });
    await (await createOrchestrator(deps, { pollMs: 1000, quietMs: 3000 }).start('biz')).done;
    await settle();
    assert.deepEqual(seeded, ['biz']);   // 150 chats = 2 bundles, still only one seeding
});

test('orchestrator: a failing skill seed never fails setup', async () => {
    const { deps, rows } = world({ seed: async () => { throw new Error('library unreadable'); } });
    await (await createOrchestrator(deps, { pollMs: 1000, quietMs: 3000 }).start('biz')).done;
    await settle();
    assert.equal(rows.get('biz').status, 'done');
    assert.ok(rows.get('biz').home_ready_at);
});

test('orchestrator: works when the seeding dependency is absent (older deployments)', async () => {
    const { deps, rows } = world({ seed: null });
    await (await createOrchestrator(deps, { pollMs: 1000, quietMs: 3000 }).start('biz')).done;
    assert.equal(rows.get('biz').status, 'done');
});
