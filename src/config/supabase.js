import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { logEvent } from '../services/debugConsole.js';

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY; // service role key — server-side only, never expose to frontend

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('✗ Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in environment');
    process.exit(1);
}

// CHANGED: this used to log two events (request + response) for every
// single database call, which filled the old 500-slot buffer with pure
// noise in seconds. Now it only logs: errors (always, level error),
// slow calls over 800ms (level warn), and everything else as level
// 'debug' (kept in the live buffer, hidden by default in the console,
// and never persisted to system_logs — see debugConsole.js).
const SLOW_QUERY_MS = 800;

const tracedFetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = init.method || input.method || 'GET';
    const started = Date.now();
    try {
        const response = await fetch(input, init);
        const durationMs = Date.now() - started;
        if (!response.ok) {
            const body = await response.clone().text();
            logEvent({
                level: 'error', area: 'db', event: 'db.error',
                message: `${method} ${response.status} ${url}`,
                duration_ms: durationMs,
                details: { method, url, status: response.status, response: body.slice(0, 2000) },
            });
        } else if (durationMs > SLOW_QUERY_MS) {
            logEvent({
                level: 'warn', area: 'db', event: 'db.slow',
                message: `${method} ${response.status} ${url} took ${durationMs}ms`,
                duration_ms: durationMs,
                details: { method, url, status: response.status },
            });
        } else {
            logEvent({
                level: 'debug', area: 'db', event: 'db.ok',
                message: `${method} ${response.status} ${url}`,
                duration_ms: durationMs,
                details: { method, url, status: response.status },
            });
        }
        return response;
    } catch (error) {
        logEvent({
            level: 'error', area: 'db', event: 'db.network_error',
            message: `${method} ${url} — ${error.message}`,
            duration_ms: Date.now() - started,
            details: { method, url, error: { name: error.name, message: error.message } },
        });
        throw error;
    }
};

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    global: { fetch: tracedFetch },
    auth: { persistSession: false }
});
