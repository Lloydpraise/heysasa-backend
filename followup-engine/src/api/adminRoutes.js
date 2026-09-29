// Internal-only endpoints used by the backend's /admin page (proxied from the main
// backend process). They need the engine's code (AI rewrite, built-in prompts), so they
// live here. Protected by the shared DEBUG_TOKEN — fails closed if it isn't configured.
import { Router } from 'express'
import crypto from 'node:crypto'
import { supabase } from '../supabaseClient.js'
import { OPENAI_MODEL } from '../config.js'
import * as prompts from '../scheduler/prompts.js'
import { QC_FALLBACK } from '../lib/qc.js'
import { getContact, getBusiness, getPersonaPack, getConversation } from '../lib/db.js'
import { rewriteSuggestedMessage } from '../scheduler/generateDraft.js'
import { resolveMergeFields } from '../lib/mergeFields.js'
import { getCustomerProfile, getAutoCampaignContext } from '../lib/campaignContext.js'

function tokenOk(req) {
  const configured = process.env.DEBUG_TOKEN
  const provided = String(req.headers['x-debug-token'] ?? '').trim()
  if (!configured || !provided) return false
  const a = Buffer.from(configured)
  const b = Buffer.from(provided)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export const adminRouter = Router()

adminRouter.use('/admin/engine', (req, res, next) => {
  if (!process.env.DEBUG_TOKEN) return res.status(503).json({ ok: false, error: 'debug_token_not_configured' })
  if (!tokenOk(req)) return res.status(401).json({ ok: false, error: 'invalid_debug_token' })
  next()
})

// bot_id -> built-in prompt used when ai_bots_config has no active row for it
const BOT_FALLBACKS = {
  follow_up_generator: prompts.FOLLOWUP_FALLBACK,
  suggestion_rewriter: prompts.SUGGESTION_REWRITE_FALLBACK,
  consent_generator: prompts.CONSENT_FALLBACK,
  conversation_summariser: prompts.SUMMARISER_FALLBACK,
  lead_stage_classifier: prompts.STAGE_CLASSIFIER_FALLBACK,
  opt_in_classifier: prompts.OPT_IN_CLASSIFIER_FALLBACK,
  campaign_reply_intent_classifier: prompts.CAMPAIGN_REPLY_INTENT_FALLBACK,
  followup_qc: QC_FALLBACK,
}

const BOT_CATALOG = {
  follow_up_generator: { bot_name: 'Follow-up message generator', system: 'Follow-up system' },
  suggestion_rewriter: { bot_name: 'Suggestion rewriter', system: 'Follow-up system' },
  consent_generator: { bot_name: 'Consent message generator', system: 'Follow-up system' },
  conversation_summariser: { bot_name: 'Conversation summariser', system: 'Follow-up system' },
  lead_stage_classifier: { bot_name: 'Lead stage classifier', system: 'Follow-up system' },
  opt_in_classifier: { bot_name: 'Opt-in classifier', system: 'Follow-up system' },
  campaign_reply_intent_classifier: { bot_name: 'Campaign reply classifier', system: 'Follow-up system' },
  followup_qc: { bot_name: 'Follow-up quality control', system: 'Follow-up system' },
}

adminRouter.get('/admin/engine/bot-fallbacks', (_req, res) => {
  const catalog = Object.fromEntries(Object.entries(BOT_FALLBACKS).map(([id, prompt]) => [
    id, { ...BOT_CATALOG[id], prompt },
  ]))
  res.json({ ok: true, defaultModel: OPENAI_MODEL, fallbacks: BOT_FALLBACKS, catalog })
})

// Runs the real campaign rewrite for one real lead. Sends nothing and queues nothing.
adminRouter.post('/admin/engine/preview-rewrite', async (req, res) => {
  try {
    const { contact_id: contactId, message, rule_id: ruleId } = req.body ?? {}
    if (!contactId || !String(message ?? '').trim()) {
      return res.status(400).json({ ok: false, error: 'contact_id_and_message_required' })
    }
    const contact = await getContact(supabase, contactId)
    if (!contact) return res.status(404).json({ ok: false, error: 'contact_not_found' })
    const [business, pack, conv, profile] = await Promise.all([
      getBusiness(supabase, contact.business_id),
      getPersonaPack(supabase, contact.business_id),
      getConversation(supabase, contact.id, contact.business_id),
      getCustomerProfile(supabase, contact.id),
    ])

    const stored = ruleId ? await getAutoCampaignContext(supabase, contact.business_id, ruleId) : {}
    const objective = String(req.body.objective ?? '').trim() || stored.objective || null
    const playbook = String(req.body.playbook ?? '').trim() || stored.playbook || null
    const extra = { objective, playbook, profile }

    const result = await rewriteSuggestedMessage(supabase, String(message), contact, business, pack, conv, extra)
    res.json({
      ok: true,
      hasPersonaPack: !!pack,
      contextSent: extra,
      mergeOnly: resolveMergeFields(String(message), contact), // what sends if AI rewrite is OFF
      result: result.ok
        ? { ok: true, draft: result.draft, finalMessage: result.finalMessage, qcPassed: result.qcPassed, qcNotes: result.qcNotes }
        : { ok: false, reason: result.reason, issues: result.issues ?? null, draft: result.draft ?? null },
    })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})
