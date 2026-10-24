import express from 'express';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { supabase } from './config/supabase.js';
import { logEvent } from './services/debugConsole.js';
import { forAccount, forAccountOrShared } from './middleware/accessScope.js';
import { scopeOrDebug } from './utils/requestScope.js';

// Same shape as personaRoutes.js: spawns discover-products.js as a child process, forwards its
// @@LOG lines to the debug console (area 'products'), and reports status from enrichment_runs.
const router = express.Router();

let productProcess = null;
let productBusinessId = null;
let productAccountIds = [];

function forwardLine(line, fallbackLevel) {
  if (!line) return;
  if (line.startsWith('@@LOG ')) {
    try {
      logEvent(JSON.parse(line.slice(6)));
      return;
    } catch {
      // fall through to plain-text logging
    }
  }
  logEvent({ level: fallbackLevel, area: 'products', event: 'products.raw_output', message: line, business_id: productBusinessId ?? null });
}

function processStatus() {
  return productProcess
    ? { running: true, pid: productProcess.pid, businessId: productBusinessId, accountIds: productAccountIds }
    : { running: false, businessId: null, accountIds: [] };
}

router.post(['/products/discover', '/debug/products/discover'], async (req, res, next) => {
  try {
    // Shared scope (owner, admin, or a team member on their account) or the debug token. Products are discovered
    // from one WhatsApp number's chats and belong to that account; the business-wide view runs every account.
    const scope = await scopeOrDebug(req, res);
    if (!scope) return;
    const businessId = scope.businessId;
    const accountIds = scope.accountId ? [scope.accountId] : (scope.accountIds || []);

    if (productProcess) {
      res.status(409).json({ ok: false, message: 'Product discovery is already running', ...processStatus() });
      return;
    }

    const force = req.body?.force === true;
    const dryRun = req.body?.dryRun === true;
    const projectRoot = fileURLToPath(new URL('../', import.meta.url));

    productBusinessId = businessId;
    productAccountIds = accountIds;
    logEvent({
      level: 'info', area: 'products', event: 'products.spawn',
      message: `Starting discover-products.js for ${businessId}${dryRun ? ' (dry run)' : ''}`,
      business_id: businessId,
    });

    productProcess = spawn(process.execPath, ['discover-products.js'], {
      cwd: projectRoot,
      env: { ...process.env, PRODUCT_CONFIG: JSON.stringify({ businessId, accountIds, force, dryRun }) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutPending = '';
    let stderrPending = '';
    productProcess.stdout.on('data', (chunk) => {
      stdoutPending += chunk.toString();
      const lines = stdoutPending.split(/\r?\n/);
      stdoutPending = lines.pop() || '';
      for (const line of lines) forwardLine(line, 'info');
    });
    productProcess.stderr.on('data', (chunk) => {
      stderrPending += chunk.toString();
      const lines = stderrPending.split(/\r?\n/);
      stderrPending = lines.pop() || '';
      for (const line of lines) forwardLine(line, 'error');
    });
    productProcess.on('error', (error) => {
      logEvent({
        level: 'error', area: 'products', event: 'products.spawn_failed',
        message: 'Could not start discover-products.js', business_id: businessId, details: { error: error.message },
      });
      productProcess = null;
      productBusinessId = null;
      productAccountIds = [];
    });
    productProcess.on('close', (code, signal) => {
      if (stdoutPending.trim()) forwardLine(stdoutPending, 'info');
      if (stderrPending.trim()) forwardLine(stderrPending, 'error');
      logEvent({
        level: code === 0 ? 'ok' : 'error', area: 'products', event: 'products.finished',
        message: `Finished with code ${code}${signal ? ` (${signal})` : ''}`,
        business_id: businessId, details: { code, signal },
      });
      productProcess = null;
      productBusinessId = null;
      productAccountIds = [];
    });

    res.status(202).json({ ok: true, message: 'Product discovery started', ...processStatus() });
  } catch (error) {
    next(error);
  }
});

router.get('/products/discover/status', async (req, res, next) => {
  try {
    const scope = await scopeOrDebug(req, res);
    if (!scope) return;
    const businessId = scope.businessId;

    const mine = !!productProcess && productBusinessId === businessId
      && (!scope.accountId || productAccountIds.includes(scope.accountId));
    const [{ data: run }, { count: pending }] = await Promise.all([
      forAccount(supabase.from('enrichment_runs')
        .select('id, run_type, status, phase, progress_done, progress_total, started_at, finished_at, heartbeat_at, fatal_error, summary, account_id')
        .eq('business_id', businessId).eq('run_type', 'product_discovery'), scope)
        .order('started_at', { ascending: false }).limit(1).maybeSingle(),
      forAccountOrShared(supabase.from('products').select('id', { count: 'exact', head: true })
        .eq('business_id', businessId).eq('status', 'discovered'), scope),
    ]);
    const state = mine ? 'running'
      : run?.status === 'completed' ? 'ready'
      : run?.status === 'insufficient_data' ? 'insufficient_data'
      : run?.status === 'failed' ? 'failed'
      : 'idle';
    res.json({ state, running: mine, businessId, accountId: scope.accountId, run: run || null, discovered_waiting_for_review: pending ?? 0 });
  } catch (error) {
    next(error);
  }
});

export default router;
