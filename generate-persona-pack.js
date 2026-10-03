import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANALYSIS_VERSION, FatalRunError } from './src/leadClassification.js';
import {
    classifyOpenAIFailure,
    getOpenAIAvailabilityState,
    getOpenAICooldownMs,
    noteOpenAIRateLimited,
    setOpenAIUnavailable,
    shouldPauseOpenAIRequest,
} from './src/services/openAiGate.js';
import { AI_PROMPT_CATALOG } from './src/aiPromptCatalog.js';
import { getAiPromptConfig } from './src/services/aiPromptConfig.js';
import {
    squash, redact, isLowValueVoiceMessage, capPerConversation, phraseSupport,
    validateObjectionEntries, cleanTriggers,
} from './src/personaHelpers.js';

dotenv.config();

// ─── Config ───────────────────────────────────────────────────────────────────
// Same pattern as run-local.js: env vars for secrets, a JSON blob (here
// PERSONA_CONFIG instead of ANALYSIS_CONFIG) for what src/index.js passes
// through when it spawns this as a child process.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_KEY   = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY;

let requestedConfig = {};
try {
    requestedConfig = process.env.PERSONA_CONFIG
        ? JSON.parse(process.env.PERSONA_CONFIG)
        : {};
} catch (error) {
    console.error(`✗ Invalid PERSONA_CONFIG: ${error.message}`);
    process.exit(1);
}

// businessId is the key for this whole run — comes from the parent process
// (which read it off the request header/body), falling back to a plain env
// var for manual/local runs (`BUSINESS_ID=lashesbyshazz node generate-persona-pack.js`).
const BUSINESS_ID = requestedConfig.businessId || process.env.BUSINESS_ID || null;
const FORCE = requestedConfig.force === true || process.env.PERSONA_FORCE === 'true';

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

// ─── Thresholds — tune these as real data volume grows ─────────────────────────
const MIN_VOICE_MESSAGES     = 100;   // counted AFTER cleaning (no amounts, acks, other-people chats, per-chat cap), so fewer but better messages than before
const MIN_VOICE_CONVERSATIONS = 25;
const VOICE_SAMPLE_CAP       = 500;   // don't dump the whole history into prompts
const VOICE_BATCH_SIZE       = 130;   // per-batch map step, similar scale to MAX_TRANSCRIPT_MSGS in run-local.js
const MAX_OBJECTION_CONVOS   = 20;    // cap how many tagged conversations we pull full transcripts for
const MAX_PROFILE_CONVOS     = 60;    // these use short summary fields only, so the cap can be higher
const CLOSED_STAGES          = ['Closed', 'Closing']; // 'Closing' is a stray value the analyser has produced — tolerate it here, but it's worth tightening the analyser's enum
const NEGATIVE_SENTIMENT_MAX = -0.3;
const TRANSCRIPT_TAIL        = 30;    // messages of context pulled per flagged conversation

const PAGE_SIZE = 1000;

// ─── Analysis dependency ───────────────────────────────────────────────────────
// The pack is built from what the analyser produced, so it will not run on
// stale or missing analysis: it starts the analyser itself (or waits for one
// already running) and only then generates.
const ANALYSIS_MAX_AGE_HOURS = Number(process.env.PERSONA_ANALYSIS_MAX_AGE_HOURS || 24);
const ANALYSIS_WAIT_MAX_MS   = 3 * 60 * 60 * 1000;
const ANALYSIS_POLL_MS       = 15 * 1000;
const LIVE_WINDOW_MS         = 3 * 60 * 1000;
const MAX_VOICE_PER_CONVERSATION = 20;          // no single chat may dominate the owner's "voice"
const MIN_VOICE_WORDS = 3;                      // "135k", "Ok", "Done" carry no style
const MIN_PHRASE_SUPPORT = 3;                   // a signature phrase must appear in at least this many separate messages
const OBJECTION_TAGS = ['price', 'not_ready', 'found_elsewhere', 'trust_concerns', 'size_availability'];  // 'needs_more_info' is a question, not an objection
const MAX_DUPLICATE_MESSAGES = 3;   // one broadcast sent to 300 people must not become "your voice"

const TEXT_INPUT_COST_PER_TOKEN  = 0.000000150;
const TEXT_OUTPUT_COST_PER_TOKEN = 0.000000600;
const BILLING_MULTIPLIER         = 5.0;

if (!SUPABASE_URL || !SUPABASE_KEY || !OPENAI_KEY) {
    const missing = [
        !SUPABASE_URL && 'SUPABASE_URL',
        !SUPABASE_KEY && 'SUPABASE_SERVICE_KEY',
        !OPENAI_KEY && 'OPENAI_API_KEY',
    ].filter(Boolean);
    console.error(`✗ Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
}
if (!BUSINESS_ID) {
    console.error('✗ No businessId provided (PERSONA_CONFIG.businessId or BUSINESS_ID env var).');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false }
});

// ─── Logging — identical @@LOG convention to run-local.js, area 'persona' so ───
// the parent process's forwardChildLine() picks it up the same way, just
// filterable separately from area 'analysis' in the debug console.
function emit(level, tag, message, details = {}) {
    console.log(`@@LOG ${JSON.stringify({ level, area: 'persona', event: tag, message, business_id: BUSINESS_ID, details })}`);
}
const log  = (tag, msg, details) => emit('info', tag, msg, details);
const warn = (tag, msg, details) => emit('warn', tag, msg, details);
const err  = (tag, msg, details) => emit('error', tag, msg, details);

// ─── Run tracking — reuses enrichment_runs/enrichment_errors, same tables ──────
// run-local.js already writes to, just a different run_type so the two are
// distinguishable in the same history.
let RUN_ID = null;

async function startRun() {
    RUN_ID = crypto.randomUUID();
    try {
        const cutoff = new Date(Date.now() - 6 * 3600000).toISOString();
        await supabase.from('enrichment_runs')
            .update({ status: 'failed', finished_at: new Date().toISOString(), fatal_error: 'stale: process ended without finishing' })
            .eq('run_type', 'persona_pack').eq('business_id', BUSINESS_ID).eq('status', 'running').lt('started_at', cutoff);
        await supabase.from('enrichment_runs').insert({
            id: RUN_ID,
            run_type: 'persona_pack',
            business_id: BUSINESS_ID,
            started_at: new Date().toISOString(),
            status: 'running'
        });
    } catch (e) {
        warn('RunLog', `Could not create run record: ${e.message}`);
    }
    return RUN_ID;
}

// Live phase + heartbeat on the run row (same columns the analyser uses), so
// status can say "waiting for analysis" / "mining voice" instead of just "running".
let phaseWritesEnabled = true;
async function setPhase(phase, extra = {}) {
    log('Phase', phase);
    if (!phaseWritesEnabled || !RUN_ID) return;
    try {
        const { error } = await supabase.from('enrichment_runs')
            .update({ phase, heartbeat_at: new Date().toISOString(), ...extra }).eq('id', RUN_ID);
        if (error) { phaseWritesEnabled = false; warn('Phase', `Phase tracking disabled (${error.message}). Run the run-progress migration.`); }
    } catch (e) { phaseWritesEnabled = false; }
}

async function logItemError(stage, entityType, entityId, message) {
    err(stage, `${entityType} ${entityId}: ${message}`);
    try {
        await supabase.from('enrichment_errors').insert({
            run_id: RUN_ID,
            stage,
            entity_type: entityType,
            entity_id: String(entityId),
            message: String(message).slice(0, 2000),
            created_at: new Date().toISOString()
        });
    } catch (e) {
        warn('RunLog', `Could not persist error row: ${e.message}`);
    }
}

// enrichment_runs' extra columns (structural_enriched, nlp_enriched, etc.)
// belong to run-local.js's own counting scheme — this run_type doesn't use
// them. Only status/finished_at/fatal_error are real columns here; anything
// else worth recording (message counts, section sizes) goes to console via
// log() instead, visible in the debug console under area 'persona'.
async function finishRun(status, { fatalError, summary } = {}) {
    const base = { status, finished_at: new Date().toISOString() };
    if (fatalError) base.fatal_error = String(fatalError).slice(0, 2000);
    try {
        const { error } = await supabase.from('enrichment_runs')
            .update({ ...base, phase: 'done', heartbeat_at: base.finished_at, ...(summary ? { summary } : {}) })
            .eq('id', RUN_ID);
        if (!error) return;
        // A missing column must never leave the run stuck on "running".
        const { error: fallbackError } = await supabase.from('enrichment_runs').update(base).eq('id', RUN_ID);
        if (fallbackError) warn('RunLog', `Could not finalize run record: ${fallbackError.message}`);
    } catch (e) {
        warn('RunLog', `Could not finalize run record: ${e.message}`);
    }
}

// ─── Pagination helper — identical to run-local.js ─────────────────────────────
async function fetchAllPages(buildQuery) {
    let allRows = [];
    let from = 0;
    while (true) {
        const { data, error } = await buildQuery(from, from + PAGE_SIZE - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;
        allRows = allRows.concat(data);
        if (data.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
    }
    return allRows;
}

// ─── Billing / usage — same table and multiplier as run-local.js, distinct bot_id ──
async function logAiUsage(promptTokens, completionTokens, purpose) {
    try {
        const baselineCost = parseFloat((
            promptTokens     * TEXT_INPUT_COST_PER_TOKEN +
            completionTokens * TEXT_OUTPUT_COST_PER_TOKEN
        ).toFixed(6));
        const operationalCost = parseFloat((baselineCost * BILLING_MULTIPLIER).toFixed(6));

        await supabase.from('ai_usage_log').insert({
            business_id:        BUSINESS_ID,
            run_id:             RUN_ID,
            bot_id:             'persona_pack_generator',
            model:              OPENAI_MODEL,
            input_type:         'text',
            prompt_tokens:      promptTokens,
            completion_tokens:  completionTokens,
            total_tokens:       promptTokens + completionTokens,
            estimated_cost_usd: operationalCost,
            created_at:         new Date().toISOString()
        });
        return operationalCost;
    } catch (e) {
        warn('Usage', `Log failed (${purpose}): ${e.message}`);
        return 0;
    }
}

// ─── OpenAI call wrapper — same shape as run-local.js's runNLPExtraction, ──────
// generalized so every section-builder below can reuse it.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function callOpenAI(systemPrompt, userPrompt, { json = true, maxTokens = 900, temperature = 0.2, purpose = 'unspecified', businessName = BUSINESS_ID, attempts = 4 } = {}) {
    const promptConfig = AI_PROMPT_CATALOG[purpose]
        ? await getAiPromptConfig(supabase, purpose, { business_name: businessName })
        : null;
    systemPrompt = promptConfig?.prompt ?? systemPrompt;
    maxTokens = promptConfig?.max_tokens ?? maxTokens;
    temperature = promptConfig?.temperature ?? temperature;
    if (shouldPauseOpenAIRequest()) {
        const state = getOpenAIAvailabilityState();
        throw new FatalRunError(state.message || 'OpenAI Unavailable');
    }
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 45000);
        try {
            // A rate limit elsewhere in this process: back off together.
            const cooldown = getOpenAICooldownMs();
            if (cooldown > 0) await sleep(Math.min(cooldown, 30000));
            if (shouldPauseOpenAIRequest()) {
                const state = getOpenAIAvailabilityState();
                throw new FatalRunError(state.message || 'OpenAI Unavailable');
            }

            const res = await fetch('https://api.openai.com/v1/chat/completions', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
                signal:  controller.signal,
                body: JSON.stringify({
                    model: promptConfig?.model ?? OPENAI_MODEL,
                    max_tokens: maxTokens,
                    temperature,
                    ...(json ? { response_format: { type: 'json_object' } } : {}),
                    prompt_cache_key: `persona:${BUSINESS_ID}`.slice(0, 64),
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt }
                    ]
                })
            });
            clearTimeout(timeout);

            if (!res.ok) {
                const errorBody = await res.text();
                const failure = classifyOpenAIFailure({ status: res.status, bodyText: errorBody, headers: res.headers });
                // Exhausted credits / a rejected key will not fix themselves: stop, do not retry.
                if (failure.kind === 'quota' || failure.kind === 'auth') {
                    setOpenAIUnavailable({
                        status: res.status,
                        reason: errorBody.slice(0, 300) || 'OpenAI rejected the request',
                        message: "cant call ai on debug 'openai 429 or 401 error'",
                    });
                    throw new FatalRunError(`OpenAI rejected the request (${res.status}, ${failure.kind}, ${purpose}): ${errorBody.slice(0, 200)}. Check OPENAI_API_KEY, credits and the project's spend limit.`);
                }
                // A per-minute rate limit clears by itself: wait it out, then retry.
                if (failure.kind === 'rate_limit') {
                    noteOpenAIRateLimited(failure.retryAfterMs);
                    throw new Error(`OpenAI rate limited (${res.status}, ${purpose}); retrying after cooldown`);
                }
                throw new Error(`OpenAI returned ${res.status} (${purpose}): ${errorBody.slice(0, 500)}`);
            }

            const body  = await res.json();
            const usage = body.usage || {};
            await logAiUsage(usage.prompt_tokens || 0, usage.completion_tokens || 0, purpose);

            const raw = body.choices?.[0]?.message?.content?.trim() || '';
            if (!json) return raw;

            const clean = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
            return JSON.parse(clean);
        } catch (e) {
            clearTimeout(timeout);
            if (e instanceof FatalRunError) throw e;
            lastError = e;
            if (attempt < attempts) {
                warn('OpenAI', `Attempt ${attempt}/${attempts} failed (${purpose}): ${e.message}. Retrying...`);
                await sleep(Math.max(2000 * attempt, getOpenAICooldownMs()));
            }
        }
    }
    throw new Error(`callOpenAI failed after ${attempts} attempts (${purpose}): ${lastError.message}`);
}

// ─── Shared text helper — same extraction logic as run-local.js's buildTranscript ──
function messageText(m) {
    // Everything that reaches a prompt, a grounding check or the saved pack goes through redact().
    return redact(m.content?.text || (typeof m.content === 'string' ? m.content : '') || '');
}

function buildTranscript(messages) {
    return messages
        .map(m => {
            const isCustomer = m.direction === 'in' || m.direction === 'inbound';
            // OWNER = a human on the business side. Automated replies are labelled so they are never learned as the owner's voice.
            const role = isCustomer ? 'CUSTOMER' : (m.agent_role && m.agent_role !== 'human' ? 'AUTO' : 'OWNER');
            const text = messageText(m) || (m.type && m.type !== 'text' ? `[${m.type}]` : '');
            return `${role}: ${text}`;
        })
        .filter(line => !line.endsWith(': '))
        .join('\n');
}

function evenSample(arr, cap) {
    if (arr.length <= cap) return arr;
    const step = arr.length / cap;
    const out = [];
    for (let i = 0; i < cap; i++) out.push(arr[Math.floor(i * step)]);
    return out;
}

function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}


// A phrase is grounded when it really occurs in the source text. Anything the
// model produced that fails this is dropped, never shipped as "your voice".
function isGrounded(phrase, corpusSquashed) {
    const q = squash(phrase);
    return q.length >= 3 && corpusSquashed.includes(q);
}

function rankedByFrequency(list) {
    const counts = new Map();
    for (const item of list) {
        const key = String(item || '').trim();
        if (key) counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

function capDuplicates(messages, max) {
    const seen = new Map();
    return messages.filter(m => {
        const key = messageText(m).toLowerCase().replace(/\s+/g, ' ').trim();
        const n = (seen.get(key) || 0) + 1;
        seen.set(key, n);
        return n <= max;
    });
}

// ─── Step 0: load business, flip status to running ────────────────────────────
async function loadBusiness() {
    const { data: business, error } = await supabase
        .from('businesses')
        .select('business_id, name, industry, business_type, currency, website_url, system_prompt, sales_persona, business_sops_and_kb, business_knowledge, persona_pack_status')
        .eq('business_id', BUSINESS_ID)
        .maybeSingle();
    if (error) throw new Error(`Business lookup failed: ${error.message}`);
    if (!business) throw new Error(`No business found for business_id ${BUSINESS_ID}`);

    if (business.persona_pack_status === 'running' && !FORCE) {
        // Only refuse if another persona run is genuinely alive; a crashed run must not block forever.
        const { data: others } = await supabase.from('enrichment_runs')
            .select('id, started_at, heartbeat_at')
            .eq('run_type', 'persona_pack').eq('business_id', BUSINESS_ID).eq('status', 'running').neq('id', RUN_ID);
        const alive = (others || []).find(r => Date.now() - new Date(r.heartbeat_at || r.started_at).getTime() < 15 * 60 * 1000);
        if (alive) throw new Error(`A persona pack run is already in progress for ${BUSINESS_ID}.`);
        warn('System', `persona_pack_status was 'running' but no live run exists (previous run crashed) — continuing.`);
    }

    await supabase.from('businesses').update({ persona_pack_status: 'running' }).eq('business_id', BUSINESS_ID);
    return business;
}

// ─── Analysis readiness + auto-trigger ─────────────────────────────────────────
// The latest COMPLETED full analyser run for this business. Runs from the old
// analyser have no summary and therefore never count as ready.
async function getAnalysisReadiness() {
    const { data: run, error } = await supabase.from('enrichment_runs')
        .select('id, finished_at, summary')
        .eq('business_id', BUSINESS_ID).eq('run_type', 'full_pass').eq('status', 'completed')
        .not('summary', 'is', null)
        .order('finished_at', { ascending: false }).limit(1).maybeSingle();
    if (error || !run) return { ready: false, reason: 'no_completed_analysis' };
    if (run.summary?.healthy !== true) return { ready: false, reason: 'last_analysis_had_too_many_errors', runId: run.id, summary: run.summary };
    const ageHours = (Date.now() - new Date(run.finished_at).getTime()) / 3600000;
    if (ageHours > ANALYSIS_MAX_AGE_HOURS) return { ready: false, reason: `analysis_older_than_${ANALYSIS_MAX_AGE_HOURS}h`, ageHours };
    return { ready: true, ageHours, summary: run.summary };
}

async function findLiveAnalysisRun() {
    const { data } = await supabase.from('enrichment_runs')
        .select('id, started_at, heartbeat_at, phase, progress_done, progress_total')
        .eq('business_id', BUSINESS_ID).in('run_type', ['full_pass', 'contact_pass']).eq('status', 'running')
        .order('started_at', { ascending: false }).limit(5);
    return (data || []).find(r => Date.now() - new Date(r.heartbeat_at || r.started_at).getTime() < LIVE_WINDOW_MS) || null;
}

async function waitForLiveAnalysis() {
    const startedWaiting = Date.now();
    let lastLogged = 0;
    while (Date.now() - startedWaiting < ANALYSIS_WAIT_MAX_MS) {
        const live = await findLiveAnalysisRun();
        if (!live) return;
        if (Date.now() - lastLogged > 60000) {
            lastLogged = Date.now();
            const where = live.progress_total ? ` (${live.phase || 'working'}: ${live.progress_done}/${live.progress_total})` : '';
            log('Analysis', `Waiting for the analyser that is already running${where}...`);
            await setPhase('waiting_for_analysis');
        }
        await new Promise(r => setTimeout(r, ANALYSIS_POLL_MS));
    }
    throw new Error('Timed out waiting for the running analysis to finish.');
}

function runAnalyser() {
    return new Promise((resolve) => {
        const script = fileURLToPath(new URL('./run-local.js', import.meta.url));
        const child = spawn(process.execPath, [script], {
            cwd: path.dirname(script),
            env: { ...process.env, ANALYSIS_CONFIG: JSON.stringify({ businessId: BUSINESS_ID }) },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { try { child.kill(); } catch {} });

        // Keep this run visibly alive while the analyser works, so nothing mistakes a long wait for a dead run.
        const heartbeat = setInterval(async () => {
            try { await supabase.from('enrichment_runs').update({ heartbeat_at: new Date().toISOString() }).eq('id', RUN_ID); } catch {}
        }, 30000);

        // The analyser's own @@LOG lines pass straight through, so its progress
        // shows up in the same console under area 'analysis'.
        const pipe = (stream, isErr) => {
            let pending = '';
            stream.on('data', (chunkData) => {
                pending += chunkData.toString();
                const lines = pending.split(/\r?\n/);
                pending = lines.pop() || '';
                for (const line of lines) {
                    if (line.startsWith('@@LOG ')) console.log(line);
                    else if (isErr && line.trim()) err('Analysis', line.trim());
                }
            });
        };
        pipe(child.stdout, false);
        pipe(child.stderr, true);
        child.on('error', (e) => { clearInterval(heartbeat); err('Analysis', `Could not start the analyser: ${e.message}`); resolve(1); });
        child.on('close', (code) => { clearInterval(heartbeat); resolve(code); });
    });
}

async function ensureAnalysisReady() {
    let readiness = await getAnalysisReadiness();
    if (readiness.ready) {
        log('Analysis', `Analysis is current (finished ${readiness.ageHours.toFixed(1)}h ago) — using it.`);
        return { ranAnalyser: false, ...readiness };
    }
    log('Analysis', `Analysis is not ready (${readiness.reason}) — the persona pack depends on it.`);

    await setPhase('analysis');
    if (await findLiveAnalysisRun()) {
        log('Analysis', 'An analysis is already running for this business — waiting for it to finish.');
        await waitForLiveAnalysis();
    } else {
        log('Analysis', 'Starting the analyser now. The pack generates automatically when it completes.');
        const code = await runAnalyser();
        if (code === 3) await waitForLiveAnalysis();   // another run took the lock a moment earlier
        else if (code !== 0) throw new Error(`The analyser exited with code ${code}. The persona pack needs its output, so nothing was generated.`);
    }

    readiness = await getAnalysisReadiness();
    if (!readiness.ready) {
        // Never build a pack from partial or missing analysis.
        throw new Error(
            `The analysis this pack depends on did not finish cleanly (${readiness.reason}). ` +
            'Refusing to build a pack from partial or missing analysis. ' +
            'Check enrichment_errors for the latest analyser run and re-run it. ' +
            'If the analyser reports completed, confirm both migrations have been run (the run summary column).'
        );
    }
    return { ranAnalyser: true, ...readiness };
}

// ─── Step 1: business-only scope + the human-authored voice material ───────────
// Everything the pack learns from is restricted to confirmed business contacts
// whose conversations the analyser flagged is_business_chat = true. Personal,
// junk and unknown chats never reach tone mining, objections, profiles or closing.
let scopeCache = null;
async function getBusinessScope() {
    if (scopeCache) return scopeCache;

    const contacts = await fetchAllPages((from, to) =>
        supabase.from('contacts')
            .select('id, analysis_version')
            .eq('business_id', BUSINESS_ID)
            .eq('lead_type', 'business')   // analyser v3: 'business' = a real customer or prospect; vendor/staff/personal/junk are separate types
            .order('id')
            .range(from, to));
    const businessContactIds = contacts.map(c => c.id);
    const analysedContactIds = new Set(contacts.filter(c => c.analysis_version === ANALYSIS_VERSION).map(c => c.id));

    let businessConvs = [];
    for (const batch of chunk(businessContactIds, 300)) {
        const rows = await fetchAllPages((from, to) =>
            supabase.from('conversations')
                .select('id, contact_id')
                .eq('business_id', BUSINESS_ID)
                .eq('is_business_chat', true)
                .in('contact_id', batch)
                .order('id')
                .range(from, to));
        businessConvs = businessConvs.concat(rows);
    }

    scopeCache = {
        businessContactIds,
        businessConvs,
        // only conversations whose analysis was produced by the current analyser rules
        analysedConvIds: businessConvs.filter(c => analysedContactIds.has(c.contact_id)).map(c => c.id),
    };
    return scopeCache;
}

async function fetchVoiceMessages() {
    const scope = await getBusinessScope();
    const funnel = {
        business_contacts: scope.businessContactIds.length,   // customers and prospects only
        business_conversations: scope.businessConvs.length,
        human_messages: 0,
        with_text: 0,
        after_quality_filter: 0,
        after_duplicate_cap: 0,
        after_conversation_cap: 0,
        conversations_covered: 0,
    };
    if (!scope.businessContactIds.length || !scope.businessConvs.length) return { messages: [], funnel };

    const flaggedContacts = new Set(scope.businessConvs.map(c => c.contact_id));
    const convByContact = new Map(scope.businessConvs.map(c => [c.contact_id, c.id]));
    const contactIds = scope.businessContactIds.filter(id => flaggedContacts.has(id));

    // Outbound-only chats (broadcasts, one-sided notes) are not conversations with a customer.
    const repliedContacts = new Set();
    for (const batch of chunk(contactIds, 300)) {
        const rows = await fetchAllPages((from, to) =>
            supabase.from('messages')
                .select('id, contact_id')
                .eq('business_id', BUSINESS_ID)
                .eq('direction', 'in')
                .in('contact_id', batch)
                .order('id')
                .range(from, to));
        for (const r of rows) repliedContacts.add(r.contact_id);
    }

    let all = [];
    for (const batch of chunk(contactIds.filter(id => repliedContacts.has(id)), 300)) {
        const rows = await fetchAllPages((from, to) =>
            supabase.from('messages')
                .select('id, content, type, created_at, conversation_id, contact_id')
                .eq('business_id', BUSINESS_ID)
                .eq('direction', 'out')
                .eq('agent_role', 'human')
                .in('contact_id', batch)
                .order('created_at', { ascending: true })
                .order('id', { ascending: true })
                .range(from, to));
        all = all.concat(rows);
    }
    funnel.human_messages = all.length;

    const withText = all
        .map(m => ({ ...m, conversation_id: m.conversation_id || convByContact.get(m.contact_id) }))
        .filter(m => messageText(m).trim().length > 0)
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    funnel.with_text = withText.length;

    // Bare amounts, one-word acknowledgements and identifiers say nothing about how the owner talks.
    const substantive = withText.filter(m => !isLowValueVoiceMessage(messageText(m), MIN_VOICE_WORDS));
    funnel.after_quality_filter = substantive.length;

    const deduped = capDuplicates(substantive, MAX_DUPLICATE_MESSAGES);
    funnel.after_duplicate_cap = deduped.length;

    const messages = capPerConversation(deduped, MAX_VOICE_PER_CONVERSATION, evenSample);
    funnel.after_conversation_cap = messages.length;
    funnel.conversations_covered = new Set(messages.map(m => m.conversation_id)).size;
    return { messages, funnel };
}

// Names the actual bottleneck instead of a bare "below threshold".
function explainShortfall(funnel) {
    if (!funnel.business_contacts) return 'no_customer_contacts: no contacts are classified as customer chats yet, so the analyser has not separated them.';
    if (!funnel.business_conversations) return 'no_business_conversations: business contacts exist but none of their conversations are flagged as business chats.';
    if (!funnel.human_messages) return 'no_human_messages: the customer chats contain no messages sent by a human (only inbound or automated), or no customer ever replied.';
    return `not_enough_history: ${funnel.after_conversation_cap} usable messages across ${funnel.conversations_covered} customer conversations (need ${MIN_VOICE_MESSAGES} and ${MIN_VOICE_CONVERSATIONS}).`;
}

// ─── Step 2: voice/tone — map-reduce over the sampled messages ─────────────────
async function extractVoiceBatch(batch, businessName) {
    const transcript = batch.map(m => messageText(m)).filter(Boolean).join('\n---\n');
    const systemPrompt = ''; // wording lives in src/aiPromptCatalog.js, keyed by `purpose` below

    return callOpenAI(systemPrompt, `MESSAGES (one per line, separated by ---):\n${transcript}`, {
        maxTokens: 700, temperature: 0.1, purpose: 'voice_batch_extract', businessName
    });
}

async function reduceVoiceSignals(batchResults, businessName, corpus, pool = []) {
    const totals = { english: 0, swahili: 0, sheng: 0 };
    const greetings = [], closings = [], phrases = [], emojiNotes = [], lengthNotes = [];
    for (const b of batchResults) {
        totals.english += b.language_counts?.english || 0;
        totals.swahili += b.language_counts?.swahili || 0;
        totals.sheng   += b.language_counts?.sheng   || 0;
        greetings.push(...(b.greetings_seen || []));
        closings.push(...(b.closings_seen || []));
        phrases.push(...(b.signature_phrases || []));
        if (b.emoji_observations) emojiNotes.push(b.emoji_observations);
        if (b.sentence_length_observations) lengthNotes.push(b.sentence_length_observations);
    }
    const totalLangCount = totals.english + totals.swahili + totals.sheng || 1;
    const language_mix = {
        english: Math.round((totals.english / totalLangCount) * 100) / 100,
        swahili: Math.round((totals.swahili / totalLangCount) * 100) / 100,
        sheng:   Math.round((totals.sheng   / totalLangCount) * 100) / 100,
    };

    const systemPrompt = ''; // wording lives in src/aiPromptCatalog.js, keyed by `purpose` below

    const userPrompt = [
        `GREETINGS SEEN ACROSS ALL BATCHES:\n${JSON.stringify([...new Set(greetings)].slice(0, 40))}`,
        `CLOSINGS SEEN:\n${JSON.stringify([...new Set(closings)].slice(0, 40))}`,
        `SIGNATURE PHRASE CANDIDATES:\n${JSON.stringify([...new Set(phrases)].slice(0, 60))}`,
        `EMOJI NOTES:\n${emojiNotes.join(' | ')}`,
        `SENTENCE LENGTH NOTES:\n${lengthNotes.join(' | ')}`,
        `COMPUTED LANGUAGE MIX (for your reference, don't repeat it): ${JSON.stringify(language_mix)}`
    ].join('\n\n');

    const persona = await callOpenAI(systemPrompt, userPrompt, { maxTokens: 900, temperature: 0.4, purpose: 'voice_reduce', businessName });

    // Grounding: every phrase, greeting and closing must really occur in the
    // owner's own messages. Anything the model invented or reworded is dropped
    // and replaced with the most frequent REAL one.
    const poolTexts = pool.map(messageText);
    const wordsOf = (x) => String(x).trim().split(/\s+/).filter(Boolean).length;
    // A signature phrase must really occur, be short, and be a habit (several separate messages), not a one-off or a canned paragraph.
    const isHabit = (x) => isGrounded(x, corpus) && wordsOf(x) <= 8 && phraseSupport(x, poolTexts) >= MIN_PHRASE_SUPPORT;
    const realOnly = (list) => rankedByFrequency(list).filter(x => isGrounded(x, corpus));
    const modelPhrases = Array.isArray(persona.signature_phrases) ? persona.signature_phrases : [];
    const signature = modelPhrases.filter(isHabit);
    for (const real of realOnly(phrases).filter(isHabit)) {
        if (signature.length >= 8) break;
        if (!signature.some(x => squash(x) === squash(real))) signature.push(real);
    }
    // Most habitual first, so the strongest voice markers lead.
    signature.sort((a, b) => phraseSupport(b, poolTexts) - phraseSupport(a, poolTexts));
    const realGreetings = realOnly(greetings);
    const realClosings = realOnly(closings);
    const keepOrReplace = (chosen, real) => (chosen && isGrounded(chosen, corpus)) ? chosen : (real[0] || '');
    log('Voice', `Grounding check: kept ${signature.length} signature phrases that appear in ${MIN_PHRASE_SUPPORT}+ separate messages (${modelPhrases.length - modelPhrases.filter(isHabit).length} invented, reworded, one-off or too long dropped).`);

    return {
        ...persona,
        signature_phrases: signature,
        typical_greeting: keepOrReplace(persona.typical_greeting, realGreetings),
        typical_closing: keepOrReplace(persona.typical_closing, realClosings),
        language_mix
    };
}

async function buildPersonaSection(sampledMessages, businessName, corpus, pool = sampledMessages) {
    const batches = chunk(sampledMessages, VOICE_BATCH_SIZE);
    log('Voice', `Mining tone across ${sampledMessages.length} sampled messages in ${batches.length} batches...`);
    const batchResults = [];
    let failedBatches = 0;
    for (const batch of batches) {
        try {
            batchResults.push(await extractVoiceBatch(batch, businessName));
        } catch (e) {
            if (e instanceof FatalRunError) throw e;
            failedBatches++;
            warn('Voice', `Batch extraction failed, skipping this batch: ${e.message}`);
        }
    }
    if (!batchResults.length) throw new Error('All voice-mining batches failed — cannot build persona section.');
    if (failedBatches / batches.length > 0.3) {
        throw new Error(`${failedBatches} of ${batches.length} voice batches failed. Refusing to build a persona from a partial sample.`);
    }
    return reduceVoiceSignals(batchResults, businessName, corpus, pool);
}

// ─── Step 3: business_context — mostly hard facts, not chat-mined ─────────────
async function fetchProducts() {
    return fetchAllPages((from, to) =>
        supabase.from('products')
            .select('title, description_short, price, key_features')
            .eq('business_id', BUSINESS_ID)
            .eq('is_visible', true)
            .range(from, to));
}

async function buildBusinessContextSection(business, sampledMessages, corpus) {
    const products = await fetchProducts();
    const productsCatalog = products.length
        ? products.map(p => `- ${p.title}${p.price ? ` (${p.price})` : ''}${p.description_short ? `: ${p.description_short}` : ''}`).join('\n')
        : 'No products registered.';

    // Light grounding pass over a small slice of real messages, just to
    // surface recurring value-prop language — capped small on purpose,
    // this section leans on hard facts, not volume.
    const phraseSample = evenSample(sampledMessages, 150).map(messageText).filter(Boolean).join('\n');

    const systemPrompt = ''; // wording lives in src/aiPromptCatalog.js, keyed by `purpose` below

    const userPrompt = [
        `BUSINESS: ${business.name} | industry: ${business.industry || 'unknown'} | type: ${business.business_type || 'unknown'} | currency: ${business.currency || 'unknown'}`,
        business.business_sops_and_kb ? `EXISTING SOP/KB NOTES:\n${business.business_sops_and_kb}` : '',
        business.sales_persona ? `EXISTING SALES PERSONA NOTES:\n${business.sales_persona}` : '',
        `PRODUCT CATALOG:\n${productsCatalog}`,
        `SAMPLE OF REAL OUTBOUND MESSAGES (for recurring language only):\n${phraseSample.slice(0, 6000)}`
    ].filter(Boolean).join('\n\n');

    const context = await callOpenAI(systemPrompt, userPrompt, { maxTokens: 700, temperature: 0.2, purpose: 'business_context', businessName: business.name });

    // Payment methods are only allowed if they appear in real messages, the catalog or the owner's own notes.
    const groundingText = corpus + squash([productsCatalog, business.business_sops_and_kb, business.sales_persona].filter(Boolean).join(' '));
    const claimed = Array.isArray(context.payment_methods) ? context.payment_methods : [];
    context.payment_methods = claimed.filter(m => isGrounded(m, groundingText));
    if (claimed.length !== context.payment_methods.length) {
        log('Context', `Dropped ${claimed.length - context.payment_methods.length} payment method(s) with no evidence in the messages or catalog.`);
    }
    return context;
}

// ─── Step 4: objection_playbook — precision over volume, from conversation_enrichment ──
async function fetchObjectionConversations() {
    // Customer/prospect chats analysed under the current analyser rules only. This is what
    // keeps stale analysis, supplier chats and the owner's own purchases out of the pack.
    const convIds = (await getBusinessScope()).analysedConvIds;
    if (!convIds.length) return [];

    // Small table; pulled plainly and filtered in JS so a PostgREST filter can't silently misfire.
    const CONV_BATCH = 300;
    let rows = [];
    for (const batch of chunk(convIds, CONV_BATCH)) {
        const { data, error } = await supabase
            .from('conversation_enrichment')
            .select('conversation_id, objection_tags, price_objection')
            .in('conversation_id', batch);
        if (error) throw new Error(`conversation_enrichment lookup failed: ${error.message}`);
        rows = rows.concat(data || []);
    }
    // Real objections only. 'needs_more_info' is a question and pre_purchase_questions are questions, so
    // neither selects a chat; they used to crowd out the price and not_ready chats.
    const relevant = rows
        .map(r => ({ ...r, real_tags: (r.objection_tags || []).filter(t => OBJECTION_TAGS.includes(t)) }))
        .filter(r => r.real_tags.length > 0 || r.price_objection === true);
    relevant.sort((a, b) =>
        (b.price_objection === true) - (a.price_objection === true) ||
        b.real_tags.length - a.real_tags.length);
    return relevant.slice(0, MAX_OBJECTION_CONVOS);
}

async function fetchTailTranscript(conversationId, limit = TRANSCRIPT_TAIL) {
    const { data, error } = await supabase
        .from('messages')
        .select('direction, type, content, created_at, agent_role')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(limit);
    if (error) throw new Error(`Message fetch failed for conversation ${conversationId}: ${error.message}`);
    return buildTranscript((data || []).reverse());
}

// Text of the lines on one side of a transcript, squashed for grounding checks.
function sideCorpus(transcripts, label) {
    const prefix = `${label}: `;
    return squash(transcripts.flatMap(t => t.split('\n')).filter(l => l.startsWith(prefix)).map(l => l.slice(prefix.length)).join(' '));
}

async function buildObjectionPlaybook(business) {
    const tagged = await fetchObjectionConversations();
    if (!tagged.length) {
        warn('Objections', 'No customer conversations with a real objection tag (price, not_ready, found_elsewhere, trust_concerns, size_availability) found — returning empty playbook.');
        return [];
    }

    const examples = [];
    const transcripts = [];
    for (const row of tagged) {
        try {
            const transcript = await fetchTailTranscript(row.conversation_id);
            transcripts.push(transcript);
            // Per-example cap so one long chat can't push the others out of the prompt.
            examples.push(`--- EXAMPLE (flagged: ${row.real_tags.join(', ') || 'price'}${row.price_objection ? ', price objection' : ''}) ---\n${transcript.slice(-1400)}`);
        } catch (e) {
            warn('Objections', `Skipping conversation ${row.conversation_id}: ${e.message}`);
        }
    }
    if (!examples.length) return [];

    const userPrompt = `TAGGED CONVERSATION EXAMPLES:\n${examples.join('\n\n').slice(0, 14000)}`;
    // The wording of this prompt lives in src/aiPromptCatalog.js (objection_playbook). AUTO lines are automated replies and must be ignored.
    const result = await callOpenAI('', userPrompt + '\n\nLines starting "AUTO:" are automated replies. Ignore them.', { maxTokens: 1800, temperature: 0.2, purpose: 'objection_playbook', businessName: business.name });

    // Every entry has to be backed by real words on the right side of a real conversation.
    const { kept, dropped } = validateObjectionEntries(result.objection_playbook, {
        customerCorpus: sideCorpus(transcripts, 'CUSTOMER'),
        ownerCorpus: sideCorpus(transcripts, 'OWNER'),
    });
    if (dropped.length) warn('Objections', `Dropped ${dropped.length} playbook entr${dropped.length === 1 ? 'y' : 'ies'} that were not grounded in the right side of a real chat.`, { dropped });
    return kept;
}

// ─── Step 5: customer_profiles — cluster on signals the analyser already wrote ──
// Cheap by design: these are short strings the analyser already produced
// (customer_intent, psychology, vibe_check, context_summary), not raw
// transcripts, so this reuses the analyser's own work instead of re-reading chat.
async function fetchProfileSignals() {
    const scope = await getBusinessScope();
    let rows = [];
    for (const batch of chunk(scope.analysedConvIds, 300)) {
        const { data, error } = await supabase.from('conversations')
            .select('id, customer_intent, psychology, vibe_check, context_summary, lead_quality')
            .in('id', batch)
            .not('customer_intent', 'is', null);
        if (error) throw new Error(`conversation signals lookup failed: ${error.message}`);
        rows = rows.concat(data || []);
    }
    rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    // Spread evenly instead of taking whichever rows happen to come first.
    return evenSample(rows, MAX_PROFILE_CONVOS).map(({ id, ...signal }) => signal);
}

async function buildCustomerProfiles(business) {
    const signals = await fetchProfileSignals();
    if (!signals.length) {
        warn('Profiles', 'No conversations with customer_intent/psychology set yet — returning empty customer_profiles.');
        return [];
    }

    const systemPrompt = ''; // wording lives in src/aiPromptCatalog.js, keyed by `purpose` below

    const userPrompt = `PER-CONVERSATION SIGNALS:\n${JSON.stringify(signals, null, 2).slice(0, 10000)}`;
    const result = await callOpenAI(systemPrompt, userPrompt, { maxTokens: 1200, temperature: 0.3, purpose: 'customer_profiles', businessName: business.name });
    return result.customer_profiles || [];
}

// ─── Step 6: sentiment_response_map — prescriptive, grounded in the other sections ──
const SENTIMENT_KEYS = ['positive', 'neutral', 'hesitant', 'price_resistant', 'time_poor', 'trust_deficit', 'negative', 'aggressive'];

async function buildSentimentMap(business, persona, businessContext, objectionPlaybook) {
    const systemPrompt = ''; // wording lives in src/aiPromptCatalog.js, keyed by `purpose` below

    const userPrompt = [
        `PERSONA (voice/tone):\n${JSON.stringify(persona)}`,
        `BUSINESS CONTEXT:\n${JSON.stringify(businessContext)}`,
        `OBJECTION PLAYBOOK (for consistency):\n${JSON.stringify(objectionPlaybook).slice(0, 3000)}`
    ].join('\n\n');

    return callOpenAI(systemPrompt, userPrompt, { maxTokens: 700, temperature: 0.3, purpose: 'sentiment_map', businessName: business.name });
}

// ─── Step 7: closing_triggers + human_handoff_triggers ─────────────────────────
async function fetchClosedConversationIds() {
    // Business chats analysed under the current analyser rules only. This is what
    // keeps stale analysis of personal chats out of the pack.
    const convIds = (await getBusinessScope()).analysedConvIds;
    if (!convIds.length) return [];

    const CONV_BATCH = 300;
    let closed = [], negative = [];
    for (const batch of chunk(convIds, CONV_BATCH)) {
        const { data, error } = await supabase
            .from('conversation_enrichment')
            .select('conversation_id, conv_stage, sentiment_score')
            .in('conversation_id', batch);
        if (error) throw new Error(`conversation_enrichment lookup failed: ${error.message}`);
        for (const row of (data || [])) {
            if (CLOSED_STAGES.includes(row.conv_stage)) closed.push(row.conversation_id);
            if (typeof row.sentiment_score === 'number' && row.sentiment_score <= NEGATIVE_SENTIMENT_MAX) negative.push(row.conversation_id);
        }
    }
    return { closed: closed.slice(0, 10), negative: negative.slice(0, 10) };
}

async function buildClosingAndHandoff(business) {
    const { closed, negative } = await fetchClosedConversationIds();

    if (closed.length < 3) {
        warn('Closing', `Only ${closed.length} 'Closed'/'Closing' conversations found — closing_triggers will be thin and should be treated as low-confidence until more closes accumulate.`);
    }
    if (!negative.length) {
        warn('Handoff', 'No customer conversations with strongly negative sentiment_score found — human_handoff_triggers will be left empty rather than filled with generic phrases.');
    }

    const closedTranscripts = [];
    for (const id of closed) {
        try { closedTranscripts.push(await fetchTailTranscript(id)); } catch { /* skip */ }
    }
    const negativeTranscripts = [];
    for (const id of negative) {
        try { negativeTranscripts.push(await fetchTailTranscript(id)); } catch { /* skip */ }
    }
    if (!closedTranscripts.length && !negativeTranscripts.length) return { closing_triggers: [], human_handoff_triggers: [] };

    // The wording of this prompt lives in src/aiPromptCatalog.js (closing_handoff).
    const userPrompt = [
        closedTranscripts.length ? `CLOSED CONVERSATION EXAMPLES:\n${closedTranscripts.join('\n===\n').slice(0, 6000)}` : 'No closed conversation examples available. Return an empty closing_triggers array.',
        negativeTranscripts.length ? `NEGATIVE-SENTIMENT CONVERSATION EXAMPLES:\n${negativeTranscripts.join('\n===\n').slice(0, 6000)}` : 'No negative-sentiment examples available. Return an empty human_handoff_triggers array.'
    ].join('\n\n');

    const result = await callOpenAI('', userPrompt, { maxTokens: 700, temperature: 0.2, purpose: 'closing_handoff', businessName: business.name });

    // Short generalised phrases only: no identifiers, no amounts-as-numbers, nothing that is really a sentence.
    // And never invent a signal where there was no example for it.
    return {
        closing_triggers: closedTranscripts.length ? cleanTriggers(result.closing_triggers) : [],
        human_handoff_triggers: negativeTranscripts.length ? cleanTriggers(result.human_handoff_triggers) : []
    };
}

// ─── Normalize — guarantee the exact shape PersonaPackEditor.jsx expects ───────
// It .map()s straight over these arrays with no defensive checks, so a key
// an LLM call happened to omit would crash the editor, not just look empty.
// This is the last line of defense before anything gets saved.
function normalizePack(pack) {
    const persona = pack.persona || {};
    const business_context = pack.business_context || {};
    const sentiment_response_map = pack.sentiment_response_map || {};
    const normalizedSentimentMap = {};
    for (const key of SENTIMENT_KEYS) {
        normalizedSentimentMap[key] = typeof sentiment_response_map[key] === 'string' ? sentiment_response_map[key] : '';
    }

    return {
        persona: {
            display_name: persona.display_name || '',
            voice_tone: persona.voice_tone || '',
            formality_score: typeof persona.formality_score === 'number' ? persona.formality_score : 5,
            language_mix: {
                english: persona.language_mix?.english ?? 0,
                swahili: persona.language_mix?.swahili ?? 0,
                sheng: persona.language_mix?.sheng ?? 0
            },
            typical_greeting: persona.typical_greeting || '',
            typical_closing: persona.typical_closing || '',
            emoji_style: persona.emoji_style || '',
            sentence_length: persona.sentence_length || '',
            signature_phrases: Array.isArray(persona.signature_phrases) ? persona.signature_phrases : [],
            phrases_to_avoid: Array.isArray(persona.phrases_to_avoid) ? persona.phrases_to_avoid : [],
            tone_descriptors: Array.isArray(persona.tone_descriptors) ? persona.tone_descriptors : []
        },
        business_context: {
            core_offer: business_context.core_offer || '',
            target_customer: business_context.target_customer || '',
            delivery_info: business_context.delivery_info || '',
            unique_selling_points: Array.isArray(business_context.unique_selling_points) ? business_context.unique_selling_points : [],
            payment_methods: Array.isArray(business_context.payment_methods) ? business_context.payment_methods : []
        },
        objection_playbook: Array.isArray(pack.objection_playbook) ? pack.objection_playbook : [],
        customer_profiles: Array.isArray(pack.customer_profiles) ? pack.customer_profiles : [],
        sentiment_response_map: normalizedSentimentMap,
        closing_triggers: Array.isArray(pack.closing_triggers) ? pack.closing_triggers : [],
        human_handoff_triggers: Array.isArray(pack.human_handoff_triggers) ? pack.human_handoff_triggers : []
    };
}

// ─── Save + status handling ─────────────────────────────────────────────────────
async function savePack(pack) {
    const { data: current } = await supabase
        .from('persona_packs')
        .select('id, version')
        .eq('business_id', BUSINESS_ID)
        .eq('is_active', true)
        .maybeSingle();

    const nextVersion = (current?.version || 0) + 1;

    if (current) {
        await supabase.from('persona_packs').update({ is_active: false }).eq('id', current.id);
    }

    const { error } = await supabase.from('persona_packs').insert({
        business_id: BUSINESS_ID,
        version: nextVersion,
        pack,
        is_active: true,
        generated_by: 'persona_pack_generator',
        generated_at: new Date().toISOString()
    });
    if (error) throw new Error(`Saving persona_packs failed: ${error.message}`);

    // businesses.persona_pack_status has a CHECK constraint allowing only
    // pending/running/ready/failed — matches the same enum scrape_status
    // already uses. 'ready' is the generated-and-active state.
    await supabase.from('businesses').update({
        persona_pack_status: 'ready',
        persona_pack_last_run_at: new Date().toISOString()
    }).eq('business_id', BUSINESS_ID);

    return nextVersion;
}

// Not enough clean history yet — rather than invent a status value the
// column's CHECK constraint doesn't allow, put it back to 'pending' so a
// future run retries automatically once more messages accumulate. The
// actual reason ("insufficient_data") is recorded on enrichment_runs.status
// (free text, see finishRun) and in the console/@@LOG output, not here.
async function saveInsufficientData() {
    await supabase.from('businesses').update({
        persona_pack_status: 'pending',
        persona_pack_last_run_at: new Date().toISOString()
    }).eq('business_id', BUSINESS_ID);
}

async function saveFailed() {
    try {
        await supabase.from('businesses').update({ persona_pack_status: 'failed' }).eq('business_id', BUSINESS_ID);
    } catch { /* best effort */ }
}

// ─── Main ───────────────────────────────────────────────────────────────────────
async function main() {
    log('System', `Persona Pack Generator — business ${BUSINESS_ID}`);
    log('System', 'Starting persona pack generation run.');

    await startRun();
    const business = await loadBusiness();

    // The pack is built from analyser output. If that is missing or stale the
    // analyser is started (or awaited) here, then generation continues on its own.
    await setPhase('checking_analysis');
    const analysis = await ensureAnalysisReady();

    await setPhase('voice');
    log('Voice', 'Fetching human-authored messages from confirmed business chats...');
    const { messages: voiceMessages, funnel } = await fetchVoiceMessages();
    log('Voice', `Funnel: ${funnel.business_contacts} customer/prospect contacts -> ${funnel.business_conversations} conversations -> ${funnel.human_messages} human messages -> ${funnel.with_text} with text -> ${funnel.after_quality_filter} substantive -> ${funnel.after_duplicate_cap} after duplicate cap -> ${funnel.after_conversation_cap} after per-chat cap, across ${funnel.conversations_covered} conversations.`);

    if (voiceMessages.length < MIN_VOICE_MESSAGES || funnel.conversations_covered < MIN_VOICE_CONVERSATIONS) {
        const reason = explainShortfall(funnel);
        warn('Voice', `Not generating: ${reason}`);
        await saveInsufficientData();
        await finishRun('insufficient_data', { summary: { reason, funnel, analysis_ran: analysis.ranAnalyser } });
        log('System', 'Done — insufficient data, no pack written.');
        process.exit(0);
    }

    const corpus = squash(voiceMessages.map(messageText).join(' '));
    const sample = evenSample(voiceMessages, VOICE_SAMPLE_CAP);
    log('Voice', `Sampling ${sample.length} of ${voiceMessages.length} messages, evenly spread across the full history.`);

    const persona = await buildPersonaSection(sample, business.name || BUSINESS_ID, corpus, voiceMessages);
    log('Persona', 'Voice/tone section built.');

    await setPhase('business_context');
    const business_context = await buildBusinessContextSection(business, sample, corpus);
    log('Persona', 'Business context section built.');

    await setPhase('objections');
    const objection_playbook = await buildObjectionPlaybook(business);
    log('Persona', `Objection playbook built (${objection_playbook.length} entries).`);

    await setPhase('profiles');
    const customer_profiles = await buildCustomerProfiles(business);
    log('Persona', `Customer profiles built (${customer_profiles.length} entries).`);

    await setPhase('sentiment_and_closing');
    const sentiment_response_map = await buildSentimentMap(business, persona, business_context, objection_playbook);
    log('Persona', 'Sentiment response map built.');

    const { closing_triggers, human_handoff_triggers } = await buildClosingAndHandoff(business);
    log('Persona', 'Closing/handoff triggers built.');

    const pack = normalizePack({
        persona,
        business_context,
        objection_playbook,
        customer_profiles,
        sentiment_response_map,
        closing_triggers,
        human_handoff_triggers
    });

    await setPhase('saving');
    const version = await savePack(pack);
    log('Persona', `Saved persona_packs version ${version} (is_active=true). messages=${voiceMessages.length} sample=${sample.length} objections=${objection_playbook.length} profiles=${customer_profiles.length}`);

    await finishRun('completed', {
        summary: {
            version, funnel, analysis_ran: analysis.ranAnalyser,
            sections: { objections: objection_playbook.length, profiles: customer_profiles.length, closing_triggers: closing_triggers.length }
        }
    });

    log('System', `Done! persona_packs version ${version} is now active for ${BUSINESS_ID}.`);
    process.exit(0);
}

let exiting = false;
async function failAndExit(reason, code = 1) {
    if (exiting) return;
    exiting = true;
    err('Main', reason);
    err('Summary', `❌ PERSONA PACK FAILED for ${BUSINESS_ID}: ${reason}`);
    await logItemError('Main', 'business', BUSINESS_ID, reason);
    await saveFailed();
    await finishRun('failed', { fatalError: reason });
    process.exit(code);
}
process.on('uncaughtException', (e) => failAndExit(`Uncaught error: ${e?.message || e}`));
process.on('unhandledRejection', (e) => failAndExit(`Unhandled rejection: ${e?.message || e}`));
for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]]) {
    process.on(signal, () => failAndExit(`terminated (${signal})`, code));
}

main().catch((e) => failAndExit(`Execution failed: ${e.message}`));