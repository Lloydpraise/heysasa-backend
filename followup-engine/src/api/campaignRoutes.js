import { Router } from 'express'
import { supabase } from '../supabaseClient.js'
import { forAccount } from './authMiddleware.js'
import { accountSendState } from '../lib/accounts.js'

export const campaignRouter = Router()

const CAMPAIGN_COLUMNS = 'id, business_id, account_id, status, whatsapp_instance_name, failure_reason, failed_at'

// The campaign must belong to the authenticated business and to the selected account (or, business-wide, to an
// account the user may see).
async function loadOwnedCampaign(req, res) {
  const { data: campaign, error } = await forAccount(supabase
    .from('campaigns')
    .select(CAMPAIGN_COLUMNS)
    .eq('id', req.params.id)
    .eq('business_id', req.businessId), req.scope)
    .maybeSingle()

  if (error) {
    res.status(500).json({ error: error.message })
    return null
  }
  if (!campaign) {
    res.status(404).json({ error: 'campaign_not_found' })
    return null
  }
  return campaign
}

campaignRouter.get('/campaigns/:id', async (req, res) => {
  const campaign = await loadOwnedCampaign(req, res)
  if (campaign) res.json(campaign)
})

// Per-step, per-contact feedback for a campaign: sent -> delivery/read
// status -> replied_at -> reacted_at/emoji, from v_campaign_message_feedback.
// Scoped to the authenticated business via loadOwnedCampaign.
campaignRouter.get('/campaigns/:id/feedback', async (req, res) => {
  const campaign = await loadOwnedCampaign(req, res)
  if (!campaign) return

  const { data: feedback, error } = await supabase
    .from('v_campaign_message_feedback')
    .select('*')
    .eq('campaign_id', campaign.id)
    .order('step_number', { ascending: true })
    .order('sent_at', { ascending: true })

  if (error) return res.status(500).json({ error: error.message })
  res.json(feedback ?? [])
})

// Re-points a campaign at a WhatsApp connection and resumes it if it was failed/paused.
// A campaign that belongs to an account always sends from that account's number (accounts.instance_name): any
// instance_name in the body is ignored. Only campaigns without an account (from before accounts) take one.
campaignRouter.patch('/campaigns/:id/instance', async (req, res) => {
  const campaign = await loadOwnedCampaign(req, res)
  if (!campaign) return

  let instanceName
  if (campaign.account_id) {
    const route = await accountSendState(supabase, campaign.account_id)
    if (!route.ok) return res.status(409).json({ error: route.reason === 'account_suspended' ? 'account_suspended' : 'instance_not_connected' })
    instanceName = route.instance
  } else {
    instanceName = req.body?.instance_name?.trim()
    if (!instanceName) return res.status(400).json({ error: 'instance_name_required' })

    const { data: session, error: sessionError } = await supabase
      .from('whatsapp_sessions')
      .select('instance_name, status, phone_number')
      .eq('business_id', req.businessId)
      .eq('instance_name', instanceName)
      .eq('status', 'connected')
      .limit(1)

    if (sessionError) return res.status(500).json({ error: sessionError.message })
    // whatsapp_sessions is the source of truth now — a connected row is
    // trusted as-is, no extra live ping to Evolution to re-confirm it.
    if (!session?.length) {
      return res.status(409).json({ error: 'instance_not_connected' })
    }
  }

  const updates = { whatsapp_instance_name: instanceName }
  if (campaign.status === 'failed' || campaign.status === 'paused') {
    updates.status = 'active'
    updates.failure_reason = null
    updates.failed_at = null
  }

  const { data: updated, error } = await supabase
    .from('campaigns')
    .update(updates)
    .eq('id', campaign.id)
    .eq('business_id', req.businessId)
    .select(CAMPAIGN_COLUMNS)
    .single()

  if (error) return res.status(500).json({ error: error.message })
  res.json(updated)
})
