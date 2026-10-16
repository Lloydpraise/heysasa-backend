// Gives a new business the chat AI's starting skills, so the chat AI is ready the moment the owner switches it on.
//
// The platform keeps a shared library (chat_ai_default_skills). The chat AI only reads a business's OWN rows
// (chat_ai_skills), so until someone copies the library across, a new business has no skills at all.
// Setup does that copy once bundle 1 is done. It costs nothing (no AI call) and never touches a skill the owner
// already has, edited, or switched off: a key that exists is left exactly as it is.

// Pure. Which library skills does this business still lack? `existing` = the business's own rows (any state).
export function planSkillSeed(defaults = [], existing = []) {
    const have = new Set((existing || []).map((row) => row.key));
    return (defaults || [])
        .filter((skill) => skill?.key && skill.title && skill.when_to_use && skill.instructions && !have.has(skill.key))
        .sort((a, b) => (a.sort_order ?? 100) - (b.sort_order ?? 100) || a.key.localeCompare(b.key))
        .map((skill) => ({
            key: skill.key,
            title: skill.title,
            when_to_use: skill.when_to_use,
            instructions: skill.instructions,
            enabled: true,
            source_default_key: skill.key,
        }));
}

// Returns { added, total }. Safe to run twice: existing keys are skipped, and the insert ignores duplicates.
export async function seedChatAiSkills(supabase, businessId) {
    const [defaults, own] = await Promise.all([
        supabase.from('chat_ai_default_skills').select('key, title, when_to_use, instructions, sort_order'),
        supabase.from('chat_ai_skills').select('key').eq('business_id', businessId),
    ]);
    if (defaults.error) throw new Error(`chat skill library unreadable: ${defaults.error.message}`);
    if (own.error) throw new Error(`chat skills unreadable: ${own.error.message}`);

    const rows = planSkillSeed(defaults.data, own.data).map((row) => ({ ...row, business_id: businessId }));
    if (rows.length) {
        const { error } = await supabase.from('chat_ai_skills').upsert(rows, { onConflict: 'business_id,key', ignoreDuplicates: true });
        if (error) throw new Error(`chat skills not saved: ${error.message}`);
    }
    return { added: rows.length, total: (own.data || []).length + rows.length };
}
