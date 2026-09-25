import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { resolveLeadClassification } from './src/leadClassification.js';

dotenv.config();

// ─── Config ───────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const OPENAI_KEY   = process.env.OPENAI_API_KEY;
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

async function startRun(runType) {
    RUN_ID = crypto.randomUUID();
    try {
        await supabase.from('enrichment_runs').insert({
            id: RUN_ID,
            run_type: runType,
            business_id: BUSINESS_ID || null,
            started_at: new Date().toISOString(),
            status: 'running'
        });
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
        await supabase.from('enrichment_runs').update({
            status: 'completed',
            finished_at: new Date().toISOString(),
            ...counts
        }).eq('id', RUN_ID);
    } catch (e) {
        warn('RunLog', `Could not finalize run record: ${e.message}`);
    }
}

async function resolveActiveInstance() {
    let sessionsQuery = supabase
        .from('whatsapp_sessions')
        .select('business_id, instance_name, status, updated_at')
        .eq('status', 'connected')
        .order('updated_at', { ascending: false })
        .limit(1);
    if (REQUESTED_BUSINESS_ID) sessionsQuery = sessionsQuery.eq('business_id', REQUESTED_BUSINESS_ID);

    const { data: session, error } = await sessionsQuery.maybeSingle();
    if (error) throw new Error(`Active WhatsApp session lookup failed: ${error.message}`);
    if (!session) {
        throw new Error(REQUESTED_BUSINESS_ID
            ? `No connected WhatsApp session found for business ${REQUESTED_BUSINESS_ID}`
            : 'No connected WhatsApp session found');
    }

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
async function logAiUsage(businessId, callRunId, promptTokens, completionTokens) {
    try {
        const baselineCost = parseFloat((
            promptTokens     * TEXT_INPUT_COST_PER_TOKEN +
            completionTokens * TEXT_OUTPUT_COST_PER_TOKEN
        ).toFixed(6));
        const operationalCost = parseFloat((baselineCost * BILLING_MULTIPLIER).toFixed(6));

        await supabase.from('ai_usage_log').insert({
            business_id:        businessId,
            run_id:             callRunId,
            bot_id:             'enrichment_worker_local',
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

function deriveLeadState(currentState, hasAnyInbound, daysSinceLastInbound) {
    if (PROTECTED_STATES.has(currentState)) return currentState;
    if (!hasAnyInbound) return currentState || 'new';

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

function deriveLeadQuality(intentScore, leadState) {
    if (leadState === 'won')  return 'hot';
    if (leadState === 'lost') return 'cold';
    if (intentScore === null) return null;
    if (intentScore >= 70)    return 'hot';
    if (intentScore >= 40)    return 'warm';
    return 'cold';
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
        .select('id, business_id, is_ad_lead'));
    if (BUSINESS_ID) contactsQuery = contactsQuery.eq('business_id', BUSINESS_ID);

    let contacts;
    try {
        contacts = await fetchAllPages((from, to) => contactsQuery.range(from, to));
    } catch (e) {
        await logItemError('AdAttribution', 'query', 'contacts', e.message);
        return;
    }
    log('AdAttribution', `${contacts.length} contacts to check.`);

    for (const contact of contacts) {
        try {
            const messages = await fetchContactMessages(contact.id);
            const firstInbound = messages
                .filter(message => message.direction === 'in' || message.direction === 'inbound')
                .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0];

            if (!firstInbound) continue;

            const ad = extractAdReferral(firstInbound.raw_payload);

            if (!ad) {
                noMatch++;
                if (contact.is_ad_lead && !sampledShapeLogged) {
                    warn('AdAttribution', `Contact ${contact.id} is flagged is_ad_lead but no referral shape matched. Sample raw_payload: ${JSON.stringify(firstInbound.raw_payload).slice(0, 1500)}`);
                    sampledShapeLogged = true;
                }
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
        } catch (e) {
            await logItemError('AdAttribution', 'contact', contact.id, e.message);
        }
        await sleepBetweenContacts();
    }
    log('AdAttribution', `✓ ${matched} matched with ad_id, ${noAdId} matched without ad_id, ${noMatch} no referral found.`);
}

// ─── Step 2: Structural Enrichment Pass ───────────────────────────────────────
async function runStructuralEnrichment() {
    log('Structural', 'Starting structural calculation pass...');
    let enriched = 0, errored = 0;

    let contactsQuery = applyContactScope(supabase
        .from('contacts')
        .select('id, business_id, lead_state, lead_type, is_ad_lead')
        .neq('lead_type', 'personal'));
    if (BUSINESS_ID) contactsQuery = contactsQuery.eq('business_id', BUSINESS_ID);

    let contacts;
    try {
        contacts = await fetchAllPages((from, to) => contactsQuery.range(from, to));
    } catch (e) {
        await logItemError('Structural', 'query', 'contacts', e.message);
        return { enriched, errored };
    }

    if (!contacts.length) {
        warn('Structural', 'No eligible contacts found.');
        return { enriched, errored };
    }
    log('Structural', `${contacts.length} eligible contacts found.`);

    for (const contact of contacts) {
        try {
            const messages = await fetchContactMessages(contact.id);
            const [readReceipt, mediaFlags, awaiting] = await Promise.all([
                computeReadReceipt(contact.id, messages),
                computeMediaFlags(contact.id, messages),
                computeAwaitingReply(contact.id, messages)
            ]);

            const inboundMessages = messages.filter(message => message.direction === 'in' || message.direction === 'inbound');
            const lastInbound = inboundMessages
                .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];

            const daysSince = lastInbound
                ? (Date.now() - new Date(lastInbound.created_at).getTime()) / 86400000
                : 90;

            const newLeadState = deriveLeadState(contact.lead_state, inboundMessages.length > 0, daysSince);
            const intentScore = computeIntentScore(
                { ...contact, lead_state: newLeadState },
                readReceipt, mediaFlags, daysSince, awaiting.awaiting_reply
            );
            const leadQuality = deriveLeadQuality(intentScore, newLeadState);

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
                structural_enriched_at:  new Date().toISOString()
            }).eq('id', contact.id);

            if (updateError) throw new Error(updateError.message);
            enriched++;
        } catch (e) {
            errored++;
            await logItemError('Structural', 'contact', contact.id, e.message);
        }
        await sleepBetweenContacts();
    }
    log('Structural', `✓ ${enriched} contacts updated, ${errored} errored.`);
    return { enriched, errored };
}

// ─── Step 3: NLP AI Extraction ────────────────────────────────────────────────
function buildTranscript(messages) {
    return messages
        .map(m => {
            const isCustomer = m.direction === 'in' || m.direction === 'inbound';
            const role = isCustomer ? 'CUSTOMER' : 'BUSINESS';
            const text = m.content?.text || (typeof m.content === 'string' ? m.content : '') || m.type || '';
            const type = m.type && m.type !== 'text' ? ` [${m.type}]` : '';
            return `${role}: ${text}${type}`;
        })
        .join('\n');
}

async function runNLPExtraction(transcript, businessContext, productsCatalog, existingProfileContext, structuralSignals) {
    const systemPrompt = `You are a sales intelligence system reading WhatsApp sales conversations for small businesses in Kenya and East Africa. You will be given hard structural facts about the conversation — treat these as ground truth and let them anchor your classification. Do not contradict them.

STAGE DEFINITIONS (use exactly one):
- Awareness: customer just arrived, hasn't stated a need yet.
- Consideration: customer has described a need or asked general questions, no specific product picked.
- Product interest: customer has named or clearly implied a specific product/service.
- Negotiation: price, quantity, delivery, or terms are actively being discussed.
- Stalled: business has NOT sent the last message, structural signal says days_since_last_inbound is high, or the conversation trailed off without a next step.
- Closed: a sale, refusal, or explicit end was reached.
- Ghosted: long silence after clear buying signal (use awaiting_reply / days_since_last_inbound to judge, not vibes).

RULES:
1. If structural_signals.awaiting_reply is true, this conversation currently has an unanswered customer message — this should almost always push follow_up_urgency toward "hot" unless the customer explicitly said not to contact them, and next_action_plan MUST address replying to that specific message.
2. If structural_signals.days_since_last_inbound is large (>7) and there was no clear close, lean toward conv_stage "Stalled" or "Ghosted" rather than inventing progress that isn't in the transcript.
3. Review "CURRENT STABLE PROFILE STATE" — if a field is already populated and still accurate, echo it back exactly. Only change a field when the fresh transcript gives a clear reason to.
4. Fill null fields when the transcript gives enough evidence; otherwise leave null rather than guessing.
5. Cross-reference product mentions against the catalog: match exact product_id/name if found; otherwise infer the rough item name, set product_id null, and set match_status "no match".
6. Decide whether this is a business-use WhatsApp chat or a personal/private chat. If it is clearly personal, family-only, private-life, medical, relationship, or unrelated personal content, set lead_type to "personal", is_business_chat to false, and quality_score to 1. Do not treat personal chats as sales leads.
7. If the transcript is not clearly business and not clearly personal, set lead_type to "junk" and is_business_chat to false rather than guessing a sale.
8. Never invent a specific number, date, or promise the customer didn't actually state.

Return ONLY a valid JSON object matching this schema:
{
  "intent":                 "buying | browsing | support | price_check | referral | unknown",
  "follow_up_urgency":      "hot | warm | cold",
  "quality_score":          integer 1-10,
  "lead_summary":           "one sentence what this lead wants (max 20 words)",
  "lead_type":              "business | personal | junk",
  "is_business_chat":       boolean,
  "personal_reason":        "short reason if lead_type is personal, otherwise null",
  "customer_intent":        "short CRM phrase (max 8 words)",
  "psychology":             "one sentence buyer psychology",
  "conv_stage":             "Awareness | Consideration | Product interest | Negotiation | Stalled | Closed | Ghosted",
  "vibe_check":             "2 sentences max: what the sales rep should know right now",
  "next_action_plan":       "single most impactful next action (one sentence) — if awaiting_reply is true, this must be about replying",
  "competitor_mentions":    ["string"],
  "objection_tags":         ["price | not_ready | found_elsewhere | needs_more_info | trust_concerns | size_availability"],
  "pre_purchase_questions": ["verbatim questions before buying (max 5)"],
  "product_tags":           ["product categories mentioned"],
  "matched_products":       [
    {
      "product_id": "Exact product ID string from catalog if matched, otherwise null",
      "product_name": "Exact product name from catalog if matched, otherwise write the rough/inferred item name",
      "match_status": "matched | no match"
    }
  ],
  "sentiment_score":        number -1.0 to 1.0,
  "price_objection":        boolean
}`;

    const userPayloadPrompt = `BUSINESS CONTEXT CONFIGURATION:
${businessContext}

AVAILABLE BUSINESS PRODUCTS CATALOG:
${productsCatalog || 'No products registered.'}

STRUCTURAL SIGNALS (ground truth, computed from raw data — do not contradict):
${JSON.stringify(structuralSignals, null, 2)}

CURRENT STABLE PROFILE STATE:
${JSON.stringify(existingProfileContext, null, 2)}

FRESH TRANSCRIPT STREAM RUNTIME ACTIVITY:
${transcript}`;

    try {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
            body: JSON.stringify({
                model:       OPENAI_MODEL,
                max_tokens:  850,
                temperature: 0.1,
                response_format: { type: 'json_object' },
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user',   content: userPayloadPrompt }
                ]
            })
        });

        if (!res.ok) {
            const errorBody = await res.text();
            throw new Error(`OpenAI API returned ${res.status}: ${errorBody.slice(0, 1000)}`);
        }

        const body  = await res.json();
        const usage = body.usage || {};
        const raw   = body.choices?.[0]?.message?.content?.trim() || '';
        const clean = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();

        return {
            nlp: JSON.parse(clean),
            promptTokens: usage.prompt_tokens || 0,
            completionTokens: usage.completion_tokens || 0
        };
    } catch (e) {
        throw new Error(`NLP extraction failed: ${e.message}`);
    }
}

async function applyNLPResults(businessId, contactId, conversationId, nlp, callRunId, promptTokens, completionTokens) {
    if (!nlp) return;

    await logAiUsage(businessId, callRunId, promptTokens, completionTokens);

    const { data: existingContact } = await supabase
        .from('contacts')
        .select('product_interests, lead_type')
        .eq('id', contactId)
        .single();

    const leadDecision = resolveLeadClassification(nlp, existingContact?.lead_type ?? null);

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

    const { data: currentConv } = await supabase
        .from('conversations')
        .select('customer_intent, psychology, vibe_check, context_summary, is_business_chat')
        .eq('id', conversationId)
        .single();
    const convUpdate = {};
    if (nlp.lead_summary || nlp.personal_reason) convUpdate.context_summary = nlp.lead_summary || nlp.personal_reason;
    if (leadDecision.isBusinessChat !== undefined) convUpdate.is_business_chat = leadDecision.isBusinessChat;
    if (nlp.customer_intent) convUpdate.customer_intent = nlp.customer_intent;
    if (nlp.psychology) convUpdate.psychology = nlp.psychology;
    if (nlp.vibe_check) convUpdate.vibe_check = nlp.vibe_check;
    if (nlp.quality_score !== undefined) {
        convUpdate.lead_quality = deriveLeadQuality(
            Number(nlp.quality_score),
            leadDecision.isBusinessChat ? 'engaged' : 'cold'
        );
    }

    if (Object.keys(convUpdate).length > 0) {
        const { error: conversationError } = await supabase.from('conversations').update(convUpdate).eq('id', conversationId);
        if (conversationError) throw new Error(`conversation write failed: ${conversationError.message}`);
    }

    const matchedNames = (nlp.matched_products || []).map(p => p.product_name);
    const mergedInterests = [...new Set([
        ...(existingContact?.product_interests || []),
        ...(nlp.product_tags || []),
        ...matchedNames
    ])];

    const contactUpdate = {
        nlp_enriched_at: new Date().toISOString(),
        ...(nlp.intent            !== undefined && { intent:            nlp.intent            }),
        ...(nlp.follow_up_urgency !== undefined && { follow_up_urgency: nlp.follow_up_urgency }),
        ...(nlp.quality_score     !== undefined && { quality_score:     nlp.quality_score     }),
        ...(nlp.lead_summary      !== undefined && { lead_summary:      nlp.lead_summary      }),
    };
    if (mergedInterests.length > 0) contactUpdate.product_interests = mergedInterests;

    if (leadDecision.leadType) {
        contactUpdate.lead_type = leadDecision.leadType;
    } else if (existingContact?.lead_type === 'personal') {
        contactUpdate.lead_type = 'personal';
    } else if (existingContact?.lead_type === 'pending_analysis' || existingContact?.lead_type === 'pending' || existingContact?.lead_type === 'junk' || existingContact?.lead_type === 'business' || !existingContact?.lead_type) {
        const nextLeadType = leadDecision.leadType || (nlp.quality_score >= 3 ? 'business' : 'junk');
        contactUpdate.lead_type = nextLeadType;
    }
    if (nlp.quality_score !== undefined) {
        contactUpdate.lead_quality = deriveLeadQuality(
            Number(nlp.quality_score),
            leadDecision.isBusinessChat ? 'engaged' : 'cold'
        );
    }

    const safeContactUpdate = Object.fromEntries(
        Object.entries(contactUpdate).filter(([, v]) => v !== null && v !== undefined)
    );
    if (Object.keys(safeContactUpdate).length > 0) {
        const { error: contactError } = await supabase.from('contacts').update(safeContactUpdate).eq('id', contactId);
        if (contactError) throw new Error(`contact write failed: ${contactError.message}`);
    }
}

async function runNLPPass() {
    log('NLP', 'Starting AI extraction pass...');
    let enrichedCount = 0, errored = 0, skipped = 0;

    let conversationsQuery = applyContactScope(supabase
        .from('conversations')
        .select(`
            id, business_id, contact_id, customer_intent, psychology, vibe_check,
            conversation_enrichment ( last_enriched_at, conv_stage, next_action_plan ),
            contacts!inner ( id, intent, follow_up_urgency, quality_score, lead_summary, awaiting_reply, hours_awaiting_reply )
        `), 'contact_id');
    if (BUSINESS_ID) conversationsQuery = conversationsQuery.eq('business_id', BUSINESS_ID);

    let conversations;
    try {
        conversations = await fetchAllPages((from, to) => conversationsQuery.range(from, to));
    } catch (e) {
        await logItemError('NLP', 'query', 'conversations', e.message);
        return { enrichedCount, errored, skipped };
    }

    if (!conversations.length) {
        warn('NLP', 'No conversations found.');
        return { enrichedCount, errored, skipped };
    }
    log('NLP', `${conversations.length} conversations found.`);

    const businessCache = new Map();
    const productsCache = new Map();

    for (const conv of conversations) {
        try {
            const enrichment = Array.isArray(conv.conversation_enrichment)
                ? conv.conversation_enrichment[0]
                : conv.conversation_enrichment;
            if (!conv.business_id || !conv.contact_id) {
                warn('NLP', `Skipping conversation ${conv.id}: missing business_id or contact_id.`);
                skipped++;
                continue;
            }

            const businessId = conv.business_id;
            if (!businessCache.has(businessId)) {
                const { data: business, error: businessError } = await supabase
                    .from('businesses')
                    .select('id, name')
                    .eq('id', businessId)
                    .maybeSingle();
                if (businessError) throw new Error(`Business lookup failed: ${businessError.message}`);
                businessCache.set(businessId, business || { id: businessId, name: 'unknown' });
            }

            if (!productsCache.has(businessId)) {
                const { data: products, error: productsError } = await supabase
                    .from('products')
                    .select('id, title')
                    .eq('business_id', businessId);
                if (productsError) throw new Error(`Product lookup failed: ${productsError.message}`);
                productsCache.set(businessId, (products || []).map(p => `- ID: ${p.id} | Name: ${p.title}`).join('\n'));
            }

            const business = businessCache.get(businessId);
            const productsCatalog = productsCache.get(businessId);

            const messages = await fetchContactMessages(conv.contact_id);
            if (!messages?.length) { skipped++; continue; }

            const contact = Array.isArray(conv.contacts) ? conv.contacts[0] : conv.contacts;
            const lastMsg = messages[messages.length - 1];
            const daysSinceLastInbound = (() => {
                const lastInbound = [...messages].reverse().find(m => m.direction === 'in' || m.direction === 'inbound');
                if (!lastInbound) return null;
                return Math.round(((Date.now() - new Date(lastInbound.created_at).getTime()) / 86400000) * 10) / 10;
            })();

            const isLastMsgInbound = lastMsg.direction === 'in' || lastMsg.direction === 'inbound';
            const structuralSignals = {
                awaiting_reply: contact?.awaiting_reply ?? isLastMsgInbound,
                hours_awaiting_reply: contact?.hours_awaiting_reply ?? null,
                days_since_last_inbound: daysSinceLastInbound,
                total_messages: messages.length
            };

            const existingProfileContext = {
                intent: contact?.intent || null,
                follow_up_urgency: contact?.follow_up_urgency || null,
                quality_score: contact?.quality_score || null,
                lead_summary: contact?.lead_summary || null,
                customer_intent: conv.customer_intent || null,
                psychology: conv.psychology || null,
                vibe_check: conv.vibe_check || null,
                conv_stage: enrichment?.conv_stage || null,
                next_action_plan: enrichment?.next_action_plan || null
            };

            const transcript = buildTranscript(messages.slice(-MAX_TRANSCRIPT_MSGS));
            const callRunId = crypto.randomUUID();
            log('NLP', `Analyzing business ${businessId} -> contact ${conv.contact_id} -> conversation ${conv.id} (${messages.length} messages)...`);

            const result = await runNLPExtraction(
                transcript,
                `Business: ${business.name || 'unknown'}`,
                productsCatalog,
                existingProfileContext,
                structuralSignals
            );

            await applyNLPResults(
                businessId, conv.contact_id, conv.id, result.nlp,
                callRunId, result.promptTokens, result.completionTokens
            );
            enrichedCount++;

        } catch (e) {
            errored++;
            await logItemError('NLP', 'conversation', conv.id, e.message);
        }
        await sleepBetweenContacts();
    }
    log('NLP', `✓ ${enrichedCount} enriched, ${errored} errored, ${skipped} skipped.`);
    return { enrichedCount, errored, skipped };
}

// ─── Step 4: Recompute Ad Attribution Rollups ──────────────────────────────────
async function recomputeAdAttributionRollups() {
    log('AdAttribution', 'Recomputing per-ad lead/reply/conversion counts...');

    let contactsQuery = applyContactScope(supabase
        .from('contacts')
        .select('id, business_id, ad_id, read_receipt, lead_state, product_interests')
        .not('ad_id', 'is', null));
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

    await runAdAttributionExtraction();
    const structuralResult = await runStructuralEnrichment();
    const nlpResult = await runNLPPass();
    await recomputeAdAttributionRollups();

    await finishRun({
        structural_enriched: structuralResult.enriched,
        structural_errored: structuralResult.errored,
        nlp_enriched: nlpResult.enrichedCount,
        nlp_errored: nlpResult.errored,
        nlp_skipped: nlpResult.skipped,
    });

    console.log('--------------------------------------------------');
    console.log('✅ Done! Check enrichment_errors table for any per-item failures.');
    console.log('--------------------------------------------------');
    process.exit(0);
}

main().catch(async (e) => {
    err('Main', `Execution failed: ${e.message}`);
    if (RUN_ID) {
        try {
            await supabase.from('enrichment_runs').update({
                status: 'failed', finished_at: new Date().toISOString(), fatal_error: e.message
            }).eq('id', RUN_ID);
        } catch {}
    }
    process.exit(1);
});