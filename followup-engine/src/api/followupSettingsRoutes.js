import { Router } from 'express'
import { supabase } from '../supabaseClient.js'

export const followupSettingsRouter = Router()

// Maps UI prefs object <-> businesses columns. Keeping this table
// explicit (rather than spreading req.body straight into .update())
// means a stray/renamed field from the frontend can never silently
// write to the wrong column or an unrelated one.
const FIELD_MAP = {
  followup_enabled: 'followup_ai_enabled',
  max_per_lead: 'followup_max_per_lead',
  daily_cap: 'followup_daily_cap',
  quiet_start: 'followup_quiet_start',
  quiet_end: 'followup_quiet_end',
  active_days: 'followup_active_days',
  zone_recent_days: 'followup_zone_recent',
  zone_recent_mode: 'followup_zone_recent_mode',
  zone_medium_days: 'followup_zone_medium',
  zone_medium_mode: 'followup_zone_medium_mode',
  zone_old_mode: 'followup_zone_old_mode',
  stop_at_stage: 'followup_stop_at_stage',
  alert_at_stage: 'followup_alert_at_stage',
  nudge_enabled: 'followup_nudge_enabled',
  nudge_min_pending: 'followup_nudge_min_pending',
  nudge_interval_hrs: 'followup_nudge_interval_hrs',
  hot_lead_alert: 'hot_lead_alert_enabled',
  hot_lead_threshold: 'hot_lead_intent_threshold',
}

// Stats shown in Preferences but never written by the Save button —
// kept separate from FIELD_MAP so a PUT can never overwrite them.
const READONLY_FIELD_MAP = {
  lifetime_sent: 'followup_total_sent',
}

const VALID_MODES = ['approval', 'manual', 'auto']

function toDbRow(prefs) {
  const row = {}
  for (const [uiKey, dbCol] of Object.entries(FIELD_MAP)) {
    if (prefs[uiKey] !== undefined) row[dbCol] = prefs[uiKey]
  }
  return row
}

function toUiPrefs(row) {
  const prefs = {}
  for (const [uiKey, dbCol] of Object.entries(FIELD_MAP)) {
    prefs[uiKey] = row[dbCol]
  }
  return prefs
}

// GET /settings/followup — load current prefs for this business
followupSettingsRouter.get('/settings/followup', async (req, res) => {
  const allColumns = [...Object.values(FIELD_MAP), ...Object.values(READONLY_FIELD_MAP)]
  const { data, error } = await supabase
    .from('businesses')
    .select(allColumns.join(', '))
    .eq('business_id', req.businessId)
    .single()

  if (error || !data) return res.status(500).json({ error: error?.message ?? 'business_not_found' })

  const prefs = toUiPrefs(data)
  for (const [uiKey, dbCol] of Object.entries(READONLY_FIELD_MAP)) {
    prefs[uiKey] = data[dbCol]
  }
  res.json(prefs)
})

// PUT /settings/followup — save the whole prefs object from the Save button
followupSettingsRouter.put('/settings/followup', async (req, res) => {
  const prefs = req.body ?? {}

  // Light validation — catches obviously bad input before it hits the DB
  if (prefs.zone_recent_mode && !VALID_MODES.includes(prefs.zone_recent_mode)) {
    return res.status(400).json({ error: 'invalid_zone_recent_mode' })
  }
  if (prefs.zone_medium_mode && !VALID_MODES.includes(prefs.zone_medium_mode)) {
    return res.status(400).json({ error: 'invalid_zone_medium_mode' })
  }
  if (prefs.zone_old_mode && !VALID_MODES.includes(prefs.zone_old_mode)) {
    return res.status(400).json({ error: 'invalid_zone_old_mode' })
  }
  if (prefs.quiet_start != null && (prefs.quiet_start < 0 || prefs.quiet_start > 23)) {
    return res.status(400).json({ error: 'invalid_quiet_start' })
  }
  if (prefs.quiet_end != null && (prefs.quiet_end < 0 || prefs.quiet_end > 23)) {
    return res.status(400).json({ error: 'invalid_quiet_end' })
  }
  if (prefs.active_days && (!Array.isArray(prefs.active_days) || prefs.active_days.some(d => d < 0 || d > 6))) {
    return res.status(400).json({ error: 'invalid_active_days' })
  }
  if (prefs.zone_recent_days != null && prefs.zone_medium_days != null && prefs.zone_recent_days >= prefs.zone_medium_days) {
    return res.status(400).json({ error: 'zone_recent_days_must_be_less_than_zone_medium_days' })
  }
  if (prefs.hot_lead_threshold != null && (prefs.hot_lead_threshold < 0 || prefs.hot_lead_threshold > 10)) {
    return res.status(400).json({ error: 'invalid_hot_lead_threshold' })
  }
  if (prefs.nudge_min_pending != null && prefs.nudge_min_pending < 0) {
    return res.status(400).json({ error: 'invalid_nudge_min_pending' })
  }

  const row = toDbRow(prefs)
  const { data, error } = await supabase
    .from('businesses')
    .update(row)
    .eq('business_id', req.businessId)
    .select(Object.values(FIELD_MAP).join(', '))
    .single()

  if (error) return res.status(500).json({ error: error.message })

  console.log(`[Settings] Follow-up prefs saved for business ${req.businessId}`)
  res.json(toUiPrefs(data))
})