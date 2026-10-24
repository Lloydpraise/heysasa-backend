import express from 'express';
import { supabase } from './config/supabase.js';
import { logEvent } from './services/debugConsole.js';
import { requireScope } from './middleware/accessScope.js';
import { loadAccountSettings } from './services/accounts.js';
import { saveAccountSettings } from './services/accountSettings.js';

// Follow-up preferences (Preferences page in the dashboard).
//
// These routes used to live ONLY in followup-engine's own Express app on an
// internal port (3001), which the browser can't reach in production. They are
// served here, on the main API, so the dashboard only needs VITE_BACKEND_API_URL.
// followup-engine/src/api/followupSettingsRoutes.js still exists and is
// unchanged — keep FIELD_MAP below in sync with it if columns are added.
//
// Auth is the shared scope (src/middleware/accessScope.js): owner, admin or a team member, X-Business-Id and
// the selected WhatsApp account (X-Account-Id). These are per-number settings (ACCOUNTS.md rule 7): an account
// reads the business default with its own accounts.settings overrides laid over it, and Save from an account of
// a business with several numbers writes that account's overrides (src/services/accountSettings.js).
const router = express.Router();

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
  ai_scheduling: 'followup_ai_scheduling',
  min_gap_hours: 'followup_min_gap_hours',
  silence_hours: 'followup_silence_hours',
  approval_default: 'followup_approval_default',
};

// Shown in Preferences but never written by Save.
const READONLY_FIELD_MAP = {
    lifetime_sent: 'followup_total_sent',
};

const VALID_MODES = ['approval', 'manual', 'auto'];

function toDbRow(prefs) {
    const row = {};
    for (const [uiKey, dbCol] of Object.entries(FIELD_MAP)) {
        if (prefs[uiKey] !== undefined) row[dbCol] = prefs[uiKey];
    }
    return row;
}

function toUiPrefs(row) {
    const prefs = {};
    for (const [uiKey, dbCol] of Object.entries(FIELD_MAP)) prefs[uiKey] = row[dbCol];
    return prefs;
}

router.get('/settings/followup', requireScope, async (req, res) => {
    let data;
    try {
        data = await loadAccountSettings(supabase, req.accountId, req.businessId);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
    if (!data) return res.status(500).json({ error: 'business_not_found' });

    const prefs = toUiPrefs(data);
    for (const [uiKey, dbCol] of Object.entries(READONLY_FIELD_MAP)) prefs[uiKey] = data[dbCol];
    res.json(prefs);
});

router.put('/settings/followup', requireScope, async (req, res) => {
    const prefs = req.body ?? {};

    if (prefs.zone_recent_mode && !VALID_MODES.includes(prefs.zone_recent_mode)) return res.status(400).json({ error: 'invalid_zone_recent_mode' });
    if (prefs.zone_medium_mode && !VALID_MODES.includes(prefs.zone_medium_mode)) return res.status(400).json({ error: 'invalid_zone_medium_mode' });
    if (prefs.zone_old_mode && !VALID_MODES.includes(prefs.zone_old_mode)) return res.status(400).json({ error: 'invalid_zone_old_mode' });
    if (prefs.quiet_start != null && (prefs.quiet_start < 0 || prefs.quiet_start > 23)) return res.status(400).json({ error: 'invalid_quiet_start' });
    if (prefs.quiet_end != null && (prefs.quiet_end < 0 || prefs.quiet_end > 23)) return res.status(400).json({ error: 'invalid_quiet_end' });
    if (prefs.active_days && (!Array.isArray(prefs.active_days) || prefs.active_days.some((d) => d < 0 || d > 6))) return res.status(400).json({ error: 'invalid_active_days' });
    if (prefs.zone_recent_days != null && prefs.zone_medium_days != null && prefs.zone_recent_days >= prefs.zone_medium_days) {
        return res.status(400).json({ error: 'zone_recent_days_must_be_less_than_zone_medium_days' });
    }
    if (prefs.hot_lead_threshold != null && (prefs.hot_lead_threshold < 0 || prefs.hot_lead_threshold > 10)) return res.status(400).json({ error: 'invalid_hot_lead_threshold' });
    if (prefs.nudge_min_pending != null && prefs.nudge_min_pending < 0) return res.status(400).json({ error: 'invalid_nudge_min_pending' });

    if (prefs.ai_scheduling != null && !['off', 'draft', 'auto'].includes(prefs.ai_scheduling)) {
    return res.status(400).json({ error: 'invalid_ai_scheduling' })
  }
  if (prefs.approval_default != null && !['granular', 'all'].includes(prefs.approval_default)) {
    return res.status(400).json({ error: 'invalid_approval_default' })
  }
  if (prefs.min_gap_hours != null && !(Number.isInteger(prefs.min_gap_hours) && prefs.min_gap_hours >= 1 && prefs.min_gap_hours <= 168)) {
    return res.status(400).json({ error: 'invalid_min_gap_hours' })
  }
  if (prefs.silence_hours != null && !(Number.isInteger(prefs.silence_hours) && prefs.silence_hours >= 2 && prefs.silence_hours <= 168)) {
    return res.status(400).json({ error: 'invalid_silence_hours' })
  }

    // A team member with several accounts and none selected cannot save "for every account".
    if (!req.accountId && !req.scope?.isAdmin) return res.status(400).json({ error: 'account_required' });

    const row = toDbRow(prefs);
    let data;
    let target;
    try {
        ({ target } = await saveAccountSettings(supabase, req.scope, row));
        data = await loadAccountSettings(supabase, req.accountId, req.businessId);
    } catch (error) {
        return res.status(error.status || 500).json({ error: error.message });
    }

    logEvent({ level: 'info', area: 'api', event: 'settings.saved', message: `Follow-up prefs saved for ${target === 'account' ? `account ${req.accountId}` : `business ${req.businessId}`}`, business_id: req.businessId, entity_id: req.accountId ?? null });
    res.json(toUiPrefs(data || {}));
});

export default router;
