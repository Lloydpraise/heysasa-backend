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
    cancelPendingFollowUps 
} from './dbService.js';
import { debugLog } from './debugConsole.js';

export async function resolveBusinessId(payload) {
    const instanceName = payload?.instance || payload?.data?.instance;
    if (!instanceName) throw new Error('evolution_instance_missing');

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

export async function processConnectionUpdate(payload, businessId) {
    const data = payload?.data || {};
    const state = String(data.state || data.status || data.connection || '').toLowerCase();
    const isConnected = state === 'open' || state === 'connected';
    const isDisconnected = state === 'close' || state === 'closed' || state === 'disconnected';
    const instanceName = payload?.instance || data.instance;
    const sessionStatus = isConnected ? 'connected' : isDisconnected ? 'disconnected' : 'pending';
    const values = {
        business_id: businessId,
        instance_name: instanceName,
        status: sessionStatus,
        session_data: {
            qr_code: data.qrcode?.base64 || data.qrCode || data.base64 || null,
            pairing_code: data.pairingCode || data.pairing_code || null,
            raw_payload: payload,
        },
        updated_at: new Date().toISOString(),
    };

    // whatsapp_sessions has no unique constraint on instance_name, so
    // upsert({ onConflict: 'instance_name' }) fails with a Postgres
    // "no unique or exclusion constraint" error on every call. Look the
    // row up first, then update or insert — same pattern saveConnectionState
    // in evolutionConnections.js already uses.
    const { data: existing, error: findError } = await supabase
        .from('whatsapp_sessions')
        .select('id')
        .eq('instance_name', instanceName)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    if (findError) throw findError;

    const query = existing?.id
        ? supabase.from('whatsapp_sessions').update(values).eq('id', existing.id)
        : supabase.from('whatsapp_sessions').insert(values);

    const { error } = await query;
    if (error) throw error;
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
        pushName: rawMessage?.pushName || rawMessage?.verifiedBizName || null,
        isFromMe: rawMessage?.key?.fromMe === true,
        keyId: rawMessage?.key?.id || null,
        timestamp: rawMessage?.messageTimestamp,
        text: content.text || '',
        type: content.type || 'text',
        adAttribution: extractAdAttribution(rawMessage),
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

            const { jid, pushName, isFromMe, keyId, timestamp, text, type, adAttribution } = parsed;

            // 1. Resolve Contact safely
            const contact = await getOrCreateContact(businessId, jid, pushName);
            if (!contact?.id) {
                debugLog('error', 'Contact ready', 'Failed to retrieve or build contact ID', { businessId, jid });
                continue;
            }
            const contactId = contact.id;

            // 2. Resolve Conversation
            const conversationId = await getOrCreateConversation(businessId, contactId, jid);

            // 3. Process Ad Attribution if present
            if (adAttribution) {
                await recordAdAttribution(businessId, contactId, adAttribution);
            }

            // 4. Update state & cancel follow-ups on incoming user response
            if (!isFromMe) {
                await updateLeadStateOnReply(contactId, contact.lead_state);
                await cancelPendingFollowUps(contactId);
            }

            // 5. Store message record — real `messages` columns are
            // whatsapp_message_id/direction/role/agent_role/type/content
            // (jsonb, NOT NULL), matching processHistorySync below. The old
            // version wrote external_id/sender_type/message_type, none of
            // which exist on the table, so this insert failed on every call
            // even once bugs #1/#2 above were fixed. Upserting on
            // whatsapp_message_id (which has a real unique constraint) also
            // makes this safe against Evolution redelivering the same event.
            const { error: msgError } = await supabase.from('messages').upsert({
                business_id: businessId,
                conversation_id: conversationId,
                contact_id: contactId,
                whatsapp_message_id: keyId,
                direction: isFromMe ? 'out' : 'in',
                role: isFromMe ? 'admin' : 'user',
                agent_role: isFromMe ? 'human' : 'legacy_ai',
                type,
                content: { text, type },
                status: 'sent',
                is_read: isFromMe,
                raw_payload: rawMessage,
                created_at: timestamp ? new Date(timestamp * 1000).toISOString() : new Date().toISOString(),
            }, { onConflict: 'whatsapp_message_id', ignoreDuplicates: false });

            if (msgError) {
                debugLog('error', 'Message Insert', 'Failed to store incoming message', { businessId, keyId, error: msgError });
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
                const contact = await getOrCreateContact(businessId, jid, msg.pushName);
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
            const status = update?.status;
            if (!messageId || !status) continue;

            const { error } = await supabase
                .from('messages')
                .update({ status, is_read: status.toUpperCase() === 'READ' })
                .eq('whatsapp_message_id', messageId)
                .eq('business_id', businessId);

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