import express from 'express';
import { supabase } from './config/supabase.js';
import { logEvent } from './services/debugConsole.js';

// Follow-up preferences (Preferences page in the dashboard).
//
// These routes used to live ONLY in followup-engine's own Express app on an
// internal port (3001), which the browser can't reach in production. They are
// served here, on the main API, so the dashboard only needs VITE_BACKEND_API_URL.
// followup-engine/src/api/followupSettingsRoutes.js still exists and is
// unchanged — keep FIELD_MAP below in sync with it if columns are added.
//
// Auth mirrors followup-engine/src/api/authMiddleware.js: Supabase JWT in the
// Authorization header + X-Business-Id, verified against businesses.user_id.
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

async function requireBusinessAuth(req, res, next) {
    try {
        const authHeader = req.headers.authorization || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
        if (!token) return res.status(401).json({ error: 'missing_auth_token' });

        const requestedBusinessId = typeof req.headers['x-business-id'] === 'string' ? req.headers['x-business-id'].trim() : '';
        if (!requestedBusinessId) return res.status(400).json({ error: 'missing_business_id_header' });

        const { data: userData, error: userErr } = await supabase.auth.getUser(token);
        if (userErr || !userData?.user) return res.status(401).json({ error: 'invalid_auth_token' });

        const { data: business, error: bizErr } = await supabase
            .from('businesses')
            .select('business_id')
            .eq('business_id', requestedBusinessId)
            .eq('user_id', userData.user.id)
            .maybeSingle();
        if (bizErr) return res.status(500).json({ error: bizErr.message });
        if (!business) return res.status(403).json({ error: 'no_business_for_user' });

        req.businessId = business.business_id;
        req.userId = userData.user.id;
        next();
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

router.get('/settings/followup', requireBusinessAuth, async (req, res) => {
    const allColumns = [...Object.values(FIELD_MAP), ...Object.values(READONLY_FIELD_MAP)];
    const { data, error } = await supabase
        .from('businesses')
        .select(allColumns.join(', '))
        .eq('business_id', req.businessId)
        .single();

    if (error || !data) return res.status(500).json({ error: error?.message ?? 'business_not_found' });

    const prefs = toUiPrefs(data);
    for (const [uiKey, dbCol] of Object.entries(READONLY_FIELD_MAP)) prefs[uiKey] = data[dbCol];
    res.json(prefs);
});

router.put('/settings/followup', requireBusinessAuth, async (req, res) => {
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

    const row = toDbRow(prefs);
    const { data, error } = await supabase
        .from('businesses')
        .update(row)
        .eq('business_id', req.businessId)
        .select(Object.values(FIELD_MAP).join(', '))
        .single();

    if (error) return res.status(500).json({ error: error.message });

    logEvent({ level: 'info', area: 'api', event: 'settings.saved', message: `Follow-up prefs saved for business ${req.businessId}`, business_id: req.businessId });
    res.json(toUiPrefs(data));
});

export default router;
