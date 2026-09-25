import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isAllowedOrigin, normalizeAllowedOrigins } from './cors.js';
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
import { attachDebugClient, debugLog, logEvent, queryLogs, getStreamClientCount } from './services/debugConsole.js';
import { requireDebugToken } from './middleware/debugAuth.js';
import { startAlerts } from './services/alerts.js';
import { EVOLUTION_API_KEY, EVOLUTION_URL } from './config/evolution.js';
import {
    createEvolutionInstance,
    deleteEvolutionInstance,
    resyncHistoryForInstance,
} from './services/evolutionConnections.js';
import { supabase } from './config/supabase.js';
import { createWaitlistSignup } from './services/waitlistService.js';
import { getPublicStats } from './services/publicStatsService.js';

dotenv.config();

if (!process.env.DEBUG_TOKEN) {
    console.error('✗ DEBUG_TOKEN is not set — every /debug route and /instance route will refuse requests until it is set.');
}

const app = express();
const configuredOrigins = normalizeAllowedOrigins(process.env.CORS_ORIGINS || 'https://heysasa.co.ke,https://www.heysasa.co.ke,http://localhost:5173');
app.use(cors({
    origin: (origin, callback) => {
        callback(null, isAllowedOrigin(origin, configuredOrigins));
    },
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'apikey'],
}));
app.use(express.json({ limit: '50mb' }));
// CHANGED: 'public' was a path relative to whatever directory the process
// was *started from*. If pm2 (or anything else) launches this with a
// different working directory, express.static silently serves nothing
// and /debug.html 404s with no error anywhere. An absolute path derived
// from this file's own location can never be wrong.
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public');
app.use(express.static(PUBLIC_DIR));

// ─── Public landing-page endpoints ─────────────────────────────────────────
// No token, no auth — these are meant to be called from the public
// heysasa.co.ke landing page by anyone. createWaitlistSignup and
// getPublicStats do their own validation/rate-limiting/caching.
app.post('/public/waitlist', async (req, res) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
    const result = await createWaitlistSignup(req.body || {}, ip);
    res.status(result.status).json(result.ok ? { ok: true, ...result.data } : { ok: false, error: result.error });
});

app.get('/public/stats', async (_req, res) => {
    try {
        const stats = await getPublicStats();
        res.json({ ok: true, ...stats });
    } catch (error) {
        logEvent({ level: 'error', area: 'system', event: 'public_stats_failed', message: error.message });
        res.status(500).json({ ok: false, error: 'stats_unavailable' });
    }
});

let analysisProcess = null;
let analysisBusinessId = null;
let followupProcess = null;
let shuttingDown = false;
const followupPort = process.env.FOLLOWUP_ENGINE_PORT || '3001';

// Shared by both child processes we spawn (the follow-up engine and the
// analysis worker): if a stdout/stderr line starts with "@@LOG ", it's a
// structured event from lib/log.js (followup-engine) or the emit()
// helper (run-local.js) — parse and forward it as-is, business/contact
// IDs and all. Anything else is a plain text line from a library or an
// uncaught console.log we haven't converted yet — keep showing it, just
// less richly tagged.
function forwardChildLine(line, fallbackLevel, fallbackArea) {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('@@LOG ')) {
        try {
            const row = JSON.parse(trimmed.slice(6));
            logEvent({
                level: row.level || fallbackLevel,
                area: row.area || fallbackArea,
                event: row.event || fallbackArea,
                message: row.message || '',
                business_id: row.business_id ?? null,
                contact_id: row.contact_id ?? null,
                entity_id: row.entity_id ?? null,
                duration_ms: row.duration_ms ?? null,
                details: row.details ?? {},
            });
            return;
        } catch {
            // Malformed @@LOG line — fall through and log it as raw text
            // below so nothing is silently dropped.
        }
    }
    logEvent({ level: fallbackLevel, area: fallbackArea, event: 'raw_output', message: trimmed });
}

function pipeFollowupOutput(stream, level) {
    let pending = '';

    stream.on('data', (chunk) => {
        pending += chunk.toString();
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() || '';
        for (const line of lines) forwardChildLine(line, level, 'engine');
    });

    stream.on('end', () => {
        if (pending.trim()) forwardChildLine(pending, level, 'engine');
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
        logEvent({ level: 'error', area: 'engine', event: 'engine.spawn_failed', message: 'Could not start follow-up engine', details: { error } });
        followupProcess = null;
    });
    followupProcess.on('close', (code, signal) => {
        logEvent({
            level: code === 0 ? 'ok' : 'error', area: 'engine', event: 'engine.exit',
            message: `Finished with code ${code}${signal ? ` (${signal})` : ''}`,
            details: { code, signal },
        });
        followupProcess = null;
        // A service meant to run forever that exits on its own is worth
        // restarting rather than leaving the site with no follow-ups —
        // but not while we're intentionally shutting the whole app down.
        if (!shuttingDown) setTimeout(startFollowupEngine, 5000);
    });

    logEvent({ level: 'info', area: 'engine', event: 'engine.start', message: `Starting on port ${followupPort}`, details: { followupRoot } });
}

function stopProcesses() {
    shuttingDown = true;
    if (followupProcess) {
        followupProcess.kill();
        followupProcess = null;
    }
    if (analysisProcess) {
        analysisProcess.kill();
        analysisProcess = null;
    }
}

// ─── Crash visibility ───────────────────────────────────────────────────────
// Previously nothing caught these — a crash just vanished, pm2 restarted
// the process, and there was no record of what happened. Now it's logged
// (and, once persisted, survives the restart) before the process exits.
process.on('unhandledRejection', (reason) => {
    logEvent({ level: 'error', area: 'system', event: 'crash.unhandled_rejection', message: reason?.message || String(reason), details: { error: reason } });
    setTimeout(() => process.exit(1), 500); // give the log writer a moment to flush
});
process.on('uncaughtException', (error) => {
    logEvent({ level: 'error', area: 'system', event: 'crash.uncaught_exception', message: error?.message || String(error), details: { error } });
    setTimeout(() => process.exit(1), 500);
});

// ─── Boot event ─────────────────────────────────────────────────────────────
function currentGitCommit() {
    try {
        return execSync('git rev-parse --short HEAD', { cwd: fileURLToPath(new URL('../', import.meta.url)) }).toString().trim();
    } catch {
        return 'unknown';
    }
}
logEvent({
    level: 'info', area: 'system', event: 'system.boot',
    message: `heysasa-backend booting (commit ${currentGitCommit()})`,
    details: {
        commit: currentGitCommit(),
        node: process.version,
        envPresent: {
            SUPABASE_URL: !!process.env.SUPABASE_URL,
            SUPABASE_SERVICE_KEY: !!process.env.SUPABASE_SERVICE_KEY,
            EVOLUTION_URL: !!process.env.EVOLUTION_URL,
            EVOLUTION_API_KEY: !!process.env.EVOLUTION_API_KEY,
            DEBUG_TOKEN: !!process.env.DEBUG_TOKEN,
            LLOYD_PHONE: !!process.env.LLOYD_PHONE,
            PLATFORM_EVOLUTION_INSTANCE: !!process.env.PLATFORM_EVOLUTION_INSTANCE,
            OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
        },
    },
});

startAlerts();
startFollowupEngine();

// ─── Heartbeat ──────────────────────────────────────────────────────────────
// A once-a-minute "still alive" signal, plus enough state to see at a
// glance whether both child services are up without opening a queue
// query — this is what tells you the difference between "quiet because
// nothing is happening" and "quiet because it's stuck".
setInterval(() => {
    const mem = process.memoryUsage();
    logEvent({
        level: 'debug', area: 'system', event: 'system.heartbeat',
        message: 'heartbeat',
        details: {
            uptimeSec: Math.round(process.uptime()),
            rssMb: Math.round(mem.rss / 1024 / 1024),
            heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
            streamClients: getStreamClientCount(),
            followupEngineAlive: !!followupProcess,
            analysisRunning: !!analysisProcess,
        },
    });
}, 60_000);

function analysisStatus() {
    return analysisProcess
    ? { running: true, pid: analysisProcess.pid, ...analysisBusinessId }
    : { running: false, businessId: null, contactIds: [] };
}

app.get('/debug/analysis/status', requireDebugToken, (_req, res) => res.json({ running: !!analysisProcess }));

app.get('/debug/businesses', requireDebugToken, async (_req, res) => {
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

app.get('/debug/followup/status', requireDebugToken, (_req, res) => res.json({
    running: !!followupProcess && !followupProcess.killed,
    pid: followupProcess?.pid ?? null,
    port: Number(followupPort),
}));

// CHANGED: these two had no protection at all — anyone who found the URL
// could create or delete a business's WhatsApp connection.
app.post('/instance/create/:instanceName', requireDebugToken, async (req, res) => {
    try {
        const result = await createEvolutionInstance(req.params.instanceName);
        res.status(201).json({ ok: true, result });
    } catch (error) {
        res.status(error.status && error.status < 500 ? error.status : 502).json({ ok: false, error: error.message, details: error.body ?? null });
    }
});

app.delete('/instance/delete/:instanceName', requireDebugToken, async (req, res) => {
    try {
        await deleteEvolutionInstance(req.params.instanceName);
        res.status(204).send();
    } catch (error) {
        res.status(error.status && error.status < 500 ? error.status : 502).json({ ok: false, error: error.message });
    }
});

app.post('/debug/evolution/resync/:instanceName', requireDebugToken, async (req, res) => {
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

    let analysisStdoutPending = '';
    let analysisStderrPending = '';
    analysisProcess.stdout.on('data', (chunk) => {
        analysisStdoutPending += chunk.toString();
        const lines = analysisStdoutPending.split(/\r?\n/);
        analysisStdoutPending = lines.pop() || '';
        for (const line of lines) forwardChildLine(line, 'info', 'analysis');
    });
    analysisProcess.stderr.on('data', (chunk) => {
        analysisStderrPending += chunk.toString();
        const lines = analysisStderrPending.split(/\r?\n/);
        analysisStderrPending = lines.pop() || '';
        for (const line of lines) forwardChildLine(line, 'error', 'analysis');
    });
    analysisProcess.on('error', (error) => {
        logEvent({ level: 'error', area: 'analysis', event: 'analysis.spawn_failed', message: 'Could not start run-local.js', details: { error } });
        analysisProcess = null;
        analysisBusinessId = null;
    });
    analysisProcess.on('close', (code, signal) => {
        if (analysisStdoutPending.trim()) forwardChildLine(analysisStdoutPending, 'info', 'analysis');
        if (analysisStderrPending.trim()) forwardChildLine(analysisStderrPending, 'error', 'analysis');
        logEvent({
            level: code === 0 ? 'ok' : 'error', area: 'analysis', event: 'analysis.finished',
            message: `Finished with code ${code}${signal ? ` (${signal})` : ''}`,
            business_id: analysisBusinessId?.businessId ?? null,
            details: { code, signal },
        });
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

app.get('/debug/events', requireDebugToken, (req, res) => {
    // CHANGED: added no-transform (some proxies still buffer without it),
    // X-Accel-Buffering: no (nginx-specific, otherwise it buffers SSE by
    // default), and a 15s keepalive comment so proxies/Cloudflare don't
    // drop the connection as idle (~100s is a common default timeout).
    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    const filters = {
        level: typeof req.query.level === 'string' ? req.query.level : null,
        area: typeof req.query.area === 'string' ? req.query.area : null,
        business: typeof req.query.business === 'string' ? req.query.business : null,
    };
    attachDebugClient(res, filters);
    const keepalive = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { clearInterval(keepalive); }
    }, 15000);
    res.on('close', () => clearInterval(keepalive));
});

// ─── New debug API: summary, log history search, queue, sessions ──────────
app.get('/debug/api/summary', requireDebugToken, async (_req, res) => {
    const [{ data: businesses }, { data: sessions }, { count: pendingCount }, { count: failedCount }] = await Promise.all([
        supabase.from('businesses').select('business_id, name, subscription_active').then(r => ({ data: r.data })).catch(() => ({ data: [] })),
        supabase.from('whatsapp_sessions').select('business_id, instance_name, status, updated_at').then(r => ({ data: r.data })).catch(() => ({ data: [] })),
        supabase.from('follow_up_queue').select('id', { count: 'exact', head: true }).eq('status', 'pending').then(r => ({ count: r.count })).catch(() => ({ count: null })),
        supabase.from('follow_up_queue').select('id', { count: 'exact', head: true }).eq('status', 'failed').then(r => ({ count: r.count })).catch(() => ({ count: null })),
    ]);

    let evolutionOk = null;
    try {
        const started = Date.now();
        const r = await fetch(EVOLUTION_URL, { headers: EVOLUTION_API_KEY ? { apikey: EVOLUTION_API_KEY } : {} });
        evolutionOk = { ok: r.ok, status: r.status, durationMs: Date.now() - started };
    } catch (error) {
        evolutionOk = { ok: false, error: error.message };
    }

    res.json({
        ok: true,
        evolution: evolutionOk,
        followupEngine: { running: !!followupProcess && !followupProcess.killed, pid: followupProcess?.pid ?? null },
        analysis: { running: !!analysisProcess },
        openaiKeyPresent: !!process.env.OPENAI_API_KEY,
        streamClients: getStreamClientCount(),
        queue: { pending: pendingCount, failed: failedCount },
        businesses: businesses || [],
        sessions: sessions || [],
    });
});

app.get('/debug/api/logs', requireDebugToken, async (req, res) => {
    const { from, to, area, level, business, q, limit } = req.query;
    const result = await queryLogs({ from, to, area, level, business, q, limit: limit ? Number(limit) : undefined });
    res.json({ ok: !result.error, ...result });
});

app.get('/debug/api/queue', requireDebugToken, async (req, res) => {
    const { data: statusCounts, error: statusError } = await supabase
        .from('follow_up_queue')
        .select('status')
        .gte('created_at', new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString());
    if (statusError) return res.status(500).json({ ok: false, error: statusError.message });

    const byStatus = {};
    for (const row of statusCounts || []) byStatus[row.status] = (byStatus[row.status] || 0) + 1;

    const { data: skipReasons } = await supabase
        .from('follow_up_queue')
        .select('skip_reason')
        .eq('status', 'skipped')
        .not('skip_reason', 'is', null)
        .order('created_at', { ascending: false })
        .limit(500);
    const bySkipReason = {};
    for (const row of skipReasons || []) bySkipReason[row.skip_reason] = (bySkipReason[row.skip_reason] || 0) + 1;

    const { data: failedRows, error: failedError } = await supabase
        .from('follow_up_queue')
        .select('id, business_id, contact_id, campaign_id, scheduled_at, last_dispatch_error')
        .eq('status', 'failed')
        .order('scheduled_at', { ascending: false })
        .limit(25);
    if (failedError) return res.status(500).json({ ok: false, error: failedError.message });

    res.json({ ok: true, byStatus, bySkipReason, recentFailed: failedRows || [] });
});

app.post('/debug/api/queue/:id/retry', requireDebugToken, async (req, res) => {
    const { data, error } = await supabase
        .from('follow_up_queue')
        .update({ status: 'ready_to_send', last_dispatch_error: null })
        .eq('id', req.params.id)
        .in('status', ['failed', 'skipped'])
        .select('id')
        .maybeSingle();
    if (error) return res.status(500).json({ ok: false, error: error.message });
    if (!data) return res.status(404).json({ ok: false, error: 'not_found_or_not_retryable' });
    logEvent({ level: 'info', area: 'sender', event: 'queue.manual_retry', message: `Manually retried queue item ${req.params.id}`, entity_id: req.params.id });
    res.json({ ok: true });
});

app.post('/debug/api/queue/retry-transient', requireDebugToken, async (_req, res) => {
    const { data, error } = await supabase
        .from('follow_up_queue')
        .update({ status: 'ready_to_send', last_dispatch_error: null })
        .eq('status', 'failed')
        .not('last_dispatch_error', 'ilike', '%not on whatsapp%')
        .not('last_dispatch_error', 'ilike', '%not registered%')
        .select('id');
    if (error) return res.status(500).json({ ok: false, error: error.message });
    logEvent({ level: 'info', area: 'sender', event: 'queue.bulk_retry', message: `Retried ${data?.length ?? 0} transient failure(s)`, details: { count: data?.length ?? 0 } });
    res.json({ ok: true, retried: data?.length ?? 0 });
});

app.get('/debug/evolution', requireDebugToken, async (_req, res) => {
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

    logEvent({ level: 'info', area: 'webhook', event: 'webhook.received', message: `Evolution event: ${eventType || 'unknown'}`, details: requestMeta });

    let businessId;
    try {
        businessId = await resolveBusinessId(req.body);
    } catch (error) {
        logEvent({ level: 'error', area: 'webhook', event: 'webhook.unknown_instance', message: error.message, details: requestMeta });
        res.status(400).json({ ok: false, error: error.message });
        return;
    }
    requestMeta.businessId = businessId;
    res.status(200).send('OK');

    // CHANGED: every branch below used to log to two places (a raw
    // console.log at the start, and a debugLog 'ok' at the end, neither
    // carrying business_id as a first-class field). Now it's one
    // structured 'ingest' event per branch with business_id attached, so
    // the console can filter "everything for business X" directly.
    const startedAt = Date.now();
    try {
        switch (normalizedEventType) {
            case 'messaging-history.set':
            case 'messaging.history.set':
            case 'messages.set':
                await processHistorySync(req.body, businessId);
                logEvent({ level: 'ok', area: 'ingest', event: 'webhook.history_sync', message: 'History sync completed', business_id: businessId, duration_ms: Date.now() - startedAt });
                break;
            case 'messages.upsert':
                // Evolution sends a single message object as `data` for this
                // event (confirmed via a live payload) — processLiveMessage
                // normalizes single-object vs array internally.
                await processLiveMessage(req.body?.data, businessId);
                logEvent({ level: 'ok', area: 'ingest', event: 'webhook.live_message', message: 'Live message processed', business_id: businessId, duration_ms: Date.now() - startedAt });
                break;
            case 'messages.update':
                await processMessageStatusUpdate(req.body, businessId);
                logEvent({ level: 'ok', area: 'ingest', event: 'webhook.message_status', message: 'Message status processed', business_id: businessId, duration_ms: Date.now() - startedAt });
                break;
            case 'presence.update':
                await processPresenceUpdate(req.body, businessId);
                logEvent({ level: 'debug', area: 'ingest', event: 'webhook.presence', message: 'Presence processed', business_id: businessId, duration_ms: Date.now() - startedAt });
                break;
            case 'connection.update':
                await processConnectionUpdate(req.body, businessId);
                logEvent({ level: 'ok', area: 'connection', event: 'webhook.connection_update', message: 'Connection update persisted', business_id: businessId, duration_ms: Date.now() - startedAt });
                break;
            case 'contacts.set':
                await processContactsSync(req.body, businessId);
                logEvent({ level: 'ok', area: 'ingest', event: 'webhook.contacts_sync', message: 'Contacts sync completed', business_id: businessId, duration_ms: Date.now() - startedAt });
                break;
            case 'contacts.upsert':
                await processContactsUpsert(req.body, businessId);
                logEvent({ level: 'ok', area: 'ingest', event: 'webhook.contact_upsert', message: 'Contact upsert completed', business_id: businessId, duration_ms: Date.now() - startedAt });
                break;
            case 'chats.set':
                await processChatsSync(req.body, businessId);
                logEvent({ level: 'ok', area: 'ingest', event: 'webhook.chats_sync', message: 'Chats sync completed', business_id: businessId, duration_ms: Date.now() - startedAt });
                break;
            case 'chats.upsert':
                await processChatsUpsert(req.body, businessId);
                logEvent({ level: 'ok', area: 'ingest', event: 'webhook.chat_upsert', message: 'Chat upsert completed', business_id: businessId, duration_ms: Date.now() - startedAt });
                break;
            default:
                logEvent({ level: 'debug', area: 'webhook', event: 'webhook.unhandled_type', message: `Event '${eventType}' received`, business_id: businessId, details: requestMeta });
        }
    } catch (err) {
        logEvent({ level: 'error', area: 'webhook', event: 'webhook.processing_failed', message: err?.message || 'Webhook processing failed', business_id: businessId, details: { ...requestMeta, error: err } });
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