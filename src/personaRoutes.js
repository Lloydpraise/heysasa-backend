import express from 'express';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { supabase } from './config/supabase.js';
import { isDebugTokenValid } from './middleware/debugAuth.js';
import { logEvent } from './services/debugConsole.js';

// Mirrors the analysisProcess spawn pattern in index.js exactly (same
// child-process shape, same @@LOG forwarding convention) so this shows up
// in the same debug console, just under area 'persona' instead of
// 'analysis'. Kept as its own router file — rather than pasted straight
// into index.js — so it can be reviewed/wired in with a two-line diff.
const router = express.Router();

let personaProcess = null;
let personaBusinessId = null;

function forwardPersonaLine(line, fallbackLevel) {
    if (!line) return;
    if (line.startsWith('@@LOG ')) {
        try {
            logEvent(JSON.parse(line.slice(6)));
            return;
        } catch {
            // fall through to plain-text logging below
        }
    }
    logEvent({ level: fallbackLevel, area: 'persona', event: 'persona.raw_output', message: line, business_id: personaBusinessId ?? null });
}

function personaStatus() {
    return personaProcess
        ? { running: true, pid: personaProcess.pid, businessId: personaBusinessId }
        : { running: false, businessId: null };
}

// businessId is the key for this whole flow. Read it from the X-Business-Id
// header first — same convention followup-engine/src/api/authMiddleware.js
// already uses — falling back to the JSON body for callers that prefer that.
// Ownership check mirrors src/index.js's existing startAnalysis handler
// (owner_email off the Supabase auth JWT), so this behaves the same way as
// the analyser trigger the frontend already calls.
async function resolveBusinessId(req, res) {
    const headerBusinessId = typeof req.headers['x-business-id'] === 'string' ? req.headers['x-business-id'].trim() : null;
    const bodyBusinessId = typeof req.body?.businessId === 'string' ? req.body.businessId.trim() : null;
    const requestedBusinessId = headerBusinessId || bodyBusinessId;

    if (!requestedBusinessId) {
        res.status(400).json({ ok: false, error: 'missing_business_id' });
        return null;
    }

    if (isDebugTokenValid(req)) {
        return requestedBusinessId;
    }

    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
    if (!token) {
        res.status(401).json({ ok: false, error: 'missing_auth_token' });
        return null;
    }

    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData?.user?.email) {
        res.status(401).json({ ok: false, error: 'invalid_auth_token' });
        return null;
    }

    const { data: ownedBusiness, error: businessError } = await supabase
        .from('businesses')
        .select('business_id')
        .eq('business_id', requestedBusinessId)
        .eq('owner_email', userData.user.email)
        .maybeSingle();
    if (businessError || !ownedBusiness) {
        res.status(403).json({ ok: false, error: 'business_not_owned' });
        return null;
    }

    return ownedBusiness.business_id;
}

router.post(['/persona/generate', '/debug/persona/generate'], async (req, res, next) => {
    try {
        const businessId = await resolveBusinessId(req, res);
        if (!businessId) return; // response already sent by resolveBusinessId

        if (personaProcess) {
            res.status(409).json({ ok: false, message: 'Persona generation is already running', ...personaStatus() });
            return;
        }

        const force = req.body?.force === true;
        // Repo root — this router lives at src/personaRoutes.js, generate-persona-pack.js
        // lives one level up at the repo root, same place run-local.js does.
        const projectRoot = fileURLToPath(new URL('../', import.meta.url));

        personaBusinessId = businessId;
        logEvent({
            level: 'info', area: 'persona', event: 'persona.spawn',
            message: `Starting generate-persona-pack.js for ${businessId}`,
            business_id: businessId
        });

        personaProcess = spawn(process.execPath, ['generate-persona-pack.js'], {
            cwd: projectRoot,
            env: { ...process.env, PERSONA_CONFIG: JSON.stringify({ businessId, force }) },
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stdoutPending = '';
        let stderrPending = '';
        personaProcess.stdout.on('data', (chunk) => {
            stdoutPending += chunk.toString();
            const lines = stdoutPending.split(/\r?\n/);
            stdoutPending = lines.pop() || '';
            for (const line of lines) forwardPersonaLine(line, 'info');
        });
        personaProcess.stderr.on('data', (chunk) => {
            stderrPending += chunk.toString();
            const lines = stderrPending.split(/\r?\n/);
            stderrPending = lines.pop() || '';
            for (const line of lines) forwardPersonaLine(line, 'error');
        });
        personaProcess.on('error', (error) => {
            logEvent({
                level: 'error', area: 'persona', event: 'persona.spawn_failed',
                message: 'Could not start generate-persona-pack.js',
                business_id: businessId, details: { error: error.message }
            });
            personaProcess = null;
            personaBusinessId = null;
        });
        personaProcess.on('close', (code, signal) => {
            if (stdoutPending.trim()) forwardPersonaLine(stdoutPending, 'info');
            if (stderrPending.trim()) forwardPersonaLine(stderrPending, 'error');
            logEvent({
                level: code === 0 ? 'ok' : 'error', area: 'persona', event: 'persona.finished',
                message: `Finished with code ${code}${signal ? ` (${signal})` : ''}`,
                business_id: businessId, details: { code, signal }
            });
            personaProcess = null;
            personaBusinessId = null;
        });

        res.status(202).json({ ok: true, message: 'Persona pack generation started', ...personaStatus() });
    } catch (error) {
        next(error);
    }
});

router.get('/persona/status', async (req, res, next) => {
    try {
        const businessId = await resolveBusinessId(req, res);
        if (!businessId) return;

        if (personaProcess && personaBusinessId !== businessId) {
            res.json({ running: false, businessId: null });
            return;
        }
        res.json(personaStatus());
    } catch (error) {
        next(error);
    }
});

export default router;
