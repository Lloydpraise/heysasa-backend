import { supabase } from '../supabaseClient.js'
import { SCHEDULER_POLL_INTERVAL_MS } from '../config.js'
import { runScheduler } from './scheduler.js'
import { runCampaignScheduler } from './campaignScheduler.js'
import { runPostSendReconciliation } from './reconciliation.js'
import { runConsent } from './consent.js'
import { runOptInClassifier } from './optInClassifier.js'
import { runCampaignReplyIntentClassifier } from './campaignReplyIntentClassifier.js'
import { runStageClassifier } from './stageClassifier.js'
import { runActivityPatterns } from './activityPatterns.js'
import { log } from '../lib/log.js'

// Each job gets its own guard flag so a slow run never overlaps itself,
// and its own cadence — no reason to run activity-pattern analysis
// every 30s when it's only useful hourly.
//
// CHANGED: a tick used to be invisible unless it threw. That made "is
// this loop actually alive?" unanswerable without guessing from side
// effects elsewhere. Now: every tick error is logged (always — these
// were silently swallowed to a console line before), and a tick that
// did measurable work (any positive count in whatever the function
// returned) logs a summary line. A tick that found nothing to do stays
// silent on purpose — logging "0 processed" every 30 seconds forever
// would bury the console in noise with no recognition value.
function loop(name, fn, intervalMs) {
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      const result = await fn(supabase)
      const counts = result && typeof result === 'object' ? result : {}
      const total = Object.values(counts).reduce((sum, v) => sum + (typeof v === 'number' ? v : 0), 0)
      if (total > 0) {
        log('info', 'engine', 'engine.tick', `${name}: ${JSON.stringify(counts)}`, { details: { loop: name, ...counts } })
      }
      // Fires every tick regardless of whether there was work — this is
      // the signal the Health dashboard uses to tell "quiet because
      // nothing to do" apart from "stuck/dead". Debug level: cheap,
      // shown live, never persisted to system_logs.
      log('debug', 'engine', 'engine.heartbeat', `${name} tick ok`, { details: { loop: name, ok: true } })
    } catch (e) {
      log('error', 'engine', 'engine.tick_error', `${name} tick failed: ${e.message}`, { details: { loop: name, error: { name: e.name, message: e.message } } })
    } finally {
      running = false
    }
  }
  log('info', 'engine', 'engine.loop_started', `${name} starting — polling every ${intervalMs}ms`, { details: { loop: name, intervalMs } })
  tick()
  setInterval(tick, intervalMs)
}

loop('Scheduler', runScheduler, SCHEDULER_POLL_INTERVAL_MS)
loop('CampaignScheduler', runCampaignScheduler, SCHEDULER_POLL_INTERVAL_MS)
loop('Reconciliation', runPostSendReconciliation, SCHEDULER_POLL_INTERVAL_MS)
loop('Consent', runConsent, 5 * 60_000)          // every 5 min — low volume, not urgent
loop('OptInClassifier', runOptInClassifier, 2 * 60_000) // every 2 min — reacts to replies without hammering the AI
loop('CampaignReplyIntentClassifier', runCampaignReplyIntentClassifier, 2 * 60_000) // same cadence — same reasoning
loop('StageClassifier', runStageClassifier, 60_000) // every 1 min — matches the 15-min lookback window with margin
loop('ActivityPatterns', runActivityPatterns, 60 * 60_000) // hourly — cheap to run less often