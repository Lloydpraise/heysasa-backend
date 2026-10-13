import { supabase } from '../supabaseClient.js'
import { log } from './log.js'

// While the analyser (run-local.js) is running it rewrites contacts/conversations in bulk. Reacting to each of
// those realtime events used to launch scheduler and sender work per row (the feedback loop that produced ~30
// Supabase calls a second). During an analysis the engine now ignores contact-change events, and runs ONE
// catch-up pass when the analysis finishes.
//
// "Analysing" means an enrichment_runs row with status running whose heartbeat is under 3 minutes old.
const CACHE_MS = 20_000
const LIVE_MS = 3 * 60_000
const POLL_MS = 30_000

let cache = { at: 0, active: false }
const afterAnalysis = []
let pollTimer = null

export async function isAnalysisActive({ force = false } = {}) {
  if (!force && Date.now() - cache.at < CACHE_MS) return cache.active
  try {
    const since = new Date(Date.now() - LIVE_MS).toISOString()
    const { data, error } = await supabase.from('enrichment_runs').select('id')
      .eq('status', 'running').in('run_type', ['full_pass', 'contact_pass']).gt('heartbeat_at', since).limit(1)
    // Fail open: if we cannot tell, behave as if no analysis is running (the old behaviour).
    cache = { at: Date.now(), active: !error && (data?.length ?? 0) > 0 }
  } catch {
    cache = { at: Date.now(), active: false }
  }
  return cache.active
}

// Register work to run once when an analysis that deferred events has finished.
export function onAnalysisFinished(callback) {
  afterAnalysis.push(callback)
}

// Called when an event was skipped because an analysis is running: makes sure a catch-up is scheduled.
export function deferUntilAnalysisEnds() {
  if (pollTimer) return
  log('info', 'engine', 'engine.analysis_pause', 'Analysis running: contact-change events are paused and will be processed once it finishes')
  pollTimer = setInterval(async () => {
    if (await isAnalysisActive({ force: true })) return
    clearInterval(pollTimer)
    pollTimer = null
    log('info', 'engine', 'engine.analysis_resume', 'Analysis finished: running one catch-up pass')
    for (const callback of afterAnalysis) {
      try { await callback() } catch (e) { log('error', 'engine', 'engine.analysis_resume_failed', e?.message ?? String(e)) }
    }
  }, POLL_MS)
}

export function _resetForTests() {
  cache = { at: 0, active: false }
  afterAnalysis.length = 0
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
}
