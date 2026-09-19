import { supabase } from '../supabaseClient.js'
import { getBusiness, getContact } from '../lib/db.js'
import { sendContentViaEvolution } from './evolutionSender.js'
import { checkAntiban, recordSend } from './antiban.js'
import { recordSuccessfulSend, recordFailedDispatch } from './postSend.js'

const BATCH_SIZE = 25
const STALE_CLAIM_MS = 2 * 60_000

async function logSendEvent(businessId, { queueId = null, contactId = null, instanceName = null, eventType, reason = null }) {
  const { error } = await supabase.from('follow_up_send_events').insert({
    business_id: businessId,
    follow_up_queue_id: queueId,
    contact_id: contactId,
    instance_name: instanceName,
    event_type: eventType,
    reason
  })
  if (error) console.error(`[Sender] Failed to log send event: ${error.message}`)
}

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

      if (!business) {
        await recordFailedDispatch(supabase, item, 'business_not_found')
        await logSendEvent(item.business_id, { queueId: item.id, contactId: item.contact_id, eventType: 'business_not_found' })
        continue
      }
      if (!contact?.phone) {
        await recordFailedDispatch(supabase, item, 'contact_or_phone_not_found')
        await logSendEvent(item.business_id, { queueId: item.id, contactId: item.contact_id, eventType: 'contact_or_phone_not_found' })
        continue
      }

      // Campaign items: if the campaign's assigned instance doesn't match
      // what this queue row was stamped with, or the campaign got paused
      // in the meantime, just leave this item for a later pass — nothing
      // here ever fails the campaign itself anymore.
      const { data: campaign } = item.campaign_id
        ? await supabase.from('campaigns').select('whatsapp_instance_name, status').eq('id', item.campaign_id).maybeSingle()
        : { data: null }
      if (item.campaign_id && (!campaign || campaign.status !== 'active' || !item.assigned_instance_name || campaign.whatsapp_instance_name !== item.assigned_instance_name)) {
        continue
      }

      // whatsapp_sessions is the single source of truth for connection
      // state (kept live by Evolution's connection.update webhook) — no
      // extra live ping to re-confirm it. A connected row is trusted as-is;
      // if it's actually stale, the send below will fail for real and get
      // retried like any other send failure.
      const sessionQuery = supabase
        .from('whatsapp_sessions')
        .select('instance_name')
        .eq('business_id', item.business_id)
        .eq('status', 'connected')
      const { data: session, error: sessionError } = item.campaign_id
        ? await sessionQuery.eq('instance_name', item.assigned_instance_name).limit(1)
        : await sessionQuery.order('updated_at', { ascending: false }).limit(1)

      if (sessionError) {
        await logSendEvent(item.business_id, { queueId: item.id, contactId: item.contact_id, eventType: 'session_lookup_failed', reason: sessionError.message })
        continue
      }
      const activeSession = session?.[0] ?? null
      if (!activeSession?.instance_name) {
        // No connected session row at all right now — leave it
        // ready_to_send and pick it back up next poll, no event logged.
        continue
      }

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

      const result = await sendContentViaEvolution(activeSession.instance_name, contact.phone, {
        text: item.final_message,
        media: item.media
      }, contact.country_code)

      if (!result.ok) {
        await recordFailedDispatch(supabase, item, result.error ?? 'send_failed')
        await logSendEvent(item.business_id, {
          queueId: item.id,
          contactId: item.contact_id,
          instanceName: activeSession.instance_name,
          eventType: 'failed',
          reason: result.error ?? 'send_failed'
        })
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
      await logSendEvent(item.business_id, { queueId: item.id, contactId: item.contact_id, eventType: 'failed', reason: e.message }).catch(() => {})
    }
  }

  if (dispatched) console.log(`[Sender] Dispatched ${dispatched}/${items.length}`)
  return { dispatched }
}