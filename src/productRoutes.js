import express from 'express';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { supabase } from './config/supabase.js';
import { isDebugTokenValid } from './middleware/debugAuth.js';
import { logEvent } from './services/debugConsole.js';

// Same shape as personaRoutes.js: spawns discover-products.js as a child process, forwards its
// @@LOG lines to the debug console (area 'products'), and reports status from enrichment_runs.
const router = express.Router();

let productProcess = null;
let productBusinessId = null;

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
    ? { running: true, pid: productProcess.pid, businessId: productBusinessId }
    : { running: false, businessId: null };
}

// Same ownership check as /analysis/start and /persona/generate: X-Business-Id header (or body),
// then the Supabase auth token must belong to that business's owner_email.
async function resolveBusinessId(req, res) {
  const headerBusinessId = typeof req.headers['x-business-id'] === 'string' ? req.headers['x-business-id'].trim() : null;
  const bodyBusinessId = typeof req.body?.businessId === 'string' ? req.body.businessId.trim() : null;
  const requestedBusinessId = headerBusinessId || bodyBusinessId;

  if (!requestedBusinessId) {
    res.status(400).json({ ok: false, error: 'missing_business_id' });
    return null;
  }
  if (isDebugTokenValid(req)) return requestedBusinessId;

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

router.post(['/products/discover', '/debug/products/discover'], async (req, res, next) => {
  try {
    const businessId = await resolveBusinessId(req, res);
    if (!businessId) return;

    if (productProcess) {
      res.status(409).json({ ok: false, message: 'Product discovery is already running', ...processStatus() });
      return;
    }

    const force = req.body?.force === true;
    const dryRun = req.body?.dryRun === true;
    const projectRoot = fileURLToPath(new URL('../', import.meta.url));

    productBusinessId = businessId;
    logEvent({
      level: 'info', area: 'products', event: 'products.spawn',
      message: `Starting discover-products.js for ${businessId}${dryRun ? ' (dry run)' : ''}`,
      business_id: businessId,
    });

    productProcess = spawn(process.execPath, ['discover-products.js'], {
      cwd: projectRoot,
      env: { ...process.env, PRODUCT_CONFIG: JSON.stringify({ businessId, force, dryRun }) },
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
    });

    res.status(202).json({ ok: true, message: 'Product discovery started', ...processStatus() });
  } catch (error) {
    next(error);
  }
});

router.get('/products/discover/status', async (req, res, next) => {
  try {
    const businessId = await resolveBusinessId(req, res);
    if (!businessId) return;

    const mine = !!productProcess && productBusinessId === businessId;
    const [{ data: run }, { count: pending }] = await Promise.all([
      supabase.from('enrichment_runs')
        .select('id, run_type, status, phase, progress_done, progress_total, started_at, finished_at, heartbeat_at, fatal_error, summary')
        .eq('business_id', businessId).eq('run_type', 'product_discovery')
        .order('started_at', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('products').select('id', { count: 'exact', head: true })
        .eq('business_id', businessId).eq('status', 'discovered'),
    ]);
    const state = mine ? 'running'
      : run?.status === 'completed' ? 'ready'
      : run?.status === 'insufficient_data' ? 'insufficient_data'
      : run?.status === 'failed' ? 'failed'
      : 'idle';
    res.json({ state, running: mine, businessId, run: run || null, discovered_waiting_for_review: pending ?? 0 });
  } catch (error) {
    next(error);
  }
});

export default router;
