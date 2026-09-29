import { log } from '../lib/log.js'

// Auto-lists (Lists & Campaigns -> Automation Rules) are evaluated live by
// public.sync_auto_lists() in Postgres — it reads the current analyser
// output (v_lead_summary-equivalent signals: intent, price_objection,
// last_inbound_at, cart_state, conversions, payment_confirmed_at, etc.)
// and reconciles public.list_members to match each enabled rule, for
// every business at once. A pg_cron job runs it every 10 minutes as a
// safety net so lists never go fully stale even if this process is down.
//
// This loop rides the same 60s cadence as StageClassifier (which is what
// most rules react to — a stage change is often exactly what moves a
// lead from one auto-list to another) so that a rule's list reflects the
// stage the lead is now in within a minute, not up to 10.
//
// No AI calls, no billing — this is pure reconciliation against data the
// analyser and message triggers already produced.
export async function runAutoListSync(supabase) {
  const { data, error } = await supabase.rpc('sync_auto_lists')
  if (error) {
    log('error', 'engine', 'auto_list_sync.error', `sync_auto_lists failed: ${error.message}`, {
      details: { error: { message: error.message, code: error.code } }
    })
    return { synced: 0 }
  }

  const { lists = 0, added = 0, removed = 0, purged = 0, errors = 0 } = data || {}
  if (errors > 0) {
    log('error', 'engine', 'auto_list_sync.partial_failure', `${errors} rule(s) failed to evaluate this tick`, {
      details: { lists, added, removed, purged, errors }
    })
  }

  // synced counts as work done only when membership actually moved —
  // matches the loop() convention in run.js of staying quiet on no-op ticks.
  return { synced: added + removed + purged }
}