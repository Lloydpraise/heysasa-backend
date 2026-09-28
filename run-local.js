import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import crypto from 'crypto';
import {
    ANALYSIS_VERSION,
    decideClassification,
    normalizeNlp,
    resolveLeadQuality,
    resolveFollowUpUrgency,
    FatalRunError,
    FailureGuard,
    isHealthyRun,
} from './src/leadClassification.js';
import { getOpenAIAvailabilityState, setOpenAIUnavailable, shouldPauseOpenAIRequest } from './src/services/openAiGate.js';

dotenv.config();

// ─── Config ───────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_KEY   = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY;
let requestedAnalysisConfig = {};
try {
    requestedAnalysisConfig = process.env.ANALYSIS_CONFIG
        ? JSON.parse(process.env.ANALYSIS_CONFIG)
        : {};
} catch (error) {
    console.error(`✗ Invalid ANALYSIS_CONFIG: ${error.message}`);
    process.exit(1);
}

const REQUESTED_BUSINESS_ID = requestedAnalysisConfig.businessId || process.env.BUSINESS_ID || null;
const REQUESTED_CONTACT_IDS = Array.isArray(requestedAnalysisConfig.contactIds)
    ? requestedAnalysisConfig.contactIds
    : [];
let BUSINESS_ID = REQUESTED_BUSINESS_ID;

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
// The personal/business decision feeds everything downstream, so it can be
// given a stronger model than the bulk analysis without touching anything else.
const CLASSIFY_MODEL = process.env.OPENAI_CLASSIFY_MODEL || OPENAI_MODEL;
// Re-classify and re-analyse everyone, even contacts already done at the current version.
const FORCE = requestedAnalysisConfig.force === true || process.env.FORCE_REANALYZE === '1';

const MAX_TRANSCRIPT_MSGS = 100;
const PAGE_SIZE = 1000;
const CONTACT_DELAY_MIN_MS = 200;
const CONTACT_DELAY_MAX_MS = 500;

const TEXT_INPUT_COST_PER_TOKEN  = 0.000000150;
const TEXT_OUTPUT_COST_PER_TOKEN = 0.000000600;
const BILLING_MULTIPLIER         = 5.0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sleepBetweenContacts = () => sleep(
    CONTACT_DELAY_MIN_MS
    + Math.floor(Math.random() * (CONTACT_DELAY_MAX_MS - CONTACT_DELAY_MIN_MS + 1))
);

// Lead-state activity thresholds (days since last inbound message)
const STALLED_AFTER_DAYS = 3;
const GHOSTED_AFTER_DAYS = 14;

// Terminal or manually-set lead states
const PROTECTED_STATES = new Set(['won', 'lost', 'do_not_contact']);

if (!SUPABASE_URL || !SUPABASE_KEY || !OPENAI_KEY) {
    const missing = [
        !SUPABASE_URL && 'SUPABASE_URL',
        !SUPABASE_KEY && 'SUPABASE_SERVICE_KEY',
        !OPENAI_KEY && 'OPENAI_API_KEY',
    ].filter(Boolean);
    console.error(`✗ Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false }
});

const log  = (tag, msg) => emit('info', tag, msg);
const warn = (tag, msg) => emit('warn', tag, msg);
const err  = (tag, msg) => emit('error', tag, msg);

// CHANGED: previously these three just console.log/warn/error'd a plain
// text line, so the only place any of this was visible was a raw pm2
// log file. Now each line is a single parseable "@@LOG " line that the
// root process (src/index.js, which spawns this file as a child) picks
// up and feeds into the live/persisted console — same place webhook and
// sender events show up, filterable by area 'analysis' and by business
// (once BUSINESS_ID is resolved). Only one line per call, matching the
// pattern in followup-engine/src/lib/log.js — printing a second, plain
// line here would make the parent double-log everything.
function emit(level, tag, message) {
    console.log(`@@LOG ${JSON.stringify({ level, area: 'analysis', event: tag, message, business_id: BUSINESS_ID || null, details: {} })}`);
}

// ─── Run tracking ─────────────────────────────────────────────────────────────
let RUN_ID = null;
const STALE_RUN_HOURS = 6;

const LIVE_WINDOW_MS = 3 * 60 * 1000;   // a run that reported in within this window is alive
const DEAD_AFTER_MS  = 15 * 60 * 1000;  // a run silent this long has died

async function startRun(runType) {
    const ago = (ms) => new Date(Date.now() - ms).toISOString();

    // Close out runs that died without finishing so they stop showing as "running".
    try {
        const failure = { status: 'failed', finished_at: new Date().toISOString(), fatal_error: 'stale: process ended without finishing' };
        let sweep = supabase.from('enrichment_runs').update(failure).eq('status', 'running')
            .in('run_type', ['full_pass', 'contact_pass'])
            .or(`heartbeat_at.lt.${ago(DEAD_AFTER_MS)},and(heartbeat_at.is.null,started_at.lt.${ago(STALE_RUN_HOURS * 3600000)})`);
        if (BUSINESS_ID) sweep = sweep.eq('business_id', BUSINESS_ID);
        const { error } = await sweep;
        if (error) {
            // heartbeat column not migrated yet: fall back to age only
            let fallback = supabase.from('enrichment_runs').update(failure).eq('status', 'running').in('run_type', ['full_pass', 'contact_pass']).lt('started_at', ago(STALE_RUN_HOURS * 3600000));
            if (BUSINESS_ID) fallback = fallback.eq('business_id', BUSINESS_ID);
            await fallback;
        }
    } catch (e) {
        warn('RunLog', `Stale-run sweep failed: ${e.message}`);
    }

    // Only one analysis per business at a time, whoever started it (API, persona pack, CLI).
    if (BUSINESS_ID) {
        try {
            const { data: running } = await supabase.from('enrichment_runs')
                .select('id, started_at, heartbeat_at')
                .eq('business_id', BUSINESS_ID)
                .in('run_type', ['full_pass', 'contact_pass'])
                .eq('status', 'running');
            const live = (running || []).find(r => Date.now() - new Date(r.heartbeat_at || r.started_at).getTime() < LIVE_WINDOW_MS);
            if (live) {
                warn('RunLog', `An analysis is already running for ${BUSINESS_ID} (run ${String(live.id).slice(0, 8)}). Exiting so two runs don't process the same chats.`);
                process.exit(3);
            }
        } catch (e) {
            warn('RunLog', `Concurrent-run check failed, continuing: ${e.message}`);
        }
    }

    RUN_ID = crypto.randomUUID();
    try {
        const { error } = await supabase.from('enrichment_runs').insert({
            id: RUN_ID,
            run_type: runType,
            business_id: BUSINESS_ID || null,
            started_at: new Date().toISOString(),
            status: 'running'
        });
        if (error) warn('RunLog', `Could not create run record: ${error.message}`);
    } catch (e) {
        warn('RunLog', `Could not create run record: ${e.message}`);
    }
    return RUN_ID;
}

async function logItemError(stage, entityType, entityId, message) {
    err(stage, `${entityType} ${entityId}: ${message}`);
    try {
        await supabase.from('enrichment_errors').insert({
            run_id: RUN_ID,
            stage,
            entity_type: entityType,
            entity_id: entityId,
            message: String(message).slice(0, 2000),
            created_at: new Date().toISOString()
        });
    } catch (e) {
        warn('RunLog', `Could not persist error row: ${e.message}`);
    }
}

async function finishRun(counts) {
    try {
        const finishedAt = new Date().toISOString();
        const { error } = await supabase.from('enrichment_runs').update({
            status: 'completed',
            finished_at: finishedAt,
            ...counts
        }).eq('id', RUN_ID);
        if (!error) return;

        // A missing column must never leave the run stuck on "running".
        warn('RunLog', `Could not save run counts (${error.message}); closing run without them.`);
        const { error: fallbackError } = await supabase.from('enrichment_runs')
            .update({ status: 'completed', finished_at: finishedAt })
            .eq('id', RUN_ID);
        if (fallbackError) warn('RunLog', `Could not finalize run record: ${fallbackError.message}`);
    } catch (e) {
        warn('RunLog', `Could not finalize run record: ${e.message}`);
    }
}

async function markRunFailed(reason) {
    if (!RUN_ID) return;
    try {
        await supabase.from('enrichment_runs').update({
            status: 'failed',
            finished_at: new Date().toISOString(),
            fatal_error: String(reason).slice(0, 1000)
        }).eq('id', RUN_ID);
    } catch {}
}

// ─── Live progress ────────────────────────────────────────────────────────────
// Writes phase + "X of Y" + a heartbeat onto the run row so anything (the API,
// a dashboard, a SQL query) can see the run is alive and how far along it is.
// Also logs a line at every 25% so the debug console tells the same story.
const PHASE_LABELS = {
    classify:   'Separating personal from business chats',
    ads:        'Extracting ad attribution',
    structural: 'Scoring engagement',
    nlp:        'Analysing conversations',
    rollups:    'Rolling up ad results',
};
let progressWritesEnabled = true;
let lastProgressWrite = 0;
const startedPhases = new Set();
const lastQuartile = {};

async function progress(phase, done, total, { force = false } = {}) {
    const finished = total > 0 && done >= total;
    if (!startedPhases.has(phase)) {
        startedPhases.add(phase);
        log('Progress', `${PHASE_LABELS[phase] || phase}: starting (${total} items)`);
    }
    if (total > 0) {
        const quartile = Math.floor((done / total) * 4);
        if (quartile > (lastQuartile[phase] || 0)) {
            lastQuartile[phase] = quartile;
            log('Progress', `${PHASE_LABELS[phase] || phase}: ${quartile * 25}% (${done}/${total})`);
        }
    }
    if (!progressWritesEnabled || !RUN_ID) return;
    const now = Date.now();
    if (!force && !finished && now - lastProgressWrite < 4000) return;
    lastProgressWrite = now;
    try {
        const { error } = await supabase.from('enrichment_runs').update({
            phase, progress_done: done, progress_total: total,
            heartbeat_at: new Date().toISOString()
        }).eq('id', RUN_ID);
        if (error) {
            progressWritesEnabled = false;
            warn('Progress', `Progress tracking disabled (${error.message}). Run the run-progress migration.`);
        }
    } catch (e) {
        progressWritesEnabled = false;
        warn('Progress', `Progress tracking disabled: ${e.message}`);
    }
}

for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]]) {
    process.on(signal, async () => {
        await markRunFailed(`terminated (${signal})`);
        process.exit(code);
    });
}

// Anything that escapes the normal flow still ends the run cleanly, instead of
// leaving the run row on "running" until the stale sweep finds it.
let crashing = false;
async function crashExit(kind, error) {
    if (crashing) return;
    crashing = true;
    const message = `${kind}: ${error?.message || error}`;
    err('Main', message);
    err('Summary', `❌ ANALYSIS FAILED for ${BUSINESS_ID || 'unknown business'}: ${message}`);
    await markRunFailed(message);
    process.exit(1);
}
process.on('uncaughtException', (e) => crashExit('Uncaught error', e));
process.on('unhandledRejection', (e) => crashExit('Unhandled rejection', e));

async function resolveActiveInstance() {
    // Analysing stored chats does not need a live WhatsApp connection. When a
    // business is named explicitly (HTTP trigger, persona pack, CLI) just verify
    // it exists, so a disconnected phone can never block analysis.
    if (REQUESTED_BUSINESS_ID) {
        const { data: business, error: businessError } = await supabase
            .from('businesses')
            .select('business_id, name')
            .eq('business_id', REQUESTED_BUSINESS_ID)
            .maybeSingle();
        if (businessError) throw new Error(`Business lookup failed: ${businessError.message}`);
        if (!business) throw new Error(`No business found for business_id ${REQUESTED_BUSINESS_ID}`);
        BUSINESS_ID = business.business_id;
        log('Scope', `Analysing stored chats for business ${BUSINESS_ID} (${business.name}).`);
        return business;
    }

    const { data: session, error } = await supabase
        .from('whatsapp_sessions')
        .select('business_id, instance_name, status, updated_at')
        .eq('status', 'connected')
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    if (error) throw new Error(`Active WhatsApp session lookup failed: ${error.message}`);
    if (!session) throw new Error('No connected WhatsApp session found');

    BUSINESS_ID = session.business_id;
    log('Scope', `Using connected instance ${session.instance_name} for business ${BUSINESS_ID}.`);
    return session;
}

// ─── Direct Database Message Loader ───────────────────────────────────────────
// Full-history hydration: do not cap recent messages. Ad attribution depends on
// the first inbound message in the thread, even when the chat has hundreds of rows.
async function fetchContactMessages(contactId) {
    let messagesQuery = supabase
        .from('messages')
        .select('id, direction, type, content, status, raw_payload, created_at')
        .eq('contact_id', contactId)
        .eq('business_id', BUSINESS_ID)
        .order('created_at', { ascending: true });
    const { data, error } = await messagesQuery;
    if (error) throw new Error(`Fetch messages failed: ${error.message}`);
    return data || [];
}

function applyContactScope(query, column = 'id') {
    return REQUESTED_CONTACT_IDS.length > 0
        ? query.in(column, REQUESTED_CONTACT_IDS)
        : query;
}

// ─── Pagination helper ────────────────────────────────────────────────────────
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

// ─── Billing / Usage ──────────────────────────────────────────────────────────
async function logAiUsage(businessId, callRunId, promptTokens, completionTokens, botId = 'enrichment_worker_local') {
    try {
        const baselineCost = parseFloat((
            promptTokens     * TEXT_INPUT_COST_PER_TOKEN +
            completionTokens * TEXT_OUTPUT_COST_PER_TOKEN
        ).toFixed(6));
        const operationalCost = parseFloat((baselineCost * BILLING_MULTIPLIER).toFixed(6));

        await supabase.from('ai_usage_log').insert({
            business_id:        businessId,
            run_id:             callRunId,
            bot_id:             botId,
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
        warn('Usage', `Log failed: ${e.message}`);
        return 0;
    }
}

// ─── Structural Signal Helper Functions ────────────────────────────────────────
async function computeReadReceipt(contactId, messages = null) {
    try {
        const msgs = messages || await fetchContactMessages(contactId);
        const lastOut = [...msgs]
            .filter(message => message.direction === 'out' || message.direction === 'outbound')
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
        
        if (!lastOut) return 'sent';

        const replyCount = msgs.filter(message =>
            (message.direction === 'in' || message.direction === 'inbound') && 
            new Date(message.created_at) > new Date(lastOut.created_at)
        ).length;
        if (replyCount > 0) return 'replied';

        const statusMap = {
            'READ': 'read', 'read': 'read',
            'DELIVERY_ACK': 'delivered', 'SERVER_ACK': 'delivered', 'delivered': 'delivered',
            'SENT': 'sent', 'PENDING': 'sent', 'sent': 'sent',
        };
        return statusMap[lastOut.status] || 'sent';
    } catch (e) {
        warn('ReadReceipt', `Failed for contact ${contactId}: ${e.message}`);
        return 'sent';
    }
}

async function computeMediaFlags(contactId, messages = null) {
    const flags = { sent_voice_note: false, sent_media: false, sent_reaction: false };
    try {
        const msgs = messages || await fetchContactMessages(contactId);
        const inboundMsgs = msgs.filter(message => message.direction === 'in' || message.direction === 'inbound');

        for (const msg of inboundMsgs) {
            const type = msg.type || msg.content?.type;
            if (type === 'voice_note' || type === 'audio')                   flags.sent_voice_note = true;
            if (type === 'image' || type === 'video' || type === 'document') flags.sent_media = true;
            if (type === 'reaction')                                         flags.sent_reaction = true;
        }
    } catch (e) {
        warn('MediaFlags', `Failed for contact ${contactId}: ${e.message}`);
    }
    return flags;
}

async function computeAwaitingReply(contactId, messages = null) {
    try {
        const msgs = messages || await fetchContactMessages(contactId);
        const lastMsg = [...msgs].sort(
            (a, b) => new Date(b.created_at) - new Date(a.created_at)
        )[0];

        if (!lastMsg) return { awaiting_reply: false, awaiting_since: null, hours_waiting: 0 };

        const awaiting = lastMsg.direction === 'in' || lastMsg.direction === 'inbound';
        const hoursWaiting = awaiting
            ? (Date.now() - new Date(lastMsg.created_at).getTime()) / 3600000
            : 0;

        return {
            awaiting_reply: awaiting,
            awaiting_since: awaiting ? lastMsg.created_at : null,
            hours_waiting: Math.round(hoursWaiting * 10) / 10
        };
    } catch (e) {
        warn('AwaitingReply', `Failed for contact ${contactId}: ${e.message}`);
        return { awaiting_reply: false, awaiting_since: null, hours_waiting: 0 };
    }
}

function deriveLeadState(currentState, hasAnyInbound, daysSinceLastInbound, awaitingReply = false) {
    if (PROTECTED_STATES.has(currentState)) return currentState;
    if (!hasAnyInbound) return currentState || 'new';

    // The customer's last message is unanswered: they are waiting on US, so
    // they have not "ghosted" anyone. Long waits are stalled, not ghosted.
    if (awaitingReply) {
        if (daysSinceLastInbound >= GHOSTED_AFTER_DAYS) return 'stalled';
        return currentState === 'warm' ? 'warm' : 'engaged';
    }

    if (daysSinceLastInbound >= GHOSTED_AFTER_DAYS) return 'ghosted';
    if (daysSinceLastInbound >= STALLED_AFTER_DAYS) return 'stalled';

    if (currentState === 'new' || !currentState) return 'engaged';
    if (currentState === 'stalled' || currentState === 'ghosted') return 'engaged';
    return currentState;
}

function computeIntentScore(contact, readReceipt, mediaFlags, daysSinceLastInbound, awaitingReply) {
    if (contact.lead_type === 'personal')                                         return null;
    if (contact.lead_state === 'won')                                             return 99;
    if (contact.lead_state === 'lost' || contact.lead_state === 'do_not_contact') return 0;

    let score = 0;
    const stateBase = { engaged: 55, warm: 40, new: 25, stalled: 18, ghosted: 8 };
    score += stateBase[contact.lead_state] || 20;

    if (readReceipt === 'replied')        score += 20;
    else if (readReceipt === 'read')      score += 10;
    else if (readReceipt === 'delivered') score += 5;

    if (mediaFlags.sent_voice_note) score += 10;
    if (mediaFlags.sent_media)      score += 5;
    if (mediaFlags.sent_reaction)   score += 5;
    if (contact.is_ad_lead)         score += 8;

    if (awaitingReply && daysSinceLastInbound < 1) score += 6;

    const decay = Math.min(30, Math.floor((daysSinceLastInbound || 0) * 2));
    score -= decay;

    return Math.max(1, Math.min(99, Math.round(score)));
}

// ─── Step 1: Ad Attribution Backfill ──────────────────────────────────────────
function extractAdReferral(rawPayload) {
    if (!rawPayload) return null;
    const ref = rawPayload?.message?.contextInfo?.externalAdReply
        || rawPayload?.contextInfo?.externalAdReply
        || rawPayload?.referral;
    if (!ref) return null;

    return {
        ad_id: ref.sourceId || ref.source_id || ref.ad_id || null,
        ad_platform: (ref.sourceType || ref.source_type || 'meta').toLowerCase(),
        ad_headline: ref.title || ref.headline || null,
        ad_body: ref.body || ref.description || null,
        ad_thumbnail_url: ref.thumbnailUrl || ref.sourceUrl || null,
        ad_media_url: ref.mediaUrl || ref.sourceUrl || null,
        ad_source_url: ref.sourceUrl || null,
        ad_media_type: ref.mediaType || null,
    };
}

async function runAdAttributionExtraction() {
    log('AdAttribution', 'Running deterministic ad-signal extraction...');
    let matched = 0, noMatch = 0, noAdId = 0, sampledShapeLogged = false;

    let contactsQuery = applyContactScope(supabase
        .from('contacts')
        .select('id, business_id, is_ad_lead')
        .order('id'));
    if (BUSINESS_ID) contactsQuery = contactsQuery.eq('business_id', BUSINESS_ID);

    let contacts;
    try {
        contacts = await fetchAllPages((from, to) => contactsQuery.range(from, to));
    } catch (e) {
        await logItemError('AdAttribution', 'query', 'contacts', e.message);
        throw new FatalRunError(`AdAttribution: could not load contacts (${e.message})`);
    }
    log('AdAttribution', `${contacts.length} contacts to check.`);

    let adDone = 0;
    const guard = new FailureGuard('Ad attribution');
    for (const contact of contacts) {
        await progress('ads', ++adDone, contacts.length);
        try {
            const messages = await fetchContactMessages(contact.id);
            const firstInbound = messages
                .filter(message => message.direction === 'in' || message.direction === 'inbound')
                .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0];

            if (!firstInbound) { guard.ok(); continue; }

            const ad = extractAdReferral(firstInbound.raw_payload);

            if (!ad) {
                noMatch++;
                if (contact.is_ad_lead && !sampledShapeLogged) {
                    warn('AdAttribution', `Contact ${contact.id} is flagged is_ad_lead but no referral shape matched. Sample raw_payload: ${JSON.stringify(firstInbound.raw_payload).slice(0, 1500)}`);
                    sampledShapeLogged = true;
                }
                guard.ok();
                continue;
            }

            await supabase.from('contacts').update({
                is_ad_lead: true,
                ad_id: ad.ad_id,
                ad_platform: ad.ad_platform,
                ad_headline: ad.ad_headline,
                ad_body: ad.ad_body,
                ad_thumbnail_url: ad.ad_thumbnail_url,
                ad_attributed_at: new Date().toISOString()
            }).eq('id', contact.id);

            if (ad.ad_id) {
                const { error: adUpsertError } = await supabase.from('ad_attributions').upsert({
                    business_id: contact.business_id,
                    ad_id: ad.ad_id,
                    ad_platform: ad.ad_platform,
                    ad_headline: ad.ad_headline,
                    ad_body: ad.ad_body,
                    ad_thumbnail_url: ad.ad_thumbnail_url,
                    ad_media_url: ad.ad_media_url,
                    ad_source_url: ad.ad_source_url,
                    ad_media_type: ad.ad_media_type,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'business_id,ad_id' });
                if (adUpsertError) throw new Error(`ad_attributions upsert failed: ${adUpsertError.message}`);
                matched++;
            } else {
                noAdId++;
            }
            guard.ok();
        } catch (e) {
            if (e instanceof FatalRunError) throw e;
            await logItemError('AdAttribution', 'contact', contact.id, e.message);
            guard.fail(e.message);
        }
        await sleepBetweenContacts();
    }
    log('AdAttribution', `✓ ${matched} matched with ad_id, ${noAdId} matched without ad_id, ${noMatch} no referral found.`);
}

// ─── Shared helpers: transcripts + OpenAI ─────────────────────────────────────
const isInbound = (m) => m.direction === 'in' || m.direction === 'inbound';

function messageText(m) {
    const raw = m.content?.text || (typeof m.content === 'string' ? m.content : '') || '';
    return String(raw).replace(/\s+/g, ' ').trim();
}

// Day headers give the model a sense of time and gaps; long messages are trimmed.
function buildTranscript(messages, { maxChars = 400 } = {}) {
    const lines = [];
    let lastDay = null;
    for (const m of messages) {
        const day = m.created_at ? String(m.created_at).slice(0, 10) : null;
        if (day && day !== lastDay) {
            lines.push(`--- ${day} ---`);
            lastDay = day;
        }
        const role = isInbound(m) ? 'CUSTOMER' : 'BUSINESS';
        const type = m.type && m.type !== 'text' ? ` [${m.type}]` : '';
        lines.push(`${role}: ${messageText(m).slice(0, maxChars)}${type}`);
    }
    return lines.join('\n');
}

// Everything the customer actually said in the messages the model was shown.
// Quotes the model returns are checked against this.
function customerTextOf(messages) {
    return messages.filter(isInbound).map(messageText).join('\n');
}

function summarizeBusiness(row) {
    const parts = [`Business name: ${row?.name || 'unknown'}`];
    for (const key of ['industry', 'business_type', 'category', 'description', 'about', 'services']) {
        if (row && typeof row[key] === 'string' && row[key].trim()) {
            parts.push(`${key}: ${row[key].trim().slice(0, 300)}`);
        }
    }
    return parts.join('\n');
}

async function callOpenAiJson({ model, system, user, maxTokens, attempts = 2 }) {
    let lastError;
    if (shouldPauseOpenAIRequest()) {
        const state = getOpenAIAvailabilityState();
        throw new FatalRunError(state.message || 'OpenAI Unavailable');
    }
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            if (shouldPauseOpenAIRequest()) {
                const state = getOpenAIAvailabilityState();
                throw new FatalRunError(state.message || 'OpenAI Unavailable');
            }
            const res = await fetch('https://api.openai.com/v1/chat/completions', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
                signal:  AbortSignal.timeout(60000),
                body: JSON.stringify({
                    model,
                    max_tokens:  maxTokens,
                    temperature: 0.1,
                    response_format: { type: 'json_object' },
                    messages: [
                        { role: 'system', content: system },
                        { role: 'user',   content: user }
                    ]
                })
            });
            if (!res.ok) {
                const errorBody = await res.text();
                if (res.status === 401 || res.status === 429 || res.status === 403 || /insufficient_quota|invalid_api_key|rate limit|billing/i.test(errorBody)) {
                    setOpenAIUnavailable({
                        status: res.status,
                        reason: errorBody.slice(0, 200) || 'OpenAI rejected the request',
                        message: "cant call ai on debug 'openai 429 or 401 error'",
                    });
                    throw new FatalRunError(`OpenAI rejected the request (${res.status}): ${errorBody.slice(0, 200)}. Check OPENAI_API_KEY and billing.`);
                }
                throw new Error(`OpenAI API returned ${res.status}: ${errorBody.slice(0, 500)}`);
            }
            const body   = await res.json();
            const choice = body.choices?.[0];
            if (choice?.finish_reason === 'length') throw new Error('response truncated (finish_reason=length)');
            const raw   = choice?.message?.content?.trim() || '';
            const clean = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
            const usage = body.usage || {};
            return {
                json: JSON.parse(clean),
                promptTokens: usage.prompt_tokens || 0,
                completionTokens: usage.completion_tokens || 0
            };
        } catch (e) {
            if (e instanceof FatalRunError) throw e;
            const message = String(e?.message || '');
            if (/401|429|rate limit|quota|api key|billing|insufficient/i.test(message)) {
                setOpenAIUnavailable({
                    status: /429/.test(message) ? 429 : /401/.test(message) ? 401 : null,
                    reason: message,
                    message: "cant call ai on debug 'openai 429 or 401 error'",
                });
            }
            lastError = e;
            if (attempt < attempts) await sleep(1500 * attempt);
        }
    }
    throw lastError;
}

// ─── Step 0: Personal / Business Separation ───────────────────────────────────
// Runs BEFORE any scoring. Nothing that is not a confirmed business chat is
// scored, analysed, or used to build persona packs.
const CLASSIFIER_SYSTEM_PROMPT = `You decide whether a WhatsApp chat belongs to a business's commercial pipeline. The chat happened on the business owner's WhatsApp number. Owners also use that number for their private life, so many chats are NOT customers.

LABELS
- business: the other person buys, enquires about, negotiates, pays for or receives the business's products or services; OR the business is selling, quoting or following up with them; OR they are a supplier, vendor, delivery or agency partner for the business's operations.
- personal: family, friends, church or community groups, landlord or rent, staff or colleagues chatting internally, favours, personal errands, money asked for or lent between individuals, social chit-chat. Nothing of the business's products or services is being sold or bought.
- junk: spam, wrong numbers, bots, system notices, OTP codes, or a chat with no usable content.

RULES
1. Judge by what is actually being exchanged, not by tone. Formal language or calling someone "sir" does not make a chat commercial.
2. Money counts as commercial only when it is payment for the business's products or services, or a vendor cost of the business. Requests for personal money, rent, transport, or help are personal.
3. Church, fellowship, family or friend matters are personal even when the person is prominent or the owner does volunteer work for them.
4. Messages sent by BUSINESS show what the owner said; messages by CUSTOMER show the other person. Both together tell you the relationship.
5. A chat with only a greeting or a very few messages is uncertain: keep confidence at 0.5 or lower.
6. Mixed chats: choose by the dominant and most recent pattern and say so in the reason.
7. Personal or junk is a valid answer. Do not force a chat into business.

Return ONLY JSON:
{
  "lead_type": "business | personal | junk",
  "confidence": number between 0 and 1,
  "reason": "one sentence naming what is being exchanged",
  "evidence": "a short verbatim excerpt (5-20 words) copied exactly from the chat that supports your label"
}`;

function classificationExcerpt(messages) {
    if (messages.length <= 50) return messages;
    return [...messages.slice(0, 10), ...messages.slice(-40)];
}

async function runClassificationPass() {
    log('Classify', 'Starting personal/business separation pass...');
    const counts = { business: 0, personal: 0, junk: 0, unknown: 0, skipped: 0, errored: 0 };

    let bizRow = null;
    try {
        const { data, error } = await supabase.from('businesses').select('*').eq('business_id', BUSINESS_ID).maybeSingle();
        if (error) throw new Error(error.message);
        bizRow = data;
        if (!bizRow) warn('Classify', `No businesses row found for business_id ${BUSINESS_ID}; the classifier will not know what the business sells.`);
    } catch (e) {
        warn('Classify', `Business lookup failed, continuing with limited context: ${e.message}`);
    }
    const businessContext = summarizeBusiness(bizRow);

    let contactsQuery = applyContactScope(supabase
        .from('contacts')
        .select('id, business_id, name, lead_type, lead_state, is_ad_lead, lead_type_source, lead_type_classified_at')
        .order('id'));
    if (BUSINESS_ID) contactsQuery = contactsQuery.eq('business_id', BUSINESS_ID);

    let contacts;
    try {
        contacts = await fetchAllPages((from, to) => contactsQuery.range(from, to));
    } catch (e) {
        await logItemError('Classify', 'query', 'contacts', e.message);
        throw new FatalRunError(`Classify: could not load contacts (${e.message})`);
    }
    log('Classify', `${contacts.length} contacts to consider.`);

    let reviewLogged = 0, classifyDone = 0;
    const guard = new FailureGuard('Classify');
    for (const contact of contacts) {
        await progress('classify', ++classifyDone, contacts.length);
        try {
            // A person's manual choice, or a personal label set before source tracking existed, is never overridden.
            const protectedManual = contact.lead_type_source === 'manual'
                || (contact.lead_type === 'personal' && !contact.lead_type_source);
            if (protectedManual) { counts.skipped++; continue; }

            const alreadyDone = !!contact.lead_type_classified_at;
            if (alreadyDone && !FORCE && contact.lead_type !== 'unknown') { counts.skipped++; continue; }

            const messages = await fetchContactMessages(contact.id);
            if (!messages.length) { counts.skipped++; continue; }

            // Contacts left 'unknown' are only retried once there is something new to read.
            if (alreadyDone && !FORCE && contact.lead_type === 'unknown') {
                const last = messages[messages.length - 1];
                if (new Date(last.created_at) <= new Date(contact.lead_type_classified_at)) { counts.skipped++; continue; }
            }

            const firstInbound = messages.find(isInbound);
            const ad = firstInbound ? extractAdReferral(firstInbound.raw_payload) : null;
            const deterministic = !!ad || contact.is_ad_lead || contact.lead_state === 'won' || contact.lead_state === 'lost';

            let llm = null;
            if (!deterministic) {
                const excerpt = classificationExcerpt(messages);
                const result = await callOpenAiJson({
                    model: CLASSIFY_MODEL,
                    system: CLASSIFIER_SYSTEM_PROMPT,
                    user: `BUSINESS\n${businessContext}\n\nCHAT (CUSTOMER = the other person, BUSINESS = the account owner)\n${buildTranscript(excerpt, { maxChars: 300 })}`,
                    maxTokens: 300
                });
                llm = result.json;
                await logAiUsage(BUSINESS_ID, crypto.randomUUID(), result.promptTokens, result.completionTokens, 'classifier_local');
            }

            const decision = decideClassification({
                isAdLead: contact.is_ad_lead,
                hasAdReferral: !!ad,
                leadState: contact.lead_state,
                llm,
                transcriptText: messages.map(messageText).join('\n')
            });

            const update = {
                lead_type: decision.leadType,
                lead_type_source: decision.source,
                lead_type_reason: decision.reason.slice(0, 300),
                lead_type_confidence: decision.confidence,
                lead_type_classified_at: new Date().toISOString()
            };
            // Anything that is not a confirmed business chat carries no lead scores.
            if (decision.leadType !== 'business') {
                Object.assign(update, {
                    lead_quality: null, intent_score: null, follow_up_urgency: null,
                    intent: null, quality_score: null, intent_evidence: null,
                    nlp_enriched_at: null, analysis_version: null
                });
            }

            const { error: contactError } = await supabase.from('contacts').update(update).eq('id', contact.id);
            if (contactError) throw new Error(`contact classification write failed: ${contactError.message}`);

            const convUpdate = { is_business_chat: decision.isBusinessChat };
            if (decision.leadType !== 'business') {
                // Old analysis of a chat now known not to be a customer chat must not leak into anything downstream.
                Object.assign(convUpdate, { lead_quality: null, customer_intent: null, psychology: null, vibe_check: null });
            }
            const { error: convError } = await supabase.from('conversations')
                .update(convUpdate)
                .eq('contact_id', contact.id)
                .eq('business_id', contact.business_id);
            if (convError) throw new Error(`conversation flag write failed: ${convError.message}`);

            counts[decision.leadType] = (counts[decision.leadType] || 0) + 1;
            guard.ok();
            if (decision.leadType !== 'business' && reviewLogged < 60) {
                reviewLogged++;
                log('Classify', `${decision.leadType} (${decision.confidence}) ${contact.name || contact.id}: ${decision.reason}`);
            }
        } catch (e) {
            if (e instanceof FatalRunError) throw e;
            counts.errored++;
            await logItemError('Classify', 'contact', contact.id, e.message);
            guard.fail(e.message);
        }
        await sleepBetweenContacts();
    }
    log('Classify', `✓ business ${counts.business}, personal ${counts.personal}, junk ${counts.junk}, unknown ${counts.unknown} (needs review), skipped ${counts.skipped}, errored ${counts.errored}.`);
    return counts;
}

// ─── Step 2: Structural Enrichment Pass ───────────────────────────────────────
async function runStructuralEnrichment() {
    log('Structural', 'Starting structural calculation pass...');
    let enriched = 0, errored = 0;

    // Confirmed business contacts only. Personal, junk and unknown are never scored.
    let contactsQuery = applyContactScope(supabase
        .from('contacts')
        .select('id, business_id, lead_state, lead_type, is_ad_lead, quality_score, intent, follow_up_urgency, nlp_enriched_at, analysis_version')
        .eq('lead_type', 'business')
        .order('id'));
    if (BUSINESS_ID) contactsQuery = contactsQuery.eq('business_id', BUSINESS_ID);

    let contacts;
    try {
        contacts = await fetchAllPages((from, to) => contactsQuery.range(from, to));
    } catch (e) {
        await logItemError('Structural', 'query', 'contacts', e.message);
        throw new FatalRunError(`Structural: could not load contacts (${e.message})`);
    }

    if (!contacts.length) {
        warn('Structural', 'No confirmed business contacts found.');
        return { enriched, errored };
    }
    log('Structural', `${contacts.length} business contacts found.`);

    let structuralDone = 0;
    const guard = new FailureGuard('Structural');
    for (const contact of contacts) {
        await progress('structural', ++structuralDone, contacts.length);
        try {
            const messages = await fetchContactMessages(contact.id);
            const [readReceipt, mediaFlags, awaiting] = await Promise.all([
                computeReadReceipt(contact.id, messages),
                computeMediaFlags(contact.id, messages),
                computeAwaitingReply(contact.id, messages)
            ]);

            const inboundMessages = messages.filter(isInbound);
            const lastInbound = [...inboundMessages]
                .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];

            const daysSince = lastInbound
                ? (Date.now() - new Date(lastInbound.created_at).getTime()) / 86400000
                : 90;

            const newLeadState = deriveLeadState(contact.lead_state, inboundMessages.length > 0, daysSince, awaiting.awaiting_reply);
            const intentScore = computeIntentScore(
                { ...contact, lead_state: newLeadState },
                readReceipt, mediaFlags, daysSince, awaiting.awaiting_reply
            );

            // Content analysis only counts when it was produced by the current rules.
            const analysed = contact.analysis_version === ANALYSIS_VERSION && !!contact.nlp_enriched_at;
            const aiQuality = analysed ? contact.quality_score : null;
            const aiIntent  = analysed ? contact.intent : null;

            const leadQuality = resolveLeadQuality({
                leadType: 'business', leadState: newLeadState, intentScore, aiQuality, aiIntent
            });
            const followUpUrgency = resolveFollowUpUrgency({
                leadType: 'business', leadState: newLeadState,
                aiUrgency: analysed ? contact.follow_up_urgency : null,
                aiQuality, aiIntent,
                awaiting: awaiting.awaiting_reply,
                daysSinceLastInbound: lastInbound ? daysSince : null
            });

            const { error: updateError } = await supabase.from('contacts').update({
                lead_state:              newLeadState,
                read_receipt:            readReceipt,
                sent_voice_note:         mediaFlags.sent_voice_note,
                sent_media:              mediaFlags.sent_media,
                sent_reaction:           mediaFlags.sent_reaction,
                awaiting_reply:          awaiting.awaiting_reply,
                awaiting_since:          awaiting.awaiting_since,
                hours_awaiting_reply:    awaiting.hours_waiting,
                intent_score:            intentScore,
                lead_quality:            leadQuality,
                follow_up_urgency:       followUpUrgency,
                structural_enriched_at:  new Date().toISOString()
            }).eq('id', contact.id);

            if (updateError) throw new Error(updateError.message);
            enriched++;
            guard.ok();
        } catch (e) {
            if (e instanceof FatalRunError) throw e;
            errored++;
            await logItemError('Structural', 'contact', contact.id, e.message);
            guard.fail(e.message);
        }
        await sleepBetweenContacts();
    }
    log('Structural', `✓ ${enriched} contacts updated, ${errored} errored.`);
    return { enriched, errored };
}

// ─── Step 3: NLP AI Extraction ────────────────────────────────────────────────
const NLP_SYSTEM_PROMPT = `You are a sales intelligence system reading WhatsApp conversations for small businesses in Kenya and East Africa (English, Swahili and Sheng are all common). This chat has ALREADY been confirmed as a business chat: the other person is a customer, prospect or client. Do not decide whether it is personal.

Report what the CUSTOMER actually said. Precision matters more than optimism: a wrong "hot" wastes the sales team's time, and a wrong "cold" loses a sale. Never infer intent that the customer's own words do not show. BUSINESS lines show what was offered or said by the owner, not what the customer wants.

STRUCTURAL SIGNALS are hard facts computed from the raw data. Do not contradict them.

STAGE DEFINITIONS (use exactly one):
- Awareness: customer just arrived, hasn't stated a need yet.
- Consideration: customer has described a need or asked general questions, no specific product picked.
- Product interest: customer has named or clearly implied a specific product/service.
- Negotiation: price, quantity, delivery, or terms are actively being discussed.
- Stalled: the conversation trailed off without a next step, or days_since_last_inbound is high.
- Closed: a sale, refusal, or explicit end was reached.
- Ghosted: long silence from the customer after a clear buying signal, with the business having replied last.

INTENT DEFINITIONS:
- buying: the customer states they want to purchase, hire or book.
- price_check: the customer asks for a price, rate or quote.
- browsing: general questions about what is offered, no commitment.
- support: an existing customer with an issue about something already bought.
- referral: they were sent by someone else or are asking on someone's behalf.
- unknown: the customer's messages show no commercial need.

QUALITY SCORE (1-10):
1-2 no commercial signal. 3-4 vague or passing interest. 5-6 clear interest but no specifics. 7-8 specific need with price, quantity, timeline or a next step being discussed. 9-10 ready to pay, paid, or closing now.

FOLLOW_UP_URGENCY: hot = the customer is waiting for our reply and has shown buying or price interest recently. warm = a live conversation or real interest, but nothing needs answering right now. cold = no signal, closed, or long silent. (The system applies the final urgency using the structural signals; give your honest read.)

RULES
1. Intent and quality come only from CUSTOMER lines. If the customer never shows a commercial need, intent is "unknown" and quality_score is 1-3.
2. intent_evidence: copy one verbatim excerpt (max 25 words) from a CUSTOMER line that supports your intent and quality_score. Copy it exactly, in its original language, do NOT translate or paraphrase. If intent is "unknown", set intent_evidence to null. A quality_score above 4 requires evidence.
3. If structural_signals.days_since_last_inbound is large (>7) and there was no clear close, lean toward "Stalled" or "Ghosted" rather than inventing progress.
4. Cross-reference product mentions against the catalog: match the exact product_id/name if found; otherwise infer the rough item name, set product_id null, and set match_status "no match".
5. Never invent a number, date, or promise the customer didn't state.
6. Leave a field null or empty rather than guessing.

Return ONLY a valid JSON object matching this schema:
{
  "intent":                 "buying | browsing | support | price_check | referral | unknown",
  "intent_evidence":        "verbatim customer excerpt or null",
  "follow_up_urgency":      "hot | warm | cold",
  "quality_score":          integer 1-10,
  "lead_summary":           "one sentence what this lead wants (max 20 words)",
  "customer_intent":        "short CRM phrase (max 8 words)",
  "psychology":             "one sentence buyer psychology",
  "conv_stage":             "Awareness | Consideration | Product interest | Negotiation | Stalled | Closed | Ghosted",
  "vibe_check":             "2 sentences max: what the sales rep should know right now",
  "next_action_plan":       "single most impactful next action (one sentence); if the customer is awaiting a reply it must be about replying",
  "competitor_mentions":    ["string"],
  "objection_tags":         ["price | not_ready | found_elsewhere | needs_more_info | trust_concerns | size_availability"],
  "pre_purchase_questions": ["verbatim questions before buying (max 5)"],
  "product_tags":           ["product categories mentioned"],
  "matched_products":       [
    {
      "product_id": "Exact product ID string from catalog if matched, otherwise null",
      "product_name": "Exact product name from catalog if matched, otherwise the rough/inferred item name",
      "match_status": "matched | no match"
    }
  ],
  "sentiment_score":        number -1.0 to 1.0,
  "price_objection":        boolean
}`;

async function runNLPExtraction(transcript, businessContext, productsCatalog, structuralSignals) {
    const user = `BUSINESS CONTEXT:\n${businessContext}\n\nAVAILABLE BUSINESS PRODUCTS CATALOG:\n${productsCatalog || 'No products registered.'}\n\nSTRUCTURAL SIGNALS (ground truth):\n${JSON.stringify(structuralSignals, null, 2)}\n\nCONVERSATION:\n${transcript}`;
    try {
        const result = await callOpenAiJson({ model: OPENAI_MODEL, system: NLP_SYSTEM_PROMPT, user, maxTokens: 1100 });
        return { nlp: result.json, promptTokens: result.promptTokens, completionTokens: result.completionTokens };
    } catch (e) {
        throw new Error(`NLP extraction failed: ${e.message}`);
    }
}

async function applyNLPResults(businessId, contactId, conversationId, rawNlp, callRunId, promptTokens, completionTokens, signals, customerText) {
    if (!rawNlp) return { flags: [] };

    await logAiUsage(businessId, callRunId, promptTokens, completionTokens);

    const { data: existingContact, error: existingError } = await supabase
        .from('contacts')
        .select('product_interests, lead_type, lead_state, intent_score')
        .eq('id', contactId)
        .single();
    if (existingError) throw new Error(`contact lookup failed: ${existingError.message}`);

    // The separation step owns this decision; analysis never writes to non-business contacts.
    if (existingContact.lead_type !== 'business') {
        warn('NLP', `Not writing analysis for contact ${contactId}: lead_type is ${existingContact.lead_type}.`);
        return { flags: ['skipped_not_business'] };
    }

    const { nlp, flags } = normalizeNlp(rawNlp, { customerText });

    const leadQuality = resolveLeadQuality({
        leadType: 'business',
        leadState: existingContact.lead_state,
        intentScore: existingContact.intent_score,
        aiQuality: nlp.quality_score,
        aiIntent: nlp.intent
    });
    const followUpUrgency = resolveFollowUpUrgency({
        leadType: 'business',
        leadState: existingContact.lead_state,
        aiUrgency: nlp.follow_up_urgency,
        aiQuality: nlp.quality_score,
        aiIntent: nlp.intent,
        awaiting: signals.awaiting_reply,
        daysSinceLastInbound: signals.days_since_last_inbound
    });

    const { error: enrichmentError } = await supabase.from('conversation_enrichment').upsert({
        conversation_id:        conversationId,
        contact_id:             contactId,
        conv_stage:             nlp.conv_stage             || null,
        next_action_plan:       nlp.next_action_plan       || null,
        competitor_mentions:    nlp.competitor_mentions    || [],
        objection_tags:         nlp.objection_tags         || [],
        pre_purchase_questions: nlp.pre_purchase_questions || [],
        sentiment_score:        nlp.sentiment_score        ?? null,
        price_objection:        nlp.price_objection        || false,
        product_tags:           nlp.product_tags           || [],
        last_enriched_at:       new Date().toISOString(),
    }, { onConflict: 'conversation_id' });
    if (enrichmentError) throw new Error(`conversation_enrichment write failed: ${enrichmentError.message}`);

    if (nlp.sentiment_score !== null && nlp.sentiment_score !== undefined) {
        const { error: sentimentError } = await supabase.from('sentiment_snapshots').insert({
            business_id: businessId,
            contact_id: contactId,
            conversation_id: conversationId,
            sentiment_score: nlp.sentiment_score,
        });
        if (sentimentError) throw new Error(`sentiment_snapshots write failed: ${sentimentError.message}`);
    }

    const convUpdate = { lead_quality: leadQuality };
    if (nlp.lead_summary)    convUpdate.context_summary = nlp.lead_summary;
    if (nlp.customer_intent) convUpdate.customer_intent = nlp.customer_intent;
    if (nlp.psychology)      convUpdate.psychology      = nlp.psychology;
    if (nlp.vibe_check)      convUpdate.vibe_check      = nlp.vibe_check;
    const { error: conversationError } = await supabase.from('conversations').update(convUpdate).eq('id', conversationId);
    if (conversationError) throw new Error(`conversation write failed: ${conversationError.message}`);

    const matchedNames = (nlp.matched_products || []).map(p => p?.product_name).filter(Boolean);
    const mergedInterests = [...new Set([
        ...(existingContact.product_interests || []),
        ...(nlp.product_tags || []),
        ...matchedNames
    ])];

    const contactUpdate = {
        nlp_enriched_at:   new Date().toISOString(),
        analysis_version:  ANALYSIS_VERSION,
        intent:            nlp.intent,
        intent_evidence:   nlp.intent_evidence,   // null clears stale evidence
        follow_up_urgency: followUpUrgency,
        quality_score:     nlp.quality_score,
        lead_quality:      leadQuality,
    };
    if (nlp.lead_summary) contactUpdate.lead_summary = nlp.lead_summary;
    if (mergedInterests.length > 0) contactUpdate.product_interests = mergedInterests;

    const { error: contactError } = await supabase.from('contacts').update(contactUpdate).eq('id', contactId);
    if (contactError) throw new Error(`contact write failed: ${contactError.message}`);

    return { flags };
}

async function runNLPPass() {
    log('NLP', 'Starting AI extraction pass...');
    let enrichedCount = 0, errored = 0, skipped = 0;
    const flagCounts = {};

    // Only conversations whose contact is a confirmed business contact.
    let conversationsQuery = applyContactScope(supabase
        .from('conversations')
        .select(`
            id, business_id, contact_id,
            contacts!inner ( id, lead_type, nlp_enriched_at, analysis_version )
        `), 'contact_id')
        .eq('contacts.lead_type', 'business')
        .order('id');
    if (BUSINESS_ID) conversationsQuery = conversationsQuery.eq('business_id', BUSINESS_ID);

    let conversations;
    try {
        conversations = await fetchAllPages((from, to) => conversationsQuery.range(from, to));
    } catch (e) {
        await logItemError('NLP', 'query', 'conversations', e.message);
        throw new FatalRunError(`NLP: could not load conversations (${e.message})`);
    }

    if (!conversations.length) {
        warn('NLP', 'No business conversations found.');
        return { enrichedCount, errored, skipped };
    }
    log('NLP', `${conversations.length} business conversations found.`);

    const businessCache = new Map();
    const productsCache = new Map();

    let nlpDone = 0;
    const guard = new FailureGuard('NLP');
    for (const conv of conversations) {
        await progress('nlp', ++nlpDone, conversations.length);
        try {
            if (!conv.business_id || !conv.contact_id) {
                warn('NLP', `Skipping conversation ${conv.id}: missing business_id or contact_id.`);
                skipped++;
                continue;
            }

            const businessId = conv.business_id;
            if (!businessCache.has(businessId)) {
                const { data: business, error: businessError } = await supabase
                    .from('businesses')
                    .select('*')
                    .eq('business_id', businessId)
                    .maybeSingle();
                if (businessError) throw new Error(`Business lookup failed: ${businessError.message}`);
                businessCache.set(businessId, summarizeBusiness(business || { name: 'unknown' }));
            }

            if (!productsCache.has(businessId)) {
                const { data: products, error: productsError } = await supabase
                    .from('products')
                    .select('id, title')
                    .eq('business_id', businessId);
                if (productsError) throw new Error(`Product lookup failed: ${productsError.message}`);
                productsCache.set(businessId, (products || []).map(p => `- ID: ${p.id} | Name: ${p.title}`).join('\n'));
            }

            const messages = await fetchContactMessages(conv.contact_id);
            if (!messages?.length) { skipped++; continue; }

            // Skip contacts already analysed under the current rules with nothing new said since.
            const contact = Array.isArray(conv.contacts) ? conv.contacts[0] : conv.contacts;
            const lastMsg = messages[messages.length - 1];
            const upToDate = contact?.analysis_version === ANALYSIS_VERSION
                && contact?.nlp_enriched_at
                && new Date(lastMsg.created_at) <= new Date(contact.nlp_enriched_at);
            if (upToDate && !FORCE) { skipped++; continue; }

            const lastInbound = [...messages].reverse().find(isInbound);
            const daysSinceLastInbound = lastInbound
                ? Math.round(((Date.now() - new Date(lastInbound.created_at).getTime()) / 86400000) * 10) / 10
                : null;
            const isLastMsgInbound = isInbound(lastMsg);
            const structuralSignals = {
                awaiting_reply: isLastMsgInbound,
                hours_awaiting_reply: isLastMsgInbound
                    ? Math.round(((Date.now() - new Date(lastMsg.created_at).getTime()) / 3600000) * 10) / 10
                    : 0,
                days_since_last_inbound: daysSinceLastInbound,
                last_message_from: isLastMsgInbound ? 'customer' : 'business',
                customer_message_count: messages.filter(isInbound).length,
                total_messages: messages.length
            };

            const window = messages.slice(-MAX_TRANSCRIPT_MSGS);
            const transcript = buildTranscript(window);
            const customerText = customerTextOf(window);
            const callRunId = crypto.randomUUID();
            log('NLP', `Analyzing business ${businessId} -> contact ${conv.contact_id} -> conversation ${conv.id} (${messages.length} messages)...`);

            const result = await runNLPExtraction(
                transcript,
                businessCache.get(businessId),
                productsCache.get(businessId),
                structuralSignals
            );

            const applied = await applyNLPResults(
                businessId, conv.contact_id, conv.id, result.nlp,
                callRunId, result.promptTokens, result.completionTokens,
                structuralSignals, customerText
            );
            for (const f of applied.flags) flagCounts[f] = (flagCounts[f] || 0) + 1;
            enrichedCount++;
            guard.ok();

        } catch (e) {
            if (e instanceof FatalRunError) throw e;
            errored++;
            await logItemError('NLP', 'conversation', conv.id, e.message);
            guard.fail(e.message);
        }
        await sleepBetweenContacts();
    }
    const flagSummary = Object.entries(flagCounts).map(([k, v]) => `${k}=${v}`).join(', ') || 'none';
    log('NLP', `✓ ${enrichedCount} enriched, ${errored} errored, ${skipped} skipped. Guard flags: ${flagSummary}.`);
    return { enrichedCount, errored, skipped };
}

// ─── Step 4: Recompute Ad Attribution Rollups ──────────────────────────────────
async function recomputeAdAttributionRollups() {
    log('AdAttribution', 'Recomputing per-ad lead/reply/conversion counts...');
    await progress('rollups', 0, 1, { force: true });

    let contactsQuery = applyContactScope(supabase
        .from('contacts')
        .select('id, business_id, ad_id, read_receipt, lead_state, product_interests')
        .not('ad_id', 'is', null)
        .order('id'));
    if (BUSINESS_ID) contactsQuery = contactsQuery.eq('business_id', BUSINESS_ID);

    let attributedContacts;
    try {
        attributedContacts = await fetchAllPages((from, to) => contactsQuery.range(from, to));
    } catch (e) {
        await logItemError('AdAttribution', 'query', 'attributed-contacts', e.message);
        return;
    }
    if (!attributedContacts.length) {
        log('AdAttribution', 'No ad-attributed contacts to roll up yet.');
        return;
    }

    const groups = new Map();
    for (const c of attributedContacts) {
        const key = `${c.business_id}|${c.ad_id}`;
        if (!groups.has(key)) {
            groups.set(key, {
                business_id: c.business_id, ad_id: c.ad_id,
                lead_count: 0, reply_count: 0, product_interest_count: 0, conversion_count: 0
            });
        }
        const g = groups.get(key);
        g.lead_count++;
        if (c.read_receipt === 'replied') g.reply_count++;
        if ((c.product_interests || []).length > 0) g.product_interest_count++;
        if (c.lead_state === 'won') g.conversion_count++;
    }

    let updated = 0;
    for (const rollup of groups.values()) {
        try {
            const { error } = await supabase.from('ad_attributions').upsert({
                ...rollup,
                updated_at: new Date().toISOString()
            }, { onConflict: 'business_id,ad_id' });
            if (error) throw new Error(error.message);
            updated++;
        } catch (e) {
            await logItemError('AdAttribution', 'ad_rollup', `${rollup.business_id}:${rollup.ad_id}`, e.message);
        }
    }
    log('AdAttribution', `✓ Rolled up counts for ${updated} ads.`);
}

// ─── Main Runner ───────────────────────────────────────────────────────────────
async function main() {
    console.log('--------------------------------------------------');
    console.log('🚀 Executing Local Database Enrichment Run');
    console.log('--------------------------------------------------');

    await resolveActiveInstance();
    await startRun(REQUESTED_CONTACT_IDS.length ? 'contact_pass' : 'full_pass');

    // Order matters: separate personal from business FIRST so nothing that is
    // not a business chat is ever scored or analysed.
    const classifyResult = await runClassificationPass();
    await runAdAttributionExtraction();
    const structuralResult = await runStructuralEnrichment();
    const nlpResult = await runNLPPass();
    await recomputeAdAttributionRollups();

    const totalErrors = nlpResult.errored + classifyResult.errored + structuralResult.errored;
    const attempted = classifyResult.business + classifyResult.personal + classifyResult.junk + classifyResult.unknown
        + classifyResult.errored + structuralResult.enriched + structuralResult.errored
        + nlpResult.enrichedCount + nlpResult.errored;
    const summary = {
        business: classifyResult.business, personal: classifyResult.personal,
        junk: classifyResult.junk, needs_review: classifyResult.unknown,
        analysed: nlpResult.enrichedCount, analysis_errors: nlpResult.errored,
        classify_errors: classifyResult.errored, structural_errors: structuralResult.errored,
        total_errors: totalErrors,
        // Downstream work (the persona pack) only trusts a run with almost no item errors.
        healthy: isHealthyRun(totalErrors, attempted),
    };
    await finishRun({
        phase: 'done',
        progress_done: 1,
        progress_total: 1,
        heartbeat_at: new Date().toISOString(),
        summary,
        structural_enriched: structuralResult.enriched,
        structural_errored: structuralResult.errored,
        nlp_enriched: nlpResult.enrichedCount,
        nlp_errored: nlpResult.errored,
        nlp_skipped: nlpResult.skipped,
        classify_counts: classifyResult,
    });

    if (summary.healthy) {
        log('Summary', `✅ ANALYSIS COMPLETE for ${BUSINESS_ID}: ${summary.business} business, ${summary.personal} personal, ${summary.junk} junk, ${summary.needs_review} need review; ${summary.analysed} analysed; ${totalErrors} errors.`);
    } else {
        warn('Summary', `⚠️ ANALYSIS FINISHED WITH TOO MANY ERRORS for ${BUSINESS_ID}: ${totalErrors} item errors (${summary.business} business, ${summary.personal} personal, ${summary.analysed} analysed). Not treated as complete by the persona pack. See enrichment_errors, then re-run to retry the failed chats.`);
    }
    console.log('--------------------------------------------------');
    console.log('✅ Done! Check enrichment_errors table for any per-item failures.');
    console.log('--------------------------------------------------');
    process.exit(0);
}

main().catch(async (e) => {
    err('Main', `Execution failed: ${e.message}`);
    err('Summary', `❌ ANALYSIS FAILED for ${BUSINESS_ID || 'unknown business'}: ${e.message}`);
    await markRunFailed(e.message);
    process.exit(1);
});