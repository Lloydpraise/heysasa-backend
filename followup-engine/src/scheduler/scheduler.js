import { runWorker } from './worker.js'

export async function runScheduler(supabase) {
  const { data: items, error } = await supabase
    .from('follow_up_queue')
    .select('id')
    .eq('status', 'pending')
    .eq('approval_status', 'approved')
    .lte('scheduled_at', new Date().toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(50)

  if (error) throw new Error(error.message)
  console.log(`[Scheduler] Pending approved queue rows found: ${items?.length ?? 0}`)
  if (!items?.length) return { processed: 0 }

  // CHANGED from the original: same process, no fetch-to-self hop.
  // The old Deno version had to HTTP-call its own worker route because
  // edge functions are stateless/cold-start-per-invocation. A
  // persistent Node process doesn't have that constraint.
  const results = await Promise.allSettled(
    items.map(item => runWorker(supabase, item.id))
  )

  const failures = results.filter(r => r.status === 'rejected')
  if (failures.length) {
    console.error(`[Scheduler] ${failures.length}/${items.length} worker runs threw`)
  }

  console.log(`[Scheduler] Cycle completed: processed ${items.length}, failures ${failures.length}`)
  return { processed: items.length }
}