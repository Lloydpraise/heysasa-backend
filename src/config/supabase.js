import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { debugLog } from '../services/debugConsole.js';

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY; // service role key — server-side only, never expose to frontend

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('✗ Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in environment');
    process.exit(1);
}

const tracedFetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = init.method || input.method || 'GET';
    const started = Date.now();
    debugLog('info', 'DB request', `${method} ${url}`, { method, url });
    try {
        const response = await fetch(input, init);
        const body = await response.clone().text();
        const details = { method, url, status: response.status, durationMs: Date.now() - started };
        if (!response.ok) details.response = body;
        debugLog(response.ok ? 'ok' : 'error', 'DB response', `${method} ${response.status} ${url}`, details);
        return response;
    } catch (error) {
        debugLog('error', 'DB network error', `${method} ${url}`, { method, url, durationMs: Date.now() - started, error });
        throw error;
    }
};

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    global: { fetch: tracedFetch },
    auth: { persistSession: false }
});