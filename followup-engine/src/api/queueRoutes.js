import { Router } from 'express'
import { supabase } from '../supabaseClient.js'
import { getBusiness, getContact, getPersonaPack, getConversation } from '../lib/db.js'
import { generateFollowupDraft } from '../scheduler/generateDraft.js'

export const queueRouter = Router()

// Shared loader — fetches the item and confirms it belongs to the
// authenticated business AND is actually awaiting approval. Every
// route below calls this first.
async function loadOwnedAwaitingItem(req, res) {
  const { id } = req.params
  const { data: item, error } = await supabase
    .from('follow_up_queue').select('*').eq('id', id).single()

  if (error || !item) { res.status(404).json({ error: 'not_found' }); return null }
  if (item.business_id !== req.businessId) { res.status(403).json({ error: 'forbidden' }); return null }
  if (item.approval_status !== 'awaiting_approval') {
    res.status(409).json({ error: 'not_awaiting_approval', status: item.approval_status })
    return null
  }
  return item
}

// GET /queue/pending — list this business's messages needing approval
queueRouter.get('/queue/pending', async (req, res) => {
  const { data, error } = await supabase
    .from('follow_up_queue')
    .select('id, contact_id, sequence_step, touchpoint_type, draft_message, qc_passed, qc_notes, scheduled_at')
    .eq('business_id', req.businessId)
    .eq('approval_status', 'awaiting_approval')
    .order('scheduled_at', { ascending: true })

  if (error) return res.status(500).json({ error: error.message })
  res.json({ items: data })
})

// GET /queue/status — delivery history and current scheduling state
queueRouter.get('/queue/status', async (req, res) => {
  const { data, error } = await supabase
    .from('follow_up_queue')
    .select('id, contact_id, campaign_id, campaign_step, sequence_step, touchpoint_type, status, approval_status, channel, final_message, scheduled_at, processed_at, dispatch_attempts, last_dispatch_error, skip_reason, created_at')
    .eq('business_id', req.businessId)
    .order('scheduled_at', { ascending: false })
    .limit(100)

  if (error) return res.status(500).json({ error: error.message })
  res.json({ items: data })
})

// POST /queue/:id/approve — { text?: string } — approve as-is, or approve with an inline edit
queueRouter.post('/queue/:id/approve', async (req, res) => {
  const item = await loadOwnedAwaitingItem(req, res)
  if (!item) return

  const business = await getBusiness(supabase, item.business_id)
  if (!business) return res.status(500).json({ error: 'business_not_found' })

  const finalMessage = req.body?.text?.trim() || item.draft_message
  if (!finalMessage) return res.status(400).json({ error: 'no_message_to_approve' })

  await supabase.from('follow_up_queue').update({
    status: 'ready_to_send',
    channel: business.whatsapp_channel,
    final_message: finalMessage,
    draft_message: finalMessage,
    approval_status: 'approved'
  }).eq('id', item.id)

  console.log(`[Approval] Approved ${item.id} for business ${req.businessId}`)
  res.json({ status: 'ready_to_send', channel: business.whatsapp_channel })
})

// POST /queue/:id/edit — { text: string } — save edited text, stays awaiting_approval
queueRouter.post('/queue/:id/edit', async (req, res) => {
  const item = await loadOwnedAwaitingItem(req, res)
  if (!item) return

  const text = req.body?.text?.trim()
  if (!text) return res.status(400).json({ error: 'text_required' })

  await supabase.from('follow_up_queue').update({ draft_message: text }).eq('id', item.id)

  console.log(`[Approval] Edited ${item.id} for business ${req.businessId}`)
  res.json({ status: 'awaiting_approval', draft_message: text })
})

// POST /queue/:id/regenerate — reruns generation + QC, stays awaiting_approval
queueRouter.post('/queue/:id/regenerate', async (req, res) => {
  const item = await loadOwnedAwaitingItem(req, res)
  if (!item) return

  const [contact, business] = await Promise.all([
    getContact(supabase, item.contact_id),
    getBusiness(supabase, item.business_id)
  ])
  if (!contact || !business) return res.status(500).json({ error: 'contact_or_business_not_found' })

  const pack = await getPersonaPack(supabase, item.business_id)
  if (!pack) return res.status(500).json({ error: 'no_persona_pack' })

  const conv = await getConversation(supabase, item.contact_id, item.business_id)

  const result = await generateFollowupDraft(supabase, item, contact, business, pack, conv)
  if (!result.ok) {
    return res.status(502).json({ error: result.reason, issues: result.issues, draft: result.draft })
  }

  await supabase.from('follow_up_queue').update({
    draft_message: result.finalMessage,
    qc_passed: result.qcPassed,
    qc_notes: result.qcNotes
  }).eq('id', item.id)

  console.log(`[Approval] Regenerated ${item.id} for business ${req.businessId}`)
  res.json({ status: 'awaiting_approval', draft_message: result.finalMessage, qc_passed: result.qcPassed, qc_notes: result.qcNotes })
})

// POST /queue/:id/reject
queueRouter.post('/queue/:id/reject', async (req, res) => {
  const item = await loadOwnedAwaitingItem(req, res)
  if (!item) return

  await supabase.from('follow_up_queue').update({
    approval_status: 'rejected',
    status: 'skipped',
    skip_reason: 'rejected_by_owner'
  }).eq('id', item.id)

  console.log(`[Approval] Rejected ${item.id} for business ${req.businessId}`)
  res.json({ status: 'rejected' })
})