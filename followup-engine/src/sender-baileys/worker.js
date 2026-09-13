import { supabase } from '../supabaseClient.js'
import { getBusiness, getContact } from '../lib/db.js'
import { isEvolutionInstanceOpen, sendViaEvolution } from './evolutionSender.js'
import { checkAntiban, recordSend } from './antiban.js'
import { recordSuccessfulSend, recordFailedDispatch } from './postSend.js'

const BATCH_SIZE = 25
const STALE_CLAIM_MS = 2 * 60_000

async function recoverStaleClaims() {
  const cutoff = new Date(Date.now() - STALE_CLAIM_MS).toISOString()
  const { data, error } = await supabase
    .from('follow_up_queue')
    .update({
      status: 'ready_to_send',
      last_dispatch_error: 'recovered_stale_sending_claim'
    })
    .eq('status', 'sending')
    .lte('scheduled_at', cutoff)
    .select('id')

  if (error) {
    console.error(`[Sender] Failed to recover stale claims: ${error.message}`)
    return
  }
  if (data?.length) console.warn(`[Sender] Recovered ${data.length} stale sending claim(s)`)
}

export async function processBaileysBatch() {
  await recoverStaleClaims()

  const { data: items, error } = await supabase
    .from('follow_up_queue')
    .select('*')
    .eq('status', 'ready_to_send')
    .eq('channel', 'baileys')
    .lte('scheduled_at', new Date().toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(BATCH_SIZE)

  if (error) {
    console.error(`[Sender] Failed to fetch batch: ${error.message}`)
    return { dispatched: 0 }
  }
  console.log(`[Sender] Ready-to-send rows found: ${items?.length ?? 0}`)
  if (!items?.length) return { dispatched: 0 }

  let dispatched = 0

  for (const item of items) {
    try {
      const [business, contact] = await Promise.all([
        getBusiness(supabase, item.business_id),
        getContact(supabase, item.contact_id)
      ])

      if (!business) { await recordFailedDispatch(supabase, item, 'business_not_found'); continue }
      if (!contact?.phone) { await recordFailedDispatch(supabase, item, 'contact_or_phone_not_found'); continue }

      // business.evolution_instance_id is a denormalized copy that's never
      // kept in sync when a business reconnects/re-scans — only
      // whatsapp_sessions.instance_name is reliably updated (by
      // saveConnectionState/markSessionConnected/processConnectionUpdate on
      // the main backend). Confirmed via Supabase: this business's
      // evolution_instance_id pointed at an instance name that doesn't even
      // appear in its own whatsapp_sessions history anymore. Look up the
      // live connected instance directly instead of trusting the stale copy.
      const { data: session, error: sessionError } = await supabase
        .from('whatsapp_sessions')
        .select('instance_name')
        .eq('business_id', item.business_id)
        .eq('status', 'connected')
        .order('updated_at', { ascending: false })

      if (sessionError) { await recordFailedDispatch(supabase, item, `session_lookup_failed: ${sessionError.message}`); continue }
      let activeSession = null
      for (const candidate of session ?? []) {
        if (await isEvolutionInstanceOpen(candidate.instance_name)) {
          activeSession = candidate
          break
        }
      }
      if (!activeSession?.instance_name) continue

      // Antiban gate — if not allowed yet, leave it ready_to_send and try
      // again next poll cycle. Don't count this as a failed attempt.
      const gate = checkAntiban(item.business_id, business.followup_daily_cap)
      if (!gate.allowed) continue

      const { data: claimedItem, error: claimError } = await supabase
        .from('follow_up_queue')
        .update({ status: 'sending' })
        .eq('id', item.id)
        .eq('status', 'ready_to_send')
        .select('id')
        .maybeSingle()

      if (claimError) {
        console.error(`[Sender] Could not mark ${item.id} as sending: ${claimError.message}`)
        continue
      }
      if (!claimedItem) continue

      const result = await sendViaEvolution(activeSession.instance_name, contact.phone, item.final_message, contact.country_code)

      if (!result.ok) {
        await recordFailedDispatch(supabase, item, result.error ?? 'send_failed')
        continue
      }

      recordSend(item.business_id)
      await recordSuccessfulSend(supabase, {
        item,
        contact,
        business,
        finalMessage: item.final_message,
        whatsappMessageId: result.messageId
      })
      dispatched++
    } catch (e) {
      console.error(`[Sender] Unexpected error for ${item.id}: ${e.message}`)
      await recordFailedDispatch(supabase, item, e.message).catch(() => {})
    }
  }

  if (dispatched) console.log(`[Sender] Dispatched ${dispatched}/${items.length}`)
  return { dispatched }
}