import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
    processLiveMessage,
    processHistorySync,
    processMessageStatusUpdate,
    processPresenceUpdate,
    processConnectionUpdate,
    processContactsSync,
    processContactsUpsert,
    processChatsSync,
    processChatsUpsert,
    resolveBusinessId,
} from './services/webhookHandler.js';
import { attachDebugClient, debugLog } from './services/debugConsole.js';
import { EVOLUTION_API_KEY, EVOLUTION_URL } from './config/evolution.js';
import {
    createEvolutionInstance,
    deleteEvolutionInstance,
    resyncHistoryForInstance,
} from './services/evolutionConnections.js';
import { supabase } from './config/supabase.js';

dotenv.config();

const app = express();
app.use(cors({
    origin: (origin, callback) => {
        const configuredOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173')
            .split(',')
            .map(value => value.trim())
            .filter(Boolean);
        const isLocalDevelopmentOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || '');

        callback(null, !origin || configuredOrigins.includes(origin) || isLocalDevelopmentOrigin);
    },
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'apikey'],
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

let analysisProcess = null;
let analysisBusinessId = null;
let followupProcess = null;
const followupPort = process.env.FOLLOWUP_ENGINE_PORT || '3001';

function pipeFollowupOutput(stream, level) {
    let pending = '';

    stream.on('data', (chunk) => {
        pending += chunk.toString();
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() || '';

        for (const line of lines) {
            const message = line.trim();
            if (message) debugLog(level, 'Follow-up engine', message, { service: 'followup-engine' });
        }
    });

    stream.on('end', () => {
        const message = pending.trim();
        if (message) debugLog(level, 'Follow-up engine', message, { service: 'followup-engine' });
    });
}

function startFollowupEngine() {
    const projectRoot = fileURLToPath(new URL('../', import.meta.url));
    const followupRoot = path.join(projectRoot, 'followup-engine');

    followupProcess = spawn(process.execPath, ['src/index.js'], {
        cwd: followupRoot,
        env: {
            ...process.env,
            PORT: followupPort,
            SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    pipeFollowupOutput(followupProcess.stdout, 'info');
    pipeFollowupOutput(followupProcess.stderr, 'error');
    followupProcess.on('error', (error) => {
        debugLog('error', 'Follow-up engine', 'Could not start follow-up engine', { error });
        followupProcess = null;
    });
    followupProcess.on('close', (code, signal) => {
        debugLog(code === 0 ? 'ok' : 'error', 'Follow-up engine', `Finished with code ${code}${signal ? ` (${signal})` : ''}`, { code, signal });
        followupProcess = null;
    });

    debugLog('info', 'Follow-up engine', `Starting on port ${followupPort}`, { followupRoot });
}

function stopProcesses() {
    if (followupProcess) {
        followupProcess.kill();
        followupProcess = null;
    }
    if (analysisProcess) {
        analysisProcess.kill();
        analysisProcess = null;
    }
}

startFollowupEngine();

function analysisStatus() {
    return analysisProcess
    ? { running: true, pid: analysisProcess.pid, ...analysisBusinessId }
    : { running: false, businessId: null, contactIds: [] };
}

app.get('/debug/analysis/status', (_req, res) => res.json({ running: !!analysisProcess }));

app.get('/debug/businesses', async (_req, res) => {
    const { data, error } = await supabase
        .from('businesses')
        .select('business_id, name, created_at')
        .order('created_at', { ascending: false });

    if (error) {
        debugLog('error', 'Business lookup', 'Could not load businesses', { error });
        res.status(500).json({ ok: false, error: error.message });
        return;
    }

    res.json({ ok: true, businesses: data || [] });
});

app.get('/debug/followup/status', (_req, res) => res.json({
    running: !!followupProcess && !followupProcess.killed,
    pid: followupProcess?.pid ?? null,
    port: Number(followupPort),
}));

app.post('/instance/create/:instanceName', async (req, res) => {
    try {
        const result = await createEvolutionInstance(req.params.instanceName);
        res.status(201).json({ ok: true, result });
    } catch (error) {
        res.status(error.status && error.status < 500 ? error.status : 502).json({ ok: false, error: error.message, details: error.body ?? null });
    }
});

app.delete('/instance/delete/:instanceName', async (req, res) => {
    try {
        await deleteEvolutionInstance(req.params.instanceName);
        res.status(204).send();
    } catch (error) {
        res.status(error.status && error.status < 500 ? error.status : 502).json({ ok: false, error: error.message });
    }
});

app.post('/debug/evolution/resync/:instanceName', async (req, res) => {
    const { instanceName } = req.params;
    debugLog('info', 'Evolution resync', `Requesting resync for ${instanceName}`, { instanceName });
    try {
        const result = await resyncHistoryForInstance(instanceName);
        debugLog('ok', 'Evolution resync', `Resync requested for ${instanceName}`, { instanceName, result });
        res.json({ ok: true, instanceName, result });
    } catch (error) {
        debugLog('error', 'Evolution resync', error.message, { instanceName, error });
        res.status(502).json({ ok: false, error: error.message });
    }
});

async function startAnalysis(req, res) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
    if (!token) {
        res.status(401).json({ ok: false, error: 'missing_auth_token' });
        return;
    }

    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData?.user?.email) {
        res.status(401).json({ ok: false, error: 'invalid_auth_token' });
        return;
    }

    const { data: ownedBusiness, error: businessError } = await supabase
        .from('businesses')
        .select('business_id')
        .eq('owner_email', userData.user.email)
        .single();
    if (businessError || !ownedBusiness) {
        res.status(403).json({ ok: false, error: 'no_business_for_user' });
        return;
    }

    if (analysisProcess) {
        res.status(409).json({ ok: false, message: 'Analysis is already running', ...analysisStatus() });
        return;
    }

    const projectRoot = fileURLToPath(new URL('../', import.meta.url));
    const businessId = typeof req.body?.businessId === 'string' && req.body.businessId.trim()
        ? req.body.businessId.trim()
        : ownedBusiness.business_id;
    if (businessId !== ownedBusiness.business_id) {
        res.status(403).json({ ok: false, error: 'business_not_owned' });
        return;
    }

    const rawContactIds = req.body?.contactIds ?? [];
    if (!Array.isArray(rawContactIds)) {
        res.status(400).json({ ok: false, error: 'contactIds_must_be_array' });
        return;
    }
    const contactIds = [...new Set(rawContactIds.map((value) => {
        const normalized = typeof value === 'number' ? value : Number(value);
        return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : null;
    }))].filter(Boolean);
    if (contactIds.length !== rawContactIds.length) {
        res.status(400).json({ ok: false, error: 'contactIds_must_contain_positive_integers' });
        return;
    }

    if (contactIds.length > 0) {
        const { data: contacts, error: contactsError } = await supabase
            .from('contacts')
            .select('id')
            .eq('business_id', businessId)
            .in('id', contactIds);
        if (contactsError) {
            res.status(500).json({ ok: false, error: contactsError.message });
            return;
        }
        const ownedContactIds = new Set((contacts || []).map((contact) => Number(contact.id)));
        if (ownedContactIds.size !== contactIds.length || contactIds.some((id) => !ownedContactIds.has(id))) {
            res.status(400).json({ ok: false, error: 'one_or_more_contacts_not_in_business' });
            return;
        }
    }

    analysisBusinessId = { businessId, contactIds };
    debugLog('info', 'Analysis worker', 'Starting run-local.js', { projectRoot, businessId, contactIds });
    analysisProcess = spawn(process.execPath, ['run-local.js'], {
        cwd: projectRoot,
        env: {
            ...process.env,
            ANALYSIS_CONFIG: JSON.stringify({ businessId, contactIds }),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    analysisProcess.stdout.on('data', (chunk) => {
        debugLog('info', 'Analysis worker output', chunk.toString().trim());
    });
    analysisProcess.stderr.on('data', (chunk) => {
        debugLog('error', 'Analysis worker error', chunk.toString().trim());
    });
    analysisProcess.on('error', (error) => {
        debugLog('error', 'Analysis worker', 'Could not start run-local.js', { error });
        analysisProcess = null;
        analysisBusinessId = null;
    });
    analysisProcess.on('close', (code, signal) => {
        debugLog(code === 0 ? 'ok' : 'error', 'Analysis worker', `Finished with code ${code}${signal ? ` (${signal})` : ''}`, { code, signal });
        analysisProcess = null;
        analysisBusinessId = null;
    });

    res.status(202).json({ ok: true, message: 'Analysis started', ...analysisStatus() });
}

app.post(['/analysis/start', '/debug/analysis/start'], (req, res, next) => {
    startAnalysis(req, res).catch(next);
});

app.get('/analysis/status', async (req, res, next) => {
    try {
        const token = req.headers.authorization?.startsWith('Bearer ')
            ? req.headers.authorization.slice(7).trim()
            : null;
        if (!token) return res.status(401).json({ ok: false, error: 'missing_auth_token' });

        const { data: userData, error: userError } = await supabase.auth.getUser(token);
        if (userError || !userData?.user?.email) {
            return res.status(401).json({ ok: false, error: 'invalid_auth_token' });
        }

        const { data: ownedBusiness, error: businessError } = await supabase
            .from('businesses')
            .select('business_id')
            .eq('owner_email', userData.user.email)
            .single();
        if (businessError || !ownedBusiness) {
            return res.status(403).json({ ok: false, error: 'no_business_for_user' });
        }

        if (analysisProcess && analysisBusinessId.businessId !== ownedBusiness.business_id) {
            return res.json({ running: false, businessId: null, contactIds: [] });
        }
        return res.json(analysisStatus());
    } catch (error) {
        return next(error);
    }
});

app.get('/debug/events', (_req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    attachDebugClient(res);
});

app.get('/debug/evolution', async (_req, res) => {
    const started = Date.now();
    debugLog('info', 'Evolution connect', `Checking ${EVOLUTION_URL}`, { url: EVOLUTION_URL });
    try {
        const response = await fetch(EVOLUTION_URL, { headers: EVOLUTION_API_KEY ? { apikey: EVOLUTION_API_KEY } : {} });
        const body = await response.text();
        const result = { ok: response.ok, status: response.status, durationMs: Date.now() - started, response: body.slice(0, 5000) };
        debugLog(response.ok ? 'ok' : 'error', 'Evolution response', `Evolution returned ${response.status}`, result);
        res.status(response.ok ? 200 : 502).json(result);
    } catch (error) {
        debugLog('error', 'Evolution error', 'Evolution connection failed', { url: EVOLUTION_URL, durationMs: Date.now() - started, error });
        res.status(502).json({ ok: false, error: error.message });
    }
});

app.post('/webhook/evolution', async (req, res) => {
    // Optional Webhook Security Check: Header validation if API key set
    if (EVOLUTION_API_KEY) {
        const reqApiKey = req.headers['apikey'] || req.headers['authorization'];
        if (reqApiKey && reqApiKey !== EVOLUTION_API_KEY && reqApiKey !== `Bearer ${EVOLUTION_API_KEY}`) {
            res.status(401).json({ ok: false, error: 'Unauthorized webhook payload' });
            return;
        }
    }

    const eventType = req.body?.event;
    const normalizedEventType = String(eventType || '').toLowerCase().replaceAll('_', '.');
    const requestMeta = {
        eventType,
        hasBody: !!req.body,
        bodyKeys: req.body ? Object.keys(req.body) : [],
        contentLength: req.headers['content-length'] || null,
        sourceIp: req.ip || req.socket?.remoteAddress || null,
        hasAuthHeader: !!req.headers.authorization,
    };

    debugLog('info', 'Webhook received', `Evolution event: ${eventType || 'unknown'}`, requestMeta);

    let businessId;
    try {
        businessId = await resolveBusinessId(req.body);
    } catch (error) {
        debugLog('error', 'Webhook identity', error.message, requestMeta);
        res.status(400).json({ ok: false, error: error.message });
        return;
    }
    requestMeta.businessId = businessId;
    res.status(200).send('OK');

    try {
        switch (normalizedEventType) {
            case 'messaging-history.set':
            case 'messaging.history.set':
            case 'messages.set':
                console.log('[Webhook] Processing history sync', requestMeta);
                await processHistorySync(req.body, businessId);
                debugLog('ok', 'Webhook completed', 'History sync completed', { businessId });
                break;
            case 'messages.upsert':
                console.log('[Webhook] Processing live message', requestMeta);
                // Evolution sends a single message object as `data` for this
                // event (confirmed via a live payload) — processLiveMessage
                // normalizes single-object vs array internally.
                await processLiveMessage(req.body?.data, businessId);
                debugLog('ok', 'Webhook completed', 'Live message processing completed', { businessId });
                break;
            case 'messages.update':
                console.log('[Webhook] Processing message status update', requestMeta);
                await processMessageStatusUpdate(req.body, businessId);
                debugLog('ok', 'Webhook completed', 'Message status processing completed', { businessId });
                break;
            case 'presence.update':
                console.log('[Webhook] Processing presence update', requestMeta);
                await processPresenceUpdate(req.body, businessId);
                debugLog('ok', 'Webhook completed', 'Presence processing completed', { businessId });
                break;
            case 'connection.update':
                console.log('[Webhook] Processing connection update', requestMeta);
                await processConnectionUpdate(req.body, businessId);
                debugLog('ok', 'Webhook completed', 'Connection update persisted', { businessId });
                break;
            case 'contacts.set':
                console.log('[Webhook] Processing contacts sync', requestMeta);
                await processContactsSync(req.body, businessId);
                debugLog('ok', 'Webhook completed', 'Contacts sync completed', { businessId });
                break;
            case 'contacts.upsert':
                console.log('[Webhook] Processing contact upsert', requestMeta);
                await processContactsUpsert(req.body, businessId);
                debugLog('ok', 'Webhook completed', 'Contact upsert completed', { businessId });
                break;
            case 'chats.set':
                console.log('[Webhook] Processing chats sync', requestMeta);
                await processChatsSync(req.body, businessId);
                debugLog('ok', 'Webhook completed', 'Chats sync completed', { businessId });
                break;
            case 'chats.upsert':
                console.log('[Webhook] Processing chat upsert', requestMeta);
                await processChatsUpsert(req.body, businessId);
                debugLog('ok', 'Webhook completed', 'Chat upsert completed', { businessId });
                break;
            default:
                console.log(`[Webhook] Event '${eventType}' received.`, requestMeta);
        }
    } catch (err) {
        debugLog('error', 'Webhook error', err?.message || 'Webhook processing failed', { ...requestMeta, error: err });
        console.error('[Webhook Error]', {
            ...requestMeta,
            message: err?.message,
            stack: err?.stack,
            name: err?.name,
        });
    }
});

app.use((err, _req, res, _next) => {
    console.error('[Unhandled Express Error]', {
        message: err?.message,
        stack: err?.stack,
        name: err?.name,
    });
    res.status(500).json({ ok: false, error: 'internal_server_error' });
});

app.get('/health', (_req, res) => res.json({ status: 'ok', mode: 'single-tenant' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`heysasa backend listening on port ${PORT}`));

process.once('SIGINT', stopProcesses);
process.once('SIGTERM', stopProcesses);