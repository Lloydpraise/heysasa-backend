import { log } from '../lib/log.js'

// Auto-lists (Lists & Campaigns -> Automation Rules) are evaluated live by
// public.sync_auto_lists() in Postgres — it reads the current analyser
// output (v_lead_summary-equivalent signals: intent, price_objection,
// last_inbound_at, cart_state, conversions, payment_confirmed_at, etc.)
// and reconciles public.list_members to match each enabled rule, for
// every business at once. The event-driven scheduler invokes it after
// inbound messages, conversation changes and list membership changes.
//
// No AI calls, no billing — this is pure reconciliation against data the
// analyser and message triggers already produced.
// Ad lists (one per ad, filled with the leads that came in through it) are kept up to date by
// public.sync_ad_lists(), on the same tick. Until the ad-lists migration has been run the function does not exist;
// that is not an error worth logging every tick.
async function runAdListSync(supabase) {
  const { data, error } = await supabase.rpc('sync_ad_lists', { p_business_id: null })
  if (error) {
    const notInstalledYet = error.code === 'PGRST202' || /could not find the function/i.test(error.message || '')
    if (!notInstalledYet) {
      log('error', 'engine', 'ad_list_sync.error', `sync_ad_lists failed: ${error.message}`, {
        details: { error: { message: error.message, code: error.code } }
      })
    }
    return 0
  }
  const { created = 0, added = 0, removed = 0 } = data || {}
  return created + added + removed
}

export async function runAutoListSync(supabase) {
  const adMoved = await runAdListSync(supabase)

  const { data, error } = await supabase.rpc('sync_auto_lists')
  if (error) {
    log('error', 'engine', 'auto_list_sync.error', `sync_auto_lists failed: ${error.message}`, {
      details: { error: { message: error.message, code: error.code } }
    })
    return { synced: adMoved }
  }

  const { lists = 0, added = 0, removed = 0, purged = 0, errors = 0 } = data || {}
  if (errors > 0) {
    log('error', 'engine', 'auto_list_sync.partial_failure', `${errors} rule(s) failed to evaluate this tick`, {
      details: { lists, added, removed, purged, errors }
    })
  }

  // synced counts as work done only when membership actually moved —
  // matches the loop() convention in run.js of staying quiet on no-op ticks.
  return { synced: added + removed + purged + adMoved }
}