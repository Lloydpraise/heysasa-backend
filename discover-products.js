// Standalone product discovery, same shape as run-local.js and generate-persona-pack.js:
// started by POST /products/discover (src/productRoutes.js) or by hand:
//
//   BUSINESS_ID=lashesbyshazz node discover-products.js              (real run)
//   BUSINESS_ID=lashesbyshazz node discover-products.js --dry-run    (reads and reports, writes nothing)
//   BUSINESS_ID=lashesbyshazz FORCE=1 node discover-products.js       (re-read everything, not just what is new)
//
// The analyser also runs this automatically after it has separated customers from everyone else.
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { runProductDiscovery, AlreadyRunningError } from './src/services/productDiscoveryRunner.js';
import { FatalRunError } from './src/leadClassification.js';

dotenv.config();

let requested = {};
try {
  requested = process.env.PRODUCT_CONFIG ? JSON.parse(process.env.PRODUCT_CONFIG) : {};
} catch (error) {
  console.error(`✗ Invalid PRODUCT_CONFIG: ${error.message}`);
  process.exit(1);
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY;
const BUSINESS_ID = requested.businessId || process.env.BUSINESS_ID || null;
const FORCE = requested.force === true || process.env.FORCE === '1';
const DRY_RUN = requested.dryRun === true || process.argv.includes('--dry-run');
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

// Same cost constants as run-local.js so usage is billed the same way.
const TEXT_INPUT_COST_PER_TOKEN = 0.000000150;
const TEXT_OUTPUT_COST_PER_TOKEN = 0.000000600;
const BILLING_MULTIPLIER = Number(process.env.AI_BILLING_MULTIPLIER) || 5.0;

const missing = [
  !SUPABASE_URL && 'SUPABASE_URL',
  !SUPABASE_KEY && 'SUPABASE_SERVICE_KEY',
  !OPENAI_KEY && 'OPENAI_API_KEY',
  !BUSINESS_ID && 'BUSINESS_ID',
].filter(Boolean);
if (missing.length) {
  console.error(`✗ Missing required settings: ${missing.join(', ')}`);
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

// One parseable line per call, picked up by src/productRoutes.js and shown in the debug console (area: products).
function emit(level, tag, message) {
  console.log(`@@LOG ${JSON.stringify({ level, area: 'products', event: tag, message, business_id: BUSINESS_ID, details: {} })}`);
}
const log = (tag, msg) => emit('info', tag, msg);
const warn = (tag, msg) => emit('warn', tag, msg);
const err = (tag, msg) => emit('error', tag, msg);

async function recordUsage({ businessId, botId, model, inputType, promptTokens, completionTokens }) {
  const baseline = promptTokens * TEXT_INPUT_COST_PER_TOKEN + completionTokens * TEXT_OUTPUT_COST_PER_TOKEN;
  await supabase.from('ai_usage_log').insert({
    business_id: businessId,
    run_id: crypto.randomUUID(),
    bot_id: botId,
    model,
    input_type: inputType,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    estimated_cost_usd: parseFloat((baseline * BILLING_MULTIPLIER).toFixed(6)),
    created_at: new Date().toISOString(),
  });
}

async function main() {
  log('Products', `${DRY_RUN ? 'Dry run: ' : ''}starting product discovery for ${BUSINESS_ID}${FORCE ? ' (forced: re-reading everything)' : ''}.`);
  const summary = await runProductDiscovery({
    supabase, businessId: BUSINESS_ID, openaiKey: OPENAI_KEY,
    textModel: OPENAI_MODEL, visionModel: process.env.OPENAI_VISION_MODEL || OPENAI_MODEL,
    force: FORCE, dryRun: DRY_RUN, log, warn, err, recordUsage,
  });
  if (summary.reason === 'no_classified_customers') {
    warn('Summary', `⚠️ PRODUCT DISCOVERY has nothing to read for ${BUSINESS_ID}: ${summary.notes[0]}`);
  } else {
    log('Summary', `✅ PRODUCT DISCOVERY COMPLETE for ${BUSINESS_ID}: ${summary.new_discovered} new products found, ${summary.matched_approved + summary.matched_discovered} matched to products already on file, ${summary.images_read} images read, ${summary.images_unreachable} images could not be opened.`);
  }
  if (DRY_RUN && summary.preview) {
    // one readable line per item so it reads well in the admin live log
    for (const p of summary.preview.slice(0, 80)) {
      const bits = [p.decision, p.name, p.matches ? `-> ${p.matches}` : null, p.price != null ? `price ${p.price}` : null, p.category ? `[${p.category}]` : null, p.mentions ? `${p.mentions} mentions` : null].filter(Boolean);
      log('Dry run', bits.join(' | '));
    }
  }
  process.exit(0);
}

main().catch((e) => {
  if (e instanceof AlreadyRunningError) {
    warn('Products', `${e.message} Exiting so two runs do not read the same chats.`);
    process.exit(3);
  }
  err('Main', `Execution failed: ${e.message}`);
  err('Summary', `❌ PRODUCT DISCOVERY FAILED for ${BUSINESS_ID}: ${e.message}${e instanceof FatalRunError ? ' (OpenAI problem, check key and credits)' : ''}`);
  process.exit(1);
});
