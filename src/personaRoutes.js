import express from 'express';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { supabase } from './config/supabase.js';
import { logEvent } from './services/debugConsole.js';
import { scopeOrDebug } from './utils/requestScope.js';
import { forAccount } from './middleware/accessScope.js';
import { loadActivePack, packGaps, mergeAnswers, savePackVersion } from './personaPack.js';

// Mirrors the analysisProcess spawn pattern in index.js exactly (same
// child-process shape, same @@LOG forwarding convention) so this shows up
// in the same debug console, just under area 'persona' instead of
// 'analysis'. Kept as its own router file — rather than pasted straight
// into index.js — so it can be reviewed/wired in with a two-line diff.
const router = express.Router();

let personaProcess = null;
let personaBusinessId = null;
let personaAccountIds = [];

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
        ? { running: true, pid: personaProcess.pid, businessId: personaBusinessId, accountIds: personaAccountIds }
        : { running: false, businessId: null, accountIds: [] };
}

// Who may run or read the persona: the shared scope (owner, admin or a team member on their account), or the
// debug token. See src/utils/requestScope.js and ACCOUNTS.md.
async function resolveScopeFor(req, res, opts) {
    return scopeOrDebug(req, res, opts);
}

// Each account generates its own pack from its own chats. A business-wide request generates one pack per
// account, one after the other (accountIds in PERSONA_CONFIG); the generator handles the loop.
async function accountsToGenerate(scope) {
    if (scope.accountId) return [scope.accountId];
    return scope.accountIds?.length ? scope.accountIds : [];
}

router.post(['/persona/generate', '/debug/persona/generate'], async (req, res, next) => {
    try {
        const scope = await resolveScopeFor(req, res);
        if (!scope) return; // response already sent
        const businessId = scope.businessId;
        const accountIds = await accountsToGenerate(scope);

        if (personaProcess) {
            res.status(409).json({ ok: false, message: 'Persona generation is already running', ...personaStatus() });
            return;
        }

        const force = req.body?.force === true;
        // Repo root — this router lives at src/personaRoutes.js, generate-persona-pack.js
        // lives one level up at the repo root, same place run-local.js does.
        const projectRoot = fileURLToPath(new URL('../', import.meta.url));

        personaBusinessId = businessId;
        personaAccountIds = accountIds;
        logEvent({
            level: 'info', area: 'persona', event: 'persona.spawn',
            message: `Starting generate-persona-pack.js for ${businessId}${accountIds.length ? ` (${accountIds.length} account${accountIds.length === 1 ? '' : 's'})` : ''}`,
            business_id: businessId, details: { accountIds }
        });

        personaProcess = spawn(process.execPath, ['generate-persona-pack.js'], {
            cwd: projectRoot,
            env: { ...process.env, PERSONA_CONFIG: JSON.stringify({ businessId, accountIds, force }) },
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
            personaAccountIds = [];
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
            personaAccountIds = [];
        });

        res.status(202).json({ ok: true, message: 'Persona pack generation started', ...personaStatus() });
    } catch (error) {
        next(error);
    }
});

// Latest run of a type for one business, straight from the database, so status
// survives restarts and shows the current phase (e.g. waiting_for_analysis).
// Runs belong to an account (enrichment_runs.account_id); the business-wide view sees the latest of any account.
async function latestRun(scope, runTypes) {
    const query = supabase
        .from('enrichment_runs')
        .select('id, run_type, status, phase, progress_done, progress_total, started_at, finished_at, heartbeat_at, fatal_error, summary, account_id')
        .eq('business_id', scope.businessId)
        .in('run_type', runTypes);
    const { data } = await forAccount(query, scope)
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    return data || null;
}

router.get('/persona/status', async (req, res, next) => {
    try {
        const scope = await resolveScopeFor(req, res);
        if (!scope) return;
        const businessId = scope.businessId;

        const mine = !!personaProcess && personaBusinessId === businessId
            && (!scope.accountId || personaAccountIds.includes(scope.accountId));
        const [run, analysis, active] = await Promise.all([
            latestRun(scope, ['persona_pack']),
            latestRun(scope, ['full_pass', 'contact_pass']),
            loadActivePack(supabase, businessId, scope.accountId, 'id, version, pack, account_id'),
        ]);
        const state = mine ? 'running'
            : run?.status === 'completed' ? 'ready'
            : run?.status === 'insufficient_data' ? 'insufficient_data'
            : run?.status === 'failed' ? 'failed'
            : 'idle';
        res.json({
            state,
            running: mine,
            businessId,
            accountId: scope.accountId,
            run,        // phase, summary.reason (why nothing was generated), funnel counts
            analysis,   // the analyser run this pack depends on
            source: active.source,          // 'account' (its own pack), 'business' (the business-wide fallback) or null
            version: active.row?.version ?? null,
            gaps: packGaps(active.pack),    // key fields still empty: the persona screen asks the owner these
        });
    } catch (error) {
        next(error);
    }
});

// The pack the selected account uses, where it comes from, and what is still missing.
//   GET  /persona          -> { pack, source: 'account'|'business'|null, version, gaps: [{ key, question }] }
//   POST /persona/answers  { answers: { tone, greeting, products, customers, pricing, delivery, faqs, handoff } }
//        merges the owner's answers into the account's pack (starting from the business-wide one when the account
//        has none yet) and saves it as a new active version of the account's pack.
router.get('/persona', async (req, res, next) => {
    try {
        const scope = await resolveScopeFor(req, res);
        if (!scope) return;
        const active = await loadActivePack(supabase, scope.businessId, scope.accountId);
        res.json({
            ok: true,
            businessId: scope.businessId,
            accountId: scope.accountId,
            source: active.source,
            version: active.row?.version ?? null,
            pack: active.pack,
            gaps: packGaps(active.pack),
        });
    } catch (error) {
        next(error);
    }
});

router.post('/persona/answers', async (req, res, next) => {
    try {
        // Answers go into one account's pack. The business-wide view (several accounts) writes the business pack.
        const scope = await resolveScopeFor(req, res);
        if (!scope) return;
        const answers = req.body?.answers;
        if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
            res.status(400).json({ ok: false, error: 'answers_required' });
            return;
        }
        if (!scope.accountId && !scope.isAdmin) {
            res.status(400).json({ ok: false, error: 'account_required' });
            return;
        }
        const active = await loadActivePack(supabase, scope.businessId, scope.accountId);
        const { pack, applied } = mergeAnswers(active.pack, answers);
        if (!applied.length) {
            res.status(400).json({ ok: false, error: 'no_answers' });
            return;
        }
        const saved = await savePackVersion(supabase, { businessId: scope.businessId, accountId: scope.accountId, pack, generatedBy: 'owner_answers' });
        logEvent({
            level: 'info', area: 'persona', event: 'persona.answers_saved',
            message: `Owner answered ${applied.join(', ')}`, business_id: scope.businessId, details: { accountId: scope.accountId, version: saved.version },
        });
        res.json({
            ok: true, applied, version: saved.version,
            source: scope.accountId ? 'account' : 'business',
            pack, gaps: packGaps(pack),
        });
    } catch (error) {
        next(error);
    }
});

export default router;
