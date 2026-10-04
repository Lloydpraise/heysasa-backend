import test from 'node:test';
import assert from 'node:assert/strict';
import { AI_PROMPT_CATALOG } from '../aiPromptCatalog.js';
import { getAiPromptConfig } from './aiPromptConfig.js';

function supabaseWithRow(row) {
    const query = {
        select() { return this; },
        eq() { return this; },
        async maybeSingle() { return { data: row, error: null }; },
    };
    return { from: () => query };
}

test('uses the built-in prompt when no active override exists', async () => {
    const config = await getAiPromptConfig(supabaseWithRow(null), 'lead_classifier');
    assert.equal(config.prompt, AI_PROMPT_CATALOG.lead_classifier.prompt);
    assert.equal(config.model, null);
});

test('renders and applies active prompt override settings', async () => {
    const config = await getAiPromptConfig(supabaseWithRow({
        prompt: 'Write a profile for {{business_name}} using the supplied evidence.',
        model: 'gpt-test',
        temperature: 0.4,
        max_tokens: 900,
        is_active: true,
    }), 'voice_reduce', { business_name: 'Sasa Shop' });

    assert.equal(config.prompt, 'Write a profile for Sasa Shop using the supplied evidence.');
    assert.equal(config.model, 'gpt-test');
    assert.equal(config.temperature, 0.4);
    assert.equal(config.max_tokens, 900);
});

test('ignores inactive prompt overrides', async () => {
    const config = await getAiPromptConfig(supabaseWithRow({
        prompt: 'This inactive override must not run.', is_active: false,
    }), 'lead_nlp_extractor');
    assert.equal(config.prompt, AI_PROMPT_CATALOG.lead_nlp_extractor.prompt);
});

test('catalog entries have a system, display name, and built-in prompt', () => {
    assert.equal(Object.keys(AI_PROMPT_CATALOG).length, 21);
    for (const [id, entry] of Object.entries(AI_PROMPT_CATALOG)) {
        assert.ok(entry.system, `${id} is missing its system group`);
        assert.ok(entry.bot_name, `${id} is missing its display name`);
        assert.ok(entry.prompt.length >= 20, `${id} is missing its built-in prompt`);
    }
});
