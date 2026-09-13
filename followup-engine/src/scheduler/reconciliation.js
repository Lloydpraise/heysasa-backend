import { getContact, getBusiness, getConversation, getMessages, getNextSequenceStep, getPersonaPack } from '../lib/db.js'
import { calculateSendTime, getZonedParts } from '../lib/timing.js'
import { sendPlatformMessage } from '../sender-baileys/evolutionSender.js'
import { DEFAULT_QUIET_START, DEFAULT_QUIET_END, DEFAULT_TIMEZONE } from '../config.js'

const BATCH_SIZE = 50

// CHANGED from the original postSendUpdates: this only runs the
// scheduling-decision half (queue next step, hot-lead alert). The
// send-bookkeeping half (message log, contact counters, balance
// deduction) now lives in the sender that actually dispatched the
// message — see sender-baileys/postSend.js — because only the sender
// knows the send genuinely happened.
export async function runPostSendReconciliation(supabase) {
  const { data: items, error } = await supabase
    .from('follow_up_queue')
    .select('*')
    .eq('status', 'sent')
    .eq('next_step_processed', false)
    .limit(BATCH_SIZE)

  if (error) throw new Error(error.message)
  if (!items?.length) return { reconciled: 0 }

  let reconciled = 0
  for (const item of items) {
    try {
      const [contact, business] = await Promise.all([
        getContact(supabase, item.contact_id),
        getBusiness(supabase, item.business_id)
      ])
      if (!contact || !business) {
        await supabase.from('follow_up_queue').update({ next_step_processed: true }).eq('id', item.id)
        continue
      }

      // Quiet hours: business prefs first (Follow-up tab), persona pack
      // as fallback — same source order as worker.js, kept consistent
      // since this runs independently, possibly much later.
      const pack = await getPersonaPack(supabase, item.business_id)
      const rules = pack?.follow_up_rules ?? {}
      const timeZone = business.timezone || DEFAULT_TIMEZONE
      const quietStart = business.followup_quiet_start
        ?? parseInt(rules.quiet_hours_start ?? String(DEFAULT_QUIET_START))
      const quietEnd = business.followup_quiet_end
        ?? parseInt(rules.quiet_hours_end ?? String(DEFAULT_QUIET_END))

      // Schedule next step
      if (contact.follow_up_sequence_id && !item.campaign_id) {
        const nextStep = await getNextSequenceStep(supabase, contact.follow_up_sequence_id, item.sequence_step)
        if (nextStep) {
          const nextTime = calculateSendTime(nextStep.delay_hours ?? 48, contact.optimal_contact_hour, quietStart, quietEnd, timeZone)
          await supabase.from('follow_up_queue').insert({
            business_id: item.business_id,
            contact_id: item.contact_id,
            conversation_id: item.conversation_id,
            sequence_step: nextStep.step_number,
            touchpoint_type: nextStep.touchpoint_type,
            klt_phase: nextStep.klt_phase,
            follow_up_cycle: item.follow_up_cycle ?? 1,
            scheduled_at: nextTime.toISOString(),
            send_at_hour: getZonedParts(nextTime, timeZone).hour,
            status: 'pending',
            approval_status: 'approved' // approval zone re-evaluated at process time
          })
        }
      }

      // Hot lead alert check — sent directly via the platform Evolution
      // instance (an internal owner notification, not a customer
      // follow-up, so it doesn't go through 02's antiban queue)
      if (business.hot_lead_alert_enabled && contact.lead_state === 'engaged' && business.owner_phone) {
        const conv = await getConversation(supabase, item.contact_id, item.business_id)
        const inbound = conv ? (await getMessages(supabase, conv.id)).filter(m => m.direction === 'in') : []
        const lastIn = inbound.at(-1)
        const threshold = business.hot_lead_intent_threshold ?? 8
        if ((lastIn?.intent_level ?? 0) >= threshold) {
          const alertMsg = `🔥 Hot lead alert: ${contact.name ?? contact.phone} is showing strong buying intent. Check your HeySasa dashboard.`
          await sendPlatformMessage(business.owner_phone, alertMsg).catch(() => {})
        }
      }

      await supabase.from('follow_up_queue').update({ next_step_processed: true }).eq('id', item.id)
      reconciled++
    } catch (e) {
      console.error(`[Reconciliation] Error for ${item.id}: ${e.message}`)
    }
  }

  if (reconciled) console.log(`[Reconciliation] Processed ${reconciled}`)
  return { reconciled }
}