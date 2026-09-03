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

function callCreateEvolutionInstance(instanceName) {
    return evolutionRequest('/instance/create', {
        method: 'POST',
        body: JSON.stringify({
            instanceName,
            instance: instanceName,
            integration: 'WHATSAPP-BAILEYS',
            qrcode: true,
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

export function connectEvolutionInstance(instanceName, phoneNumber) {
    const query = phoneNumber ? `?number=${encodeURIComponent(phoneNumber)}` : '';
    return evolutionRequest(`/instance/connect/${encodeURIComponent(instanceName)}${query}`);
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
        .update({ status: 'disconnected', updated_at: new Date().toISOString() })
        .eq('instance_name', instanceName)
        .select()
        .single();
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