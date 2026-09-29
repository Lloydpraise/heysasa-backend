import { AI_PROMPT_CATALOG, renderAiPrompt } from '../aiPromptCatalog.js';

const CONFIG_TTL_MS = 60_000;
const configCache = new Map();

export async function getAiPromptConfig(supabase, botId, variables = {}) {
    const builtin = AI_PROMPT_CATALOG[botId];
    if (!builtin) throw new Error(`Unknown AI prompt: ${botId}`);

    let cached = configCache.get(botId);
    if (!cached || Date.now() - cached.at >= CONFIG_TTL_MS) {
        try {
            const { data, error } = await supabase.from('ai_bots_config')
                .select('prompt, model, temperature, max_tokens, is_active')
                .eq('bot_id', botId).maybeSingle();
            if (error) throw error;
            cached = { at: Date.now(), row: data };
        } catch {
            cached = { at: Date.now(), row: null };
        }
        configCache.set(botId, cached);
    }

    const row = cached.row?.is_active ? cached.row : null;
    return {
        prompt: renderAiPrompt(row?.prompt ?? builtin.prompt, variables),
        model: row?.model || null,
        temperature: row?.temperature ?? null,
        max_tokens: row?.max_tokens ?? null,
    };
}
