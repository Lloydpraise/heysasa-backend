// The ONE place the main backend, the analyser (run-local.js) and the persona pack
// generator record AI spend. It calls the bill_ai_usage SQL function, which prices the
// call (per-model token prices x the runner's multiplier, both editable in admin),
// deducts the business's USD balance and writes the usage + ledger rows atomically.
//
// Adding a new AI runner (e.g. the product runner): call billAiUsage() right after every
// OpenAI response with a stable `runner` id. Unknown runners are auto-registered and billed
// at the default multiplier, and show up in /admin so the multiplier can be set there.
//
// followup-engine/src/lib/billing.js has the same wrapper for that separate package.

const RETRIES = 3;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function billAiUsage(supabase, { businessId, runner, model, promptTokens = 0, cachedTokens = 0, completionTokens = 0, runId = null }) {
    if (!businessId) {
        console.error(`[billing] AI usage with NO business_id was not billed (runner=${runner}, tokens=${promptTokens}+${completionTokens})`);
        return null;
    }
    let lastError = null;
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
        try {
            const { data, error } = await supabase.rpc('bill_ai_usage', {
                p_business_id: businessId,
                p_runner: runner,
                p_model: model || 'default',
                p_prompt_tokens: Math.round(promptTokens || 0),
                p_cached_tokens: Math.round(cachedTokens || 0),
                p_completion_tokens: Math.round(completionTokens || 0),
                p_run_id: runId,
            });
            if (error) throw new Error(error.message);
            return data;
        } catch (e) {
            lastError = e;
            if (attempt < RETRIES) await sleep(400 * attempt);
        }
    }
    // Loud on purpose: the numbers are in the message so the spend can be re-billed by hand.
    console.error(`[billing] FAILED to bill AI usage business=${businessId} runner=${runner} model=${model} prompt=${promptTokens} cached=${cachedTokens} completion=${completionTokens}: ${lastError?.message}`);
    return null;
}
