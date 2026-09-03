import { supabase } from '../supabaseClient.js'
import { SCHEDULER_POLL_INTERVAL_MS } from '../config.js'
import { runScheduler } from './scheduler.js'
import { runCampaignScheduler } from './campaignScheduler.js'
import { runPostSendReconciliation } from './reconciliation.js'
import { runConsent } from './consent.js'
import { runOptInClassifier } from './optInClassifier.js'
import { runStageClassifier } from './stageClassifier.js'
import { runActivityPatterns } from './activityPatterns.js'

// Each job gets its own guard flag so a slow run never overlaps itself,
// and its own cadence — no reason to run activity-pattern analysis
// every 30s when it's only useful hourly.
function loop(name, fn, intervalMs) {
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      await fn(supabase)
    } catch (e) {
      console.error(`[${name}] Tick error: ${e.message}`)
    } finally {
      running = false
    }
  }
  console.log(`[${name}] Starting — polling every ${intervalMs}ms`)
  tick()
  setInterval(tick, intervalMs)
}

loop('Scheduler', runScheduler, SCHEDULER_POLL_INTERVAL_MS)
loop('CampaignScheduler', runCampaignScheduler, SCHEDULER_POLL_INTERVAL_MS)
loop('Reconciliation', runPostSendReconciliation, SCHEDULER_POLL_INTERVAL_MS)
loop('Consent', runConsent, 5 * 60_000)          // every 5 min — low volume, not urgent
loop('OptInClassifier', runOptInClassifier, 2 * 60_000) // every 2 min — reacts to replies without hammering the AI
loop('StageClassifier', runStageClassifier, 60_000) // every 1 min — matches the 15-min lookback window with margin
loop('ActivityPatterns', runActivityPatterns, 60 * 60_000) // hourly — cheap to run less often