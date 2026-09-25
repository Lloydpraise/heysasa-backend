import { runWorker } from './worker.js'
import { isBusinessAwake } from '../lib/timing.js'
import { log } from '../lib/log.js'

export async function runScheduler(supabase) {
  const { data: items, error } = await supabase
    .from('follow_up_queue')
    .select('id, business_id')
    .eq('status', 'pending')
    .eq('approval_status', 'approved')
    .lte('scheduled_at', new Date().toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(50)

  if (error) throw new Error(error.message)
  if (!items?.length) return { processed: 0 }

  // "Sleep mode" — hold every item for a business that's currently in
  // quiet hours or on an inactive day, untouched (no reschedule, no
  // write at all). They stay 'pending' and are picked back up together
  // the moment the business's active hours return, instead of each one
  // being individually rescheduled by the worker (which used to produce
  // a wall of per-item stall events every night).
  const businessIds = [...new Set(items.map(item => item.business_id))]
  const { data: businesses, error: businessError } = await supabase
    .from('businesses')
    .select('business_id, timezone, followup_quiet_start, followup_quiet_end, followup_active_days')
    .in('business_id', businessIds)
  if (businessError) throw new Error(businessError.message)

  const awakeBusinessIds = new Set(
    (businesses ?? []).filter(b => isBusinessAwake(b)).map(b => b.business_id)
  )
  const awakeItems = items.filter(item => awakeBusinessIds.has(item.business_id))
  const asleepCount = items.length - awakeItems.length
  if (asleepCount) log('debug', 'engine', 'scheduler.holding', `Holding ${asleepCount} item(s) — business asleep (quiet hours/inactive day)`, { details: { asleepCount } })
  if (!awakeItems.length) return { processed: 0 }

  // CHANGED from the original: same process, no fetch-to-self hop.
  // The old Deno version had to HTTP-call its own worker route because
  // edge functions are stateless/cold-start-per-invocation. A
  // persistent Node process doesn't have that constraint.
  const results = await Promise.allSettled(
    awakeItems.map(item => runWorker(supabase, item.id))
  )

  const failures = results.filter(r => r.status === 'rejected')
  if (failures.length) {
    log('error', 'engine', 'scheduler.worker_failures', `${failures.length}/${awakeItems.length} worker runs threw`, { details: { failed: failures.length, total: awakeItems.length } })
  }

  if (awakeItems.length) log('info', 'engine', 'scheduler.cycle_completed', `Cycle completed: processed ${awakeItems.length}, failures ${failures.length}`, { details: { processed: awakeItems.length, failures: failures.length } })
  return { processed: awakeItems.length }
}