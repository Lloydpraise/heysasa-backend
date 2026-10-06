import { supabase } from '../config/supabase.js';
import { 
    isGroupOrBroadcast, 
    extractMessageContent, 
    extractAdAttribution, 
    classifyLeadType, 
    extractProductInterests, 
    extractPhone,
    extractMessageJid,
    preScanPayload 
} from './dataCleaner.js';
import { 
    getOrCreateContact, 
    getOrCreateConversation, 
    recordAdAttribution, 
    updateLeadStateOnReply, 
    cancelPendingFollowUps,
    recordCampaignStepReply,
    recordCampaignStepReaction,
    requestStageReview
} from './dbService.js';
import { debugLog, logEvent } from './debugConsole.js';
import { describeConnectionUpdate, summariseClose } from './connectionDiagnostics.js';
import { decideSettle, normaliseEvolutionState, readConfirmedState, webhookStateOf } from './connectionSettle.js';
import { deleteSessionRecord, getEvolutionConnectionState } from './evolutionConnections.js';
import { scheduleDisconnectNotice } from './disconnectNotice.js';
import { pauseCampaignsForDisconnectedInstance } from './disconnectCampaigns.js';
import { triggerChatAi } from '../chatAi/index.js';

async function notifyFollowupEngineActivity(contactId, conversationId, campaignStepEventId, inbound) {
    const token = process.env.DEBUG_TOKEN;
    if (!token) return;

    try {
        const port = process.env.FOLLOWUP_ENGINE_PORT || '3001';
        const response = await fetch(`http://127.0.0.1:${port}/admin/engine/lead-activity`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-debug-token': token },
            body: JSON.stringify({
                contact_id: contactId,
                conversation_id: conversationId,
                campaign_step_event_id: campaignStepEventId,
                inbound,
            }),
            signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error(`follow-up engine returned ${response.status}`);
    } catch (error) {
        debugLog('error', 'Lead activity', 'Failed to trigger follow-up classifiers', { contactId, error: error.message });
    }
}

// instance -> business never changes in practice, and for sessions whose
// businesses.evolution_instance_id is empty (e.g. lashesbyshazz) every webhook paid for
// two Supabase round trips, which were 4-5s during the Oct 6 reconnect. Positive
// results only, so an unknown instance still errors every time.
const BUSINESS_CACHE_TTL_MS = 5 * 60_000;
const businessIdCache = new Map();

export async function resolveBusinessId(payload) {
    const instanceName = payload?.instance || payload?.data?.instance;
    if (!instanceName) throw new Error('evolution_instance_missing');
    const cached = businessIdCache.get(instanceName);
    if (cached && cached.expires > Date.now()) return cached.businessId;
    const businessId = await lookupBusinessId(instanceName);
    businessIdCache.set(instanceName, { businessId, expires: Date.now() + BUSINESS_CACHE_TTL_MS });
    return businessId;
}

async function lookupBusinessId(instanceName) {

    const { data: business, error: businessError } = await supabase
        .from('businesses')
        .select('business_id')
        .eq('evolution_instance_id', instanceName)
        .maybeSingle();
    if (!businessError && business) return business.business_id;

    const { data: session, error: sessionError } = await supabase
        .from('whatsapp_sessions')
        .select('business_id')
        .eq('instance_name', instanceName)
        .maybeSingle();
    if (!sessionError && session) return session.business_id;

    throw new Error(`unknown_evolution_instance:${instanceName}`);
}

// One connection.update at a time per instance, so settling one webhook (which
// reads Evolution and then writes the row) never interleaves with the next.
const instanceLocks = new Map();
export async function withInstanceLock(instanceName, fn) {
    const previous = instanceLocks.get(instanceName) || Promise.resolve();
    const run = previous.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    instanceLocks.set(instanceName, tail);
    try { return await run; } finally { if (instanceLocks.get(instanceName) === tail) instanceLocks.delete(instanceName); }
}

const EVOLUTION_READ_TIMEOUT_MS = 8000;
const CLOSE_CONFIRM_DELAY_MS = Number(process.env.CLOSE_CONFIRM_DELAY_MS || 4000);

// What Evolution itself says right now: 'open' | 'connecting' | 'close' | 'missing'
// (instance does not exist there) | null (could not be reached, so nothing is confirmed).
export async function readEvolutionState(instanceName) {
    let timer;
    try {
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('evolution_timeout')), EVOLUTION_READ_TIMEOUT_MS); });
        const payload = await Promise.race([getEvolutionConnectionState(instanceName), timeout]);
        return normaliseEvolutionState(payload);
    } catch (error) {
        return error?.status === 404 ? 'missing' : null;
    } finally {
        clearTimeout(timer);
    }
}

// Runs only after Evolution has confirmed the number is disconnected: logs it, pauses
// campaigns, deletes the session row and tells the owner.
export async function handleConfirmedDisconnect({ info, businessId, instanceName }) {
    // Logged FIRST, before any database call, so the reason is kept even if
    // the session lookup or delete below fails (e.g. a DNS blip to Supabase).
    // 'warn' rows are kept 45 days and show in the admin persisted logs.
    const disconnectLog = logEvent({
        level: 'warn',
        area: 'connection',
        event: 'connection.disconnected',
        message: `${summariseClose(info)} (confirmed by Evolution)`,
        business_id: businessId,
        entity_id: instanceName || null,
        details: {
            instance: instanceName,
            state: info.state,
            status_code: info.statusCode,
            meaning: info.meaning,
            reason_text: info.reasonText,
            payload: info.raw,
        },
    });
    try {
        // Only a number that was actually connected counts as "dropped" (not a QR that timed out).
        const { data: existingSessions, error: sessionError } = await supabase.from('whatsapp_sessions').select('id, status')
            .eq('business_id', businessId).eq('instance_name', instanceName).in('status', ['connected', 'disconnected']).limit(1);
        if (sessionError) throw sessionError;
        const existingSession = existingSessions?.[0];
        const wasConnected = existingSession?.status === 'connected';
        if (wasConnected) {
            const { error: markDisconnectedError } = await supabase.from('whatsapp_sessions')
                .update({ status: 'disconnected', updated_at: new Date().toISOString() })
                .eq('id', existingSession.id)
                .eq('business_id', businessId);
            if (markDisconnectedError) throw markDisconnectedError;
        }
        if (existingSession) {
            try {
                const pausedCampaigns = await pauseCampaignsForDisconnectedInstance(supabase, { businessId, instanceName });
                if (pausedCampaigns.length) {
                    logEvent({
                        level: 'warn',
                        area: 'campaign',
                        event: 'campaigns.paused_whatsapp_disconnected',
                        message: `Paused ${pausedCampaigns.length} campaign(s) because WhatsApp disconnected`,
                        business_id: businessId,
                        entity_id: instanceName,
                        details: { instance: instanceName, campaign_ids: pausedCampaigns.map(campaign => campaign.id) },
                    });
                }
            } catch (error) {
                logEvent({
                    level: 'error',
                    area: 'campaign',
                    event: 'campaigns.disconnect_pause_failed',
                    message: `Could not pause campaigns after WhatsApp disconnected: ${error?.message || error}`,
                    business_id: businessId,
                    entity_id: instanceName,
                    details: { instance: instanceName, error },
                });
                throw error;
            }
        }
        await deleteSessionRecord(instanceName, businessId);
        console.log(`[Webhook] Removed disconnected WhatsApp session ${instanceName}`);
        if (existingSession) scheduleDisconnectNotice({ businessId, instanceName });
    } catch (error) {
        // The disconnect itself is already logged above; say what failed afterwards.
        logEvent({
            level: 'error',
            area: 'connection',
            event: 'connection.disconnect_handling_failed',
            message: `Disconnect was logged but handling it failed: ${error?.message || error}`,
            business_id: businessId,
            entity_id: instanceName,
            details: { instance: instanceName, disconnect_log_id: disconnectLog.id, error },
        });
        throw error;
    }
}

export async function processConnectionUpdate(payload, businessId) {
    const info = describeConnectionUpdate(payload);
    const instanceName = payload?.instance || payload?.data?.instance;
    if (!instanceName) throw new Error('evolution_instance_missing');
    const webhookState = webhookStateOf(info.state);
    if (webhookState === 'close') {
        // Kept even if everything after fails; the row is only deleted once Evolution confirms.
        logEvent({
            level: 'warn', area: 'connection', event: 'connection.close_received',
            message: `${summariseClose(info)} (checking with Evolution before doing anything)`,
            business_id: businessId, entity_id: instanceName,
            details: { instance: instanceName, status_code: info.statusCode, meaning: info.meaning, reason_text: info.reasonText, payload: info.raw },
        });
    }
    return withInstanceLock(instanceName, () => settleConnection({ payload, businessId, instanceName, info, webhookState }));
}

async function settleConnection({ payload, businessId, instanceName, info, webhookState }) {
    const evolution = await readConfirmedState(() => readEvolutionState(instanceName), { delayMs: CLOSE_CONFIRM_DELAY_MS });

    // whatsapp_sessions has no unique constraint on instance_name, so
    // upsert({ onConflict: 'instance_name' }) fails with a Postgres
    // "no unique or exclusion constraint" error on every call. Look the
    // row up first, then update or insert, same pattern saveConnectionState
    // in evolutionConnections.js already uses.
    const { data: existing, error: findError } = await supabase
        .from('whatsapp_sessions')
        .select('id, status, session_data')
        .eq('instance_name', instanceName)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    if (findError) throw findError;

    const { action } = decideSettle({ webhookState, evolution, existingStatus: existing?.status });
    const result = { ...info, outcome: action, evolution };

    if (action === 'disconnect') {
        await handleConfirmedDisconnect({ info, businessId, instanceName });
        return result;
    }

    if (action === 'keep') {
        logEvent({
            level: webhookState === 'close' ? 'warn' : 'debug', area: 'connection', event: 'connection.update_kept',
            message: webhookState === 'close'
                ? `Close for ${instanceName} not confirmed (Evolution says ${evolution ?? 'unreachable'}): session kept`
                : `Kept ${instanceName} as ${existing?.status ?? 'none'} (webhook ${webhookState}, Evolution ${evolution ?? 'unreachable'})`,
            business_id: businessId, entity_id: instanceName,
            details: { webhook_state: webhookState, evolution_state: evolution, status: existing?.status ?? null },
        });
        return result;
    }

    const confirmed = action === 'connected';
    const previous = existing?.session_data || {};
    const values = {
        business_id: businessId,
        instance_name: instanceName,
        status: action,
        session_data: {
            // Pairing codes only matter while pending; once connected they are cleared.
            qr_code: confirmed ? null : (previous.qr_code || null),
            pairing_code: confirmed ? null : (previous.pairing_code || null),
            raw_payload: payload,
            evolution_state: evolution ?? 'unreachable',
            confirmed_at: evolution ? new Date().toISOString() : (previous.confirmed_at || null),
        },
        updated_at: new Date().toISOString(),
    };
    const { error } = existing?.id
        ? await supabase.from('whatsapp_sessions').update(values).eq('id', existing.id)
        : await supabase.from('whatsapp_sessions').insert(values);
    if (error) throw error;
    return result;
}

// Was called but never defined anywhere in this file — every live message
// hit a ReferenceError here, was caught by the try/catch below, logged, and
// dropped. Built from the same primitives processHistorySync already uses
// (extractMessageContent/extractAdAttribution/isGroupOrBroadcast) so both
// paths parse a raw Baileys message identically.
function parseMessagePayload(rawMessage) {
    const jid = extractMessageJid(rawMessage);
    if (!jid || isGroupOrBroadcast(jid) || rawMessage?.messageStubType) return null;

    const content = extractMessageContent(rawMessage);
    if (!content) return null;

    return {
        jid,
        // pushName on an outgoing message is the OWNER's own display name, not the
        // contact's. Using it renamed customers to the business's own name
        // ("Kitchen And All", "Lloyd Praise"). Only incoming messages carry the contact's name.
        pushName: rawMessage?.key?.fromMe === true ? null : (rawMessage?.pushName || rawMessage?.verifiedBizName || null),
        isFromMe: rawMessage?.key?.fromMe === true,
        keyId: rawMessage?.key?.id || null,
        timestamp: rawMessage?.messageTimestamp,
        text: content.text || '',
        type: content.type || 'text',
        adAttribution: extractAdAttribution(rawMessage),
        reactedMessageId: content.reactedMessageId || null,
    };
}

export async function processLiveMessage(messages, businessId) {
    // Confirmed against a live payload: Evolution sends `data` as a single
    // message object for messages.upsert, not an array. Normalize here so
    // callers can pass either shape without guessing.
    const list = Array.isArray(messages) ? messages : [messages].filter(Boolean);

    for (const rawMessage of list) {
        try {
            const parsed = parseMessagePayload(rawMessage);
            if (!parsed) continue;

            const { jid, pushName, isFromMe, keyId, timestamp, text, type, adAttribution, reactedMessageId } = parsed;

            // 1. Resolve Contact safely
            const contact = await getOrCreateContact(businessId, jid, pushName);
            if (!contact?.id) {
                debugLog('error', 'Contact ready', 'Failed to retrieve or build contact ID', { businessId, jid });
                continue;
            }
            const contactId = contact.id;
            let campaignStepEventId = null;

            // 2. Resolve Conversation
            const conversationId = await getOrCreateConversation(businessId, contactId, jid);

            // 3. Process Ad Attribution if present
            if (adAttribution) {
                await recordAdAttribution(businessId, contactId, adAttribution);
            }

            // 4. Update state & cancel follow-ups on incoming user response,
            // and attribute the response back to whichever campaign step
            // it belongs to — a reaction attributes to the specific message
            // reacted to, anything else counts as a reply to the most
            // recent unreplied step (see recordCampaignStepReply/Reaction).
            if (!isFromMe) {
                await updateLeadStateOnReply(contactId, contact.lead_state);
                await cancelPendingFollowUps(contactId);

                if (type === 'reaction') {
                    await recordCampaignStepReaction(businessId, reactedMessageId, text);
                } else {
                    campaignStepEventId = await recordCampaignStepReply(contactId);
                    // The lead actually said something: queue a stage re-check.
                    // (Reactions carry no text, and history sync deliberately
                    // does not do this, so old chats never flood the queue.)
                    await requestStageReview(conversationId, 'responded');
                }
            } else if (type !== 'reaction') {
                await requestStageReview(conversationId, 'business_sent');
            }

            // 5. Store message record — real `messages` columns are
            // whatsapp_message_id/direction/role/agent_role/type/content
            // (jsonb, NOT NULL), matching processHistorySync below. The old
            // version wrote external_id/sender_type/message_type, none of
            // which exist on the table, so this insert failed on every call
            // even once bugs #1/#2 above were fixed. Upserting on
            // whatsapp_message_id (which has a real unique constraint) also
            // makes this safe against Evolution redelivering the same event.
            // Evolution echoes every message we send back as fromMe. If the follow-up engine or the chat AI
            // already saved that message under its own agent_role, keep it: relabelling it 'human' would make
            // the chat AI think the owner had taken over the chat.
            let echoOf = null;
            if (isFromMe && keyId) {
                const { data: known } = await supabase.from('messages').select('role, agent_role').eq('whatsapp_message_id', keyId).maybeSingle();
                if (known?.agent_role && known.agent_role !== 'human') echoOf = known;
            }

            const { error: msgError } = await supabase.from('messages').upsert({
                business_id: businessId,
                conversation_id: conversationId,
                contact_id: contactId,
                whatsapp_message_id: keyId,
                direction: isFromMe ? 'out' : 'in',
                role: echoOf ? echoOf.role : (isFromMe ? 'admin' : 'user'),
                agent_role: echoOf ? echoOf.agent_role : (isFromMe ? 'human' : 'legacy_ai'),
                type,
                content: { text, type },
                status: 'sent',
                is_read: isFromMe,
                raw_payload: rawMessage,
                created_at: timestamp ? new Date(timestamp * 1000).toISOString() : new Date().toISOString(),
            }, { onConflict: 'whatsapp_message_id', ignoreDuplicates: false });

            if (msgError) {
                debugLog('error', 'Message Insert', 'Failed to store incoming message', { businessId, keyId, error: msgError });
            } else if (type !== 'reaction') {
                void notifyFollowupEngineActivity(contactId, conversationId, campaignStepEventId, !isFromMe);
                if (!isFromMe) {
                    triggerChatAi({
                        businessId, conversationId, contactId,
                        message: {
                            keyId, text, type, isFromMe, isGroupOrBroadcast: isGroupOrBroadcast(jid),
                            sentAt: Number(timestamp) ? new Date(Number(timestamp) * 1000) : null,
                        },
                    });
                }
            }

        } catch (error) {
            debugLog('error', 'Process Live Message Loop', 'Error processing individual message', { businessId, error: error.message });
        }
    }
}

export async function processHistorySync(payload, businessIdOverride) {
    const businessId = businessIdOverride;
    // Confirmed against a live payload: for messages.set/MESSAGES_SET,
    // payload.data is a bare array of message objects — payload.data.messages
    // is undefined on an array, so contacts/chats/messages all silently
    // resolved to [] and this function did nothing. We still fall back to the
    // bundled-object shape defensively in case a different event/version
    // sends {contacts, chats, messages} together.
    const rawData = payload.data;
    const dataIsArray = Array.isArray(rawData);
    const contacts = dataIsArray ? [] : (rawData?.contacts || []);
    const chats    = dataIsArray ? [] : (rawData?.chats    || []);
    const messages = dataIsArray ? rawData : (rawData?.messages || []);

    console.log(`[History Sync] Processing contacts:${contacts.length} chats:${chats.length} messages:${messages.length}`);
    debugLog('info', 'History sync', 'Preparing history records', { businessId, contacts: contacts.length, chats: chats.length, messages: messages.length });

    const validContacts = contacts.filter(c => c.id && !isGroupOrBroadcast(c.id));
    const contactPayloads = validContacts.map(c => ({
        business_id:     businessId,
        social_platform: 'whatsapp',
        social_id:       c.id,
        name:            c.name || c.notify || c.verifiedName || 'Unknown',
        phone:           extractPhone(c.id),
        lead_state:      'new',
        lead_type:       'pending_analysis',
        is_ad_lead:      false
    }));

    let contactMap = {};
    if (contactPayloads.length > 0) {
        const { data: inserted, error } = await supabase
            .from('contacts')
            .upsert(contactPayloads, { onConflict: 'business_id, social_platform, social_id' })
            .select('id, social_id');
        if (!error && inserted) {
            contactMap = inserted.reduce((acc, c) => { acc[c.social_id] = c.id; return acc; }, {});
            debugLog('ok', 'DB history contacts', `Upserted ${inserted.length} contacts`, { businessId });
        } else if (error) {
            debugLog('error', 'DB history contacts', 'Contact history upsert failed', { businessId, error });
        }
    }

    const validChats = chats.filter(c => c.id && !isGroupOrBroadcast(c.id));
    const conversationPayloads = validChats
        .map(chat => ({
            business_id:  businessId,
            contact_id:   contactMap[chat.id],
            external_id:  chat.id,
            channel:      'whatsapp',
            type:         'dm',
            status:       (chat.unreadCount || 0) > 0 ? 'open' : 'closed',
            unread_count: chat.unreadCount || 0,
            ai_enabled:   true,
            active_agent: 'manager'
        }))
        .filter(c => c.contact_id != null);

    let convoMap = {};
    if (conversationPayloads.length > 0) {
        const { data: inserted, error } = await supabase
            .from('conversations')
            .upsert(conversationPayloads, { onConflict: 'business_id, contact_id' })
            .select('id, external_id');
        if (!error && inserted) {
            convoMap = inserted.reduce((acc, c) => { acc[c.external_id] = c.id; return acc; }, {});
            debugLog('ok', 'DB history conversations', `Upserted ${inserted.length} conversations`, { businessId });
        } else if (error) {
            debugLog('error', 'DB history conversations', 'Conversation history upsert failed', { businessId, error });
        }
    }

    const messagePayloads = [];

    // In the confirmed bare-array shape, contactMap/convoMap above are empty
    // (no companion contacts/chats in this payload), so every message would
    // be dropped for lack of a pre-built conversationId. Resolve per-jid on
    // demand instead — same helpers processLiveMessage uses — caching in
    // contactMap/convoMap so repeat senders in one sync batch only hit the
    // DB once each.
    for (const msg of messages) {
        const jid = extractMessageJid(msg);
        if (!jid || isGroupOrBroadcast(jid) || msg.messageStubType) continue;

        const content = extractMessageContent(msg);
        if (!content) continue;

        let contactId = contactMap[jid];
        if (!contactId) {
            try {
                const contact = await getOrCreateContact(businessId, jid, msg?.key?.fromMe === true ? null : msg.pushName);
                contactId = contact?.id || null;
                if (contactId) contactMap[jid] = contactId;
            } catch (error) {
                debugLog('error', 'DB history contact resolve', 'Could not resolve contact for message', { businessId, jid, error: error.message });
            }
        }
        if (!contactId) continue;

        let conversationId = convoMap[jid];
        if (!conversationId) {
            try {
                conversationId = await getOrCreateConversation(businessId, contactId, jid);
                if (conversationId) convoMap[jid] = conversationId;
            } catch (error) {
                debugLog('error', 'DB history conversation resolve', 'Could not resolve conversation for message', { businessId, jid, error: error.message });
            }
        }
        if (!conversationId) continue;

        const isFromMe = msg.key.fromMe === true;
        const ts       = msg.messageTimestamp;

        messagePayloads.push({
            whatsapp_message_id: msg.key.id,
            business_id:         businessId,
            contact_id:          contactId,
            conversation_id:     conversationId,
            direction:           isFromMe ? 'out' : 'in',
            role:                isFromMe ? 'admin' : 'user',
            agent_role:          isFromMe ? 'human' : 'legacy_ai',
            type:                content.type,
            content,
            created_at:          ts ? new Date(ts * 1000).toISOString() : new Date().toISOString(),
            status:              'sent',
            is_read:             isFromMe,
            raw_payload:         msg
        });
    }

    for (let i = 0; i < messagePayloads.length; i += 100) {
        const chunk = messagePayloads.slice(i, i + 100);
        const { error } = await supabase
            .from('messages')
            .upsert(chunk, { onConflict: 'whatsapp_message_id' });

        if (error) {
            debugLog('error', 'DB history messages', 'History message chunk upsert failed', { businessId, chunkSize: chunk.length, startIndex: i, error });
            console.error('[History Sync] Message chunk insert failed', {
                businessId,
                chunkSize: chunk.length,
                startIndex: i,
                message: error.message,
                details: error.details,
                hint: error.hint,
                code: error.code,
            });
            throw new Error(`History message chunk failed: ${error.message}`);
        }
        debugLog('ok', 'DB history messages', `Upserted message chunk (${chunk.length})`, { businessId, startIndex: i });
    }

    console.log(`[History Sync] Completed for ${businessId}`);
    debugLog('ok', 'History sync', 'History sync completed', { businessId, savedMessages: messagePayloads.length });
}

// ─── NEW: message status updates (sent → delivered → read, or failed) ────────
// Handles the 'messages.update' webhook event. Evolution sends a bare
// `status` string ('SERVER_ACK' | 'DELIVERY_ACK' | 'READ' | 'ERROR', per
// what's been confirmed against real payloads) — we store it as-is rather
// than renaming it, so it lines up with the statusMap already written in
// run-local.js's computeReadReceipt(), which reads these exact values.
//
// On 'ERROR', Evolution also sends messageStubType/messageStubParameters —
// logged for now since we don't yet know what those parameter codes mean
// (e.g. "463"); worth revisiting once a few real failures come through and
// a pattern in the parameters is visible.
export async function processMessageStatusUpdate(payload, businessIdOverride) {
    const businessId = businessIdOverride;
    const rawUpdates = Array.isArray(payload.data) ? payload.data : (payload.data?.key ? [payload.data] : []);

    for (const update of rawUpdates) {
        try {
            const messageId = update?.key?.id;
            const status = String(update?.status || '').toUpperCase();
            if (!messageId || !status) continue;

            let statusUpdate = supabase
                .from('messages')
                .update({ status, is_read: status.toUpperCase() === 'READ' })
                .eq('whatsapp_message_id', messageId)
                .eq('business_id', businessId);

            if (status !== 'READ') statusUpdate = statusUpdate.not('status', 'ilike', 'READ');

            const { error } = await statusUpdate;

            if (error) {
                debugLog('error', 'DB receipt update', 'Message status update failed', { messageId, status, businessId, error });
                console.error('[Message Status Update] Failed', { messageId, status, businessId, message: error.message });
                continue;
            }

            if (status === 'ERROR') {
                console.warn('[Message Status Update] Delivery failure', {
                    messageId,
                    businessId,
                    stubType: update.messageStubType,
                    stubParams: update.messageStubParameters || null,
                });
            } else {
                debugLog('ok', 'DB receipt update', `Message ${messageId} -> ${status}`, { messageId, status, businessId });
                console.log(`[Message Status Update] ${messageId} -> ${status}`);
            }
        } catch (e) {
            debugLog('error', 'Message status error', e.message, { businessId, error: e });
            console.error('[Message Status Update] Error', { message: e.message });
        }
    }
}

export async function processPresenceUpdate(payload, businessIdOverride) {
    const businessId = businessIdOverride;
    const data = payload?.data || {};
    const presences = data.presences && typeof data.presences === 'object'
        ? data.presences
        : data.id
            ? { [data.id]: data }
            : {};

    for (const [jid, presence] of Object.entries(presences)) {
        const presenceStatus = presence?.lastKnownPresence || presence?.presence || presence?.status;
        if (!jid || !presenceStatus || isGroupOrBroadcast(jid)) continue;

        const { error } = await supabase
            .from('contacts')
            .update({
                presence_status: presenceStatus,
                presence_updated_at: new Date().toISOString()
            })
            .eq('business_id', businessId)
            .eq('social_platform', 'whatsapp')
            .eq('social_id', jid);

        if (error) {
            debugLog('error', 'DB presence update', 'Presence update failed', { businessId, jid, presenceStatus, error });
        } else {
            debugLog('ok', 'DB presence update', `Contact ${jid} -> ${presenceStatus}`, { businessId, jid, presenceStatus });
        }
    }
}

// ─── NEW: contacts.set / contacts.upsert — needed for the persona-pack /
// frequency-structure analysis Autochat depends on. Deliberately does NOT
// touch lead_state/lead_type/is_ad_lead — those are owned by the lead
// classification logic in processLiveMessage, and an upsert here should
// never silently reset a lead someone already worked. Only name/phone move.
export async function processContactsSync(payload, businessIdOverride) {
    const businessId = businessIdOverride;
    const contacts = (payload.data || []).filter(c => c?.id && !isGroupOrBroadcast(c.id));
    if (contacts.length === 0) return;

    const payloads = contacts.map(c => ({
        business_id:     businessId,
        social_platform: 'whatsapp',
        social_id:       c.id,
        name:            c.name || c.notify || c.verifiedName || 'Unknown',
        phone:           extractPhone(c.id),
        last_seen:       new Date().toISOString(),
    }));

    const { error } = await supabase
        .from('contacts')
        .upsert(payloads, { onConflict: 'business_id, social_platform, social_id' });

    if (error) {
        debugLog('error', 'DB contacts sync', 'Bulk contacts upsert failed', { businessId, error });
    } else {
        debugLog('ok', 'DB contacts sync', `Upserted ${payloads.length} contacts`, { businessId });
    }
}

export async function processContactsUpsert(payload, businessIdOverride) {
    const businessId = businessIdOverride;
    const raw = Array.isArray(payload.data) ? payload.data : [payload.data];
    const contacts = raw.filter(c => c?.id && !isGroupOrBroadcast(c.id));
    if (contacts.length === 0) return;

    const payloads = contacts.map(c => ({
        business_id:     businessId,
        social_platform: 'whatsapp',
        social_id:       c.id,
        name:            c.name || c.notify || c.verifiedName || 'Unknown',
        phone:           extractPhone(c.id),
        last_seen:       new Date().toISOString(),
    }));

    const { error } = await supabase
        .from('contacts')
        .upsert(payloads, { onConflict: 'business_id, social_platform, social_id' });

    if (error) {
        debugLog('error', 'DB contact upsert', 'Contact upsert failed', { businessId, error });
    } else {
        debugLog('ok', 'DB contact upsert', `Upserted ${payloads.length} contact(s)`, { businessId });
    }
}

// ─── NEW: chats.set / chats.upsert — same reasoning as contacts above.
// Only touches unread_count/status on conversations that already exist
// (i.e. the contact was already created by a message or contacts sync);
// it does not create conversations on its own, matching how
// processHistorySync already treats chats as dependent on contacts.
export async function processChatsSync(payload, businessIdOverride) {
    const businessId = businessIdOverride;
    const chats = (payload.data || []).filter(c => c?.id && !isGroupOrBroadcast(c.id));
    if (chats.length === 0) return;

    for (const chat of chats) {
        const { error } = await supabase
            .from('conversations')
            .update({
                unread_count: chat.unreadCount || 0,
                status: (chat.unreadCount || 0) > 0 ? 'open' : 'closed',
            })
            .eq('business_id', businessId)
            .eq('external_id', chat.id);

        if (error) {
            debugLog('error', 'DB chats sync', 'Chat sync update failed', { businessId, chatId: chat.id, error });
        }
    }
    debugLog('ok', 'DB chats sync', `Processed ${chats.length} chat(s)`, { businessId });
}

export async function processChatsUpsert(payload, businessIdOverride) {
    const businessId = businessIdOverride;
    const raw = Array.isArray(payload.data) ? payload.data : [payload.data];
    const chats = raw.filter(c => c?.id && !isGroupOrBroadcast(c.id));
    if (chats.length === 0) return;

    for (const chat of chats) {
        const { error } = await supabase
            .from('conversations')
            .update({
                unread_count: chat.unreadCount || 0,
                status: (chat.unreadCount || 0) > 0 ? 'open' : 'closed',
            })
            .eq('business_id', businessId)
            .eq('external_id', chat.id);

        if (error) {
            debugLog('error', 'DB chat upsert', 'Chat upsert update failed', { businessId, chatId: chat.id, error });
        } else {
            debugLog('ok', 'DB chat upsert', `Chat ${chat.id} updated`, { businessId, chatId: chat.id });
        }
    }
}