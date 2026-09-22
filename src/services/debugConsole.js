import { createClient } from '@supabase/supabase-js';

// ─── In-memory ring buffer + live stream ───────────────────────────────────
// Kept in memory for instant access from the console; also persisted to
// the system_logs table (below) so history survives restarts/deploys.
const MAX_EVENTS = 5000;
const events = [];
const clients = new Set(); // Set<{ res, filters }>
const listeners = [];      // fired on every event — used by alerts.js
let nextId = 1;

// ─── Persistence (batched writes to system_logs) ───────────────────────────
const PERSIST_BATCH_MS = 2000;
const PERSIST_BATCH_MAX = 200;
const PERSIST_QUEUE_CAP = PERSIST_BATCH_MAX * 5;
let pendingWrites = [];

// Deliberately NOT the app's traced supabase client from config/supabase.js
// — that client logs every call through this same module, which would
// make the writer log its own writes forever. This is a second, silent
// client used only for reading/writing system_logs.
let writerClient = null;
function getWriterClient() {
    if (writerClient) return writerClient;
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) return null;
    writerClient = createClient(url, key, { auth: { persistSession: false } });
    return writerClient;
}

function safeValue(value) {
    if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
    if (typeof value === 'string') return value.length > 5000 ? `${value.slice(0, 5000)}...` : value;
    if (value === undefined) return null;
    try {
        const json = JSON.stringify(value);
        return json.length > 15000 ? `${json.slice(0, 15000)}...` : JSON.parse(json);
    } catch {
        return String(value);
    }
}

// Guesses a coarse "area" from a legacy debugLog(level, step, ...) call so
// old call sites keep working unchanged and still show up sensibly
// filtered in the new console.
function areaFromStep(step) {
    const s = String(step || '').toLowerCase();
    if (s.includes('webhook')) return 'webhook';
    if (s.includes('evolution') || s.includes('instance') || s.includes('connection') || s.includes('resync')) return 'connection';
    if (s.includes('follow-up engine') || s.includes('followup engine')) return 'engine';
    if (s.includes('analysis')) return 'analysis';
    if (s.includes('business')) return 'system';
    return 'system';
}

export function logEvent({
    level = 'info',
    area = 'system',
    event = 'event',
    message = '',
    business_id = null,
    contact_id = null,
    entity_id = null,
    duration_ms = null,
    details = {},
} = {}) {
    const row = {
        id: nextId++,
        ts: new Date().toISOString(),
        level,
        area,
        event,
        message,
        business_id,
        contact_id,
        entity_id,
        duration_ms,
        details: safeValue(details),
    };

    events.push(row);
    if (events.length > MAX_EVENTS) events.shift();

    const payload = `data: ${JSON.stringify(row)}\n\n`;
    for (const client of clients) {
        const f = client.filters || {};
        if (f.level && f.level !== row.level) continue;
        if (f.area && f.area !== row.area) continue;
        if (f.business && f.business !== row.business_id) continue;
        client.res.write(payload);
    }

    if (level !== 'debug') {
        pendingWrites.push(row);
        if (pendingWrites.length > PERSIST_QUEUE_CAP) {
            pendingWrites = pendingWrites.slice(-PERSIST_QUEUE_CAP);
        }
    }

    for (const fn of listeners) {
        try { fn(row); } catch { /* a bad listener must never break logging */ }
    }

    return row;
}

// Back-compat: every existing call site using debugLog(level, step, msg,
// details) keeps working exactly as before.
export function debugLog(level, step, message, details = {}) {
    return logEvent({ level, area: areaFromStep(step), event: step, message, details });
}

export function onEvent(fn) {
    listeners.push(fn);
}

export function getDebugEvents() {
    return events;
}

export function attachDebugClient(response, filters = {}) {
    response.write(`data: ${JSON.stringify({ type: 'snapshot', events })}\n\n`);
    const client = { res: response, filters };
    clients.add(client);
    response.on('close', () => clients.delete(client));
}

export function getStreamClientCount() {
    return clients.size;
}

async function flushPendingWrites() {
    if (!pendingWrites.length) return;
    const client = getWriterClient();
    if (!client) return;
    const batch = pendingWrites.splice(0, PERSIST_BATCH_MAX);
    const rows = batch.map((e) => ({
        ts: e.ts, level: e.level, area: e.area, event: e.event, message: e.message,
        business_id: e.business_id, contact_id: e.contact_id, entity_id: e.entity_id,
        duration_ms: e.duration_ms, details: e.details,
    }));
    const { error } = await client.from('system_logs').insert(rows);
    // Never route this failure back through logEvent — that would try to
    // persist the failure itself and loop.
    if (error) console.error(`[DebugConsole] Failed to persist ${rows.length} log row(s): ${error.message}`);
}
setInterval(() => { flushPendingWrites().catch((e) => console.error(`[DebugConsole] Flush error: ${e.message}`)); }, PERSIST_BATCH_MS);

// ─── Retention: keep system_logs from growing forever ──────────────────────
// debug/info/ok rows: 7 days. warn/error rows: 45 days. Runs once a day.
async function runRetention() {
    const client = getWriterClient();
    if (!client) return;
    const infoCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const errorCutoff = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
    await client.from('system_logs').delete().in('level', ['debug', 'info', 'ok']).lt('ts', infoCutoff);
    await client.from('system_logs').delete().in('level', ['warn', 'error']).lt('ts', errorCutoff);
}

const RETENTION_HOUR_UTC = 0; // 03:00 Africa/Nairobi (UTC+3) = 00:00 UTC
let lastRetentionDay = null;
setInterval(() => {
    const now = new Date();
    if (now.getUTCHours() === RETENTION_HOUR_UTC && lastRetentionDay !== now.getUTCDate()) {
        lastRetentionDay = now.getUTCDate();
        runRetention().catch((e) => console.error(`[DebugConsole] Retention failed: ${e.message}`));
    }
}, 60_000);

// ─── History search, used by the console's History tab ────────────────────
export async function queryLogs({ from, to, area, level, business, q, limit = 200 } = {}) {
    const client = getWriterClient();
    if (!client) return { rows: [], error: 'writer_not_configured' };
    let query = client.from('system_logs').select('*').order('ts', { ascending: false }).limit(Math.min(Number(limit) || 200, 500));
    if (from) query = query.gte('ts', from);
    if (to) query = query.lte('ts', to);
    if (area) query = query.eq('area', area);
    if (level) query = query.eq('level', level);
    if (business) query = query.eq('business_id', business);
    if (q) query = query.ilike('message', `%${q}%`);
    const { data, error } = await query;
    return { rows: data || [], error: error?.message || null };
}
