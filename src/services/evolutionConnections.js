import { EVOLUTION_API_KEY, EVOLUTION_URL, EVOLUTION_WEBHOOK_URL } from '../config/evolution.js';
import { supabase } from '../config/supabase.js';

function endpoint(path) {
    return `${EVOLUTION_URL.replace(/\/$/, '')}${path}`;
}

async function evolutionRequest(path, options = {}) {
    const response = await fetch(endpoint(path), {
        ...options,
        headers: {
            apikey: EVOLUTION_API_KEY,
            'Content-Type': 'application/json',
            ...(options.headers ?? {}),
        },
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { message: text }; }
    if (!response.ok) {
        const error = new Error(body?.message || body?.error || `Evolution returned ${response.status}`);
        error.status = response.status;
        error.body = body;
        throw error;
    }
    return body;
}

function generateInstanceName(businessId) {
    const cleanBusinessId = String(businessId ?? '').trim().replace(/^heysasa-/, '');
    return cleanBusinessId ? `heysasa-${cleanBusinessId}` : 'heysasa-instance';
}

// ─── Evolution API calls ──────────────────────────────────────────────────

// withQr:false is required for phone-number pairing. qrcode:true makes Evolution
// start a QR session immediately (state "connecting"), and a later
// connect?number=... call on that instance only returns the QR session, never
// a pairing code.
function callCreateEvolutionInstance(instanceName, { withQr = true } = {}) {
    return evolutionRequest('/instance/create', {
        method: 'POST',
        body: JSON.stringify({
            instanceName,
            instance: instanceName,
            integration: 'WHATSAPP-BAILEYS',
            qrcode: withQr,
            syncFullHistory: true,
            webhook: EVOLUTION_WEBHOOK_URL ? {
                url: EVOLUTION_WEBHOOK_URL,
                byEvents: false,
                base64: true,
                events: [
                    'MESSAGES_UPSERT',
                    'MESSAGES_UPDATE',
                    'MESSAGING_HISTORY_SET',
                    'CONNECTION_UPDATE',
                    'PRESENCE_UPDATE',
                    'CHATS_SET',
                    'CHATS_UPSERT',
                    'CONTACTS_SET',
                    'CONTACTS_UPSERT',
                ],
            } : undefined,
        }),
    });
}

export function updateEvolutionInstanceSettings(instanceName, settings = {}) {
    return evolutionRequest(`/settings/set/${encodeURIComponent(instanceName)}`, {
        method: 'POST',
        body: JSON.stringify(settings),
    });
}

export function logoutEvolutionInstanceRemote(instanceName) {
    return evolutionRequest(`/instance/logout/${encodeURIComponent(instanceName)}`, { method: 'DELETE' });
}

export async function resyncHistoryForInstance(instanceName) {
    const instances = await evolutionRequest('/instance/fetchInstances');
    const instance = (Array.isArray(instances) ? instances : instances?.value || [])
        .find(candidate => candidate.id === instanceName || candidate.name === instanceName);
    const resolvedInstanceName = instance?.name || instanceName;

    await updateEvolutionInstanceSettings(resolvedInstanceName, {
        syncFullHistory: true,
        readMessages: false,
        readStatus: false,
        alwaysOnline: false,
        groupsIgnore: true,
    });
    return logoutEvolutionInstanceRemote(resolvedInstanceName);
}

// Digits only, country code included, no leading zeros (Evolution rejects or
// silently ignores anything else and returns { count: 0 } with no pairing code).
export function normalizePairingNumber(phoneNumber) {
    const digits = String(phoneNumber ?? '').replace(/\D/g, '').replace(/^0+/, '');
    return digits;
}

function extractPairingCode(payload) {
    return payload?.pairingCode || payload?.pairing_code || payload?.qrcode?.pairingCode || null;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function connectionStateOf(payload) {
    return String(payload?.instance?.state ?? payload?.state ?? '').toLowerCase();
}

export async function connectEvolutionInstance(instanceName, phoneNumber) {
    const encodedName = encodeURIComponent(instanceName);
    const number = phoneNumber ? normalizePairingNumber(phoneNumber) : '';

    if (!phoneNumber) {
        return evolutionRequest(`/instance/connect/${encodedName}`);
    }

    if (number.length < 10 || number.length > 15) {
        const error = new Error('invalid_phone_number: use the full international number, digits only (e.g. 254712345678)');
        error.status = 400;
        throw error;
    }

    // An instance already sitting in "connecting" is holding a QR session (it was
    // created with qrcode:true or the user tried QR first). connect?number= would
    // just return that QR, so drop it and rebuild the instance without QR first.
    let state = '';
    try {
        state = connectionStateOf(await getEvolutionConnectionState(instanceName));
    } catch (err) {
        if (err.status !== 404) throw err;
        state = 'missing';
    }

    if (state === 'open') return { instance: { instanceName, state: 'open' } };

    if (state === 'connecting' || state === 'missing') {
        if (state === 'connecting') await callDeleteEvolutionInstanceSafely(instanceName);
        await callCreateEvolutionInstance(instanceName, { withQr: false });
        await sleep(1500);
    }

    // The socket is often not ready right after create/restart and the first
    // call comes back with no pairing code, so retry a few times.
    let lastResponse = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
        lastResponse = await evolutionRequest(`/instance/connect/${encodedName}?number=${encodeURIComponent(number)}`);
        if (extractPairingCode(lastResponse) || connectionStateOf(lastResponse) === 'open') return lastResponse;
        await sleep(2500);
    }

    const error = new Error('no_pairing_code_returned: WhatsApp did not issue a pairing code. Check the number includes the country code and has no leading 0.');
    error.status = 422;
    error.body = lastResponse;
    throw error;
}

export function getEvolutionConnectionState(instanceName) {
    return evolutionRequest(`/instance/connectionState/${encodeURIComponent(instanceName)}`);
}

export function deleteEvolutionInstanceRemote(instanceName) {
    return evolutionRequest(`/instance/delete/${encodeURIComponent(instanceName)}`, { method: 'DELETE' });
}

// ─── whatsapp_sessions persistence ────────────────────────────────────────

export async function getConnection(businessId) {
    const { data, error } = await supabase
        .from('whatsapp_sessions')
        .select('*')
        .eq('business_id', businessId)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return {
        ...data,
        evolution_instance_id: data.instance_name,
        qr_code: data.session_data?.qr_code || null,
        pairing_code: data.session_data?.pairing_code || null,
        raw_payload: data.session_data?.raw_payload || data.session_data || null,
    };
}

export async function saveConnectionState(businessId, updates = {}) {
    const existing = await getConnection(businessId);
    const instanceName = updates.evolution_instance_id || existing?.instance_name;
    const sessionData = {
        ...(existing?.session_data || {}),
        ...(updates.qr_code !== undefined ? { qr_code: updates.qr_code } : {}),
        ...(updates.pairing_code !== undefined ? { pairing_code: updates.pairing_code } : {}),
        ...(updates.raw_payload !== undefined ? { raw_payload: updates.raw_payload } : {}),
    };
    const payload = {
        business_id: businessId,
        instance_name: instanceName,
        status: updates.status || existing?.status || 'pending',
        phone_number: updates.phone_number ?? existing?.phone_number ?? null,
        session_data: sessionData,
        updated_at: new Date().toISOString(),
    };

    let query = existing?.id
        ? supabase.from('whatsapp_sessions').update(payload).eq('id', existing.id)
        : supabase.from('whatsapp_sessions').insert(payload);
    const { data, error } = await query.select().single();
    if (error) throw error;
    return {
        ...data,
        evolution_instance_id: data.instance_name,
        qr_code: data.session_data?.qr_code || null,
        pairing_code: data.session_data?.pairing_code || null,
        raw_payload: data.session_data?.raw_payload || data.session_data || null,
    };
}

export async function createEvolutionInstance(businessIdOrInstanceName) {
    const rawValue = String(businessIdOrInstanceName ?? '').trim();
    if (!rawValue) throw new Error('instance_name_required');

    const isExplicitInstance = rawValue.includes('-') && !rawValue.startsWith('heysasa-') && !rawValue.startsWith('business_');
    const businessId = rawValue.startsWith('heysasa-') ? rawValue.replace(/^heysasa-/, '') : rawValue;
    const instanceName = isExplicitInstance ? rawValue : generateInstanceName(businessId);

    // Clean up stale pending or disconnected sessions for this business before inserting a new one
    await supabase
        .from('whatsapp_sessions')
        .delete()
        .eq('business_id', businessId)
        .in('status', ['pending', 'disconnected']);

    const { data: session, error } = await supabase
        .from('whatsapp_sessions')
        .insert({
            business_id: businessId,
            instance_name: instanceName,
            status: 'pending',
        })
        .select()
        .single();
    if (error) throw error;

    try {
        const evolutionResponse = await callCreateEvolutionInstance(instanceName);
        return { session, evolutionResponse };
    } catch (err) {
        await supabase.from('whatsapp_sessions').delete().eq('id', session.id);
        throw err;
    }
}

export async function markSessionConnected(instanceName, { phoneNumber, sessionData } = {}) {
    const { data, error } = await supabase
        .from('whatsapp_sessions')
        .update({
            status: 'connected',
            phone_number: phoneNumber,
            session_data: sessionData ?? undefined,
            updated_at: new Date().toISOString(),
        })
        .eq('instance_name', instanceName)
        .select()
        .single();
    if (error) throw error;
    return data;
}

export async function markSessionDisconnected(instanceName) {
    const { data, error } = await supabase
        .from('whatsapp_sessions')
        .delete()
        .eq('instance_name', instanceName)
        .select()
        .maybeSingle();
    if (error) throw error;
    return data;
}

export async function getSessionByInstanceName(instanceName) {
    const { data, error } = await supabase
        .from('whatsapp_sessions')
        .select('*')
        .eq('instance_name', instanceName)
        .maybeSingle();
    if (error) throw error;
    return data;
}

export async function getSessionsForBusiness(businessId) {
    const { data, error } = await supabase
        .from('whatsapp_sessions')
        .select('*')
        .eq('business_id', businessId);
    if (error) throw error;
    return data;
}

export async function deleteSessionRecord(instanceName, businessId = null) {
    let query = supabase
        .from('whatsapp_sessions')
        .delete()
        .eq('instance_name', instanceName);
    if (businessId) query = query.eq('business_id', businessId);

    const { error } = await query;
    if (error) throw error;
}

export async function deleteEvolutionInstance(instanceName) {
    await callDeleteEvolutionInstanceSafely(instanceName);
    const { error } = await supabase
        .from('whatsapp_sessions')
        .delete()
        .eq('instance_name', instanceName);
    if (error) throw error;
}

async function callDeleteEvolutionInstanceSafely(instanceName) {
    const candidates = [...new Set([
        String(instanceName ?? '').trim(),
        String(instanceName ?? '').trim().replace(/^heysasa-/, ''),
        `heysasa-${String(instanceName ?? '').trim().replace(/^heysasa-/, '')}`,
    ].filter(Boolean))];

    let lastError = null;
    for (const candidate of candidates) {
        try {
            await deleteEvolutionInstanceRemote(candidate);
            return;
        } catch (err) {
            lastError = err;
            if (err.status !== 404) throw err;
        }
    }

    if (lastError?.status === 404) return;
    if (lastError) throw lastError;
}