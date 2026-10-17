import { describeAudience, DEFAULT_AUDIENCE } from '../chatAi/audience.js';

// Recommended settings for the two switches, and the same settings in plain words for the "See the settings" panel.
// Pure: no database. The keys match the follow-up settings the app already saves (followupSettingsRoutes.js).

export const RECOMMENDED = {
    followups: {
        max_per_lead: 13,           // the follow-up AI writes up to 13 steps per ad; the old default of 12 would cut the last one
        daily_cap: 40,
        zone_recent_mode: 'approval', zone_medium_mode: 'approval', zone_old_mode: 'approval', // first sends always wait for the owner
        ai_scheduling: 'draft',     // the AI suggests the send time, the owner approves
        min_gap_hours: 20,
        silence_hours: 12,
        approval_default: 'granular',
        quiet_start: 21, quiet_end: 8,
        active_days: [1, 2, 3, 4, 5, 6],
    },
    chat: { daily_cap: 30, audience: DEFAULT_AUDIENCE },
};

export const FOLLOWUP_COLUMNS = {
    max_per_lead: 'followup_max_per_lead', daily_cap: 'followup_daily_cap', quiet_start: 'followup_quiet_start',
    quiet_end: 'followup_quiet_end', active_days: 'followup_active_days', zone_recent_mode: 'followup_zone_recent_mode',
    zone_medium_mode: 'followup_zone_medium_mode', zone_old_mode: 'followup_zone_old_mode', ai_scheduling: 'followup_ai_scheduling',
    min_gap_hours: 'followup_min_gap_hours', silence_hours: 'followup_silence_hours', approval_default: 'followup_approval_default',
};

const MODES = ['approval', 'manual', 'auto'];
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

// Returns an error name or null. Same limits the settings route enforces.
export function validateFollowupPrefs(p) {
    if (p.max_per_lead !== undefined && !int(p.max_per_lead, 1, 50)) return 'invalid_max_per_lead';
    if (p.daily_cap !== undefined && !int(p.daily_cap, 0, 1000)) return 'invalid_daily_cap';
    for (const k of ['quiet_start', 'quiet_end']) if (p[k] !== undefined && !int(p[k], 0, 23)) return `invalid_${k}`;
    if (p.active_days !== undefined && !(Array.isArray(p.active_days) && p.active_days.length > 0 && p.active_days.every((d) => int(d, 0, 6)))) return 'invalid_active_days';
    for (const k of ['zone_recent_mode', 'zone_medium_mode', 'zone_old_mode']) if (p[k] !== undefined && !MODES.includes(p[k])) return `invalid_${k}`;
    if (p.ai_scheduling !== undefined && !['off', 'draft', 'auto'].includes(p.ai_scheduling)) return 'invalid_ai_scheduling';
    if (p.approval_default !== undefined && !['granular', 'all'].includes(p.approval_default)) return 'invalid_approval_default';
    if (p.min_gap_hours !== undefined && !int(p.min_gap_hours, 1, 168)) return 'invalid_min_gap_hours';
    if (p.silence_hours !== undefined && !int(p.silence_hours, 2, 168)) return 'invalid_silence_hours';
    return null;
}

// "08:00"-"18:30" -> quiet from 19 until 8. Messages never go out outside opening hours.
export function hoursToQuiet(hours) {
    if (!hours?.open || !hours?.close) return {};
    const open = Number(hours.open.slice(0, 2));
    const [ch, cm] = [Number(hours.close.slice(0, 2)), Number(hours.close.slice(3, 5))];
    return { quiet_start: Math.min(23, cm > 0 ? ch + 1 : ch), quiet_end: open, ...(hours.days?.length ? { active_days: hours.days } : {}) };
}

export function followupPrefsFor(answers = {}, overrides = {}) {
    return { ...RECOMMENDED.followups, ...hoursToQuiet(answers.hours), ...overrides };
}

export function toColumns(prefs) {
    const row = {};
    for (const [key, column] of Object.entries(FOLLOWUP_COLUMNS)) if (prefs[key] !== undefined) row[column] = prefs[key];
    return row;
}

// ---- plain words -----------------------------------------------------------------------------------------------
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function clock(h) { const hour = ((h + 11) % 12) + 1; return `${hour} ${h < 12 ? 'am' : 'pm'}`; }
export function daysText(days) {
    const d = [...days].sort((a, b) => a - b);
    const consecutive = d.every((v, i) => i === 0 || v === d[i - 1] + 1);
    return d.length > 2 && consecutive ? `${DAY[d[0]]} to ${DAY[d[d.length - 1]]}` : d.map((x) => DAY[x]).join(', ');
}

// Each line: { key, label, value, plain, edit } so the screen can show it and let the owner change it.
export function describeFollowups(p) {
    const askFirst = [p.zone_recent_mode, p.zone_medium_mode, p.zone_old_mode].every((m) => m === 'approval');
    return [
        { key: 'approval', label: 'Who approves messages', value: askFirst ? 'Ask me first' : 'Mixed',
          plain: askFirst ? 'Every message waits for your OK before it is sent.' : 'Some messages are sent without asking you.', edit: { type: 'choice', fields: ['zone_recent_mode', 'zone_medium_mode', 'zone_old_mode'], options: MODES } },
        { key: 'quiet', label: 'Quiet hours', value: `${clock(p.quiet_start)} to ${clock(p.quiet_end)}`, plain: `No messages go out between ${clock(p.quiet_start)} and ${clock(p.quiet_end)}.`, edit: { type: 'hours', fields: ['quiet_start', 'quiet_end'] } },
        { key: 'days', label: 'Days', value: daysText(p.active_days), plain: `Messages only go out ${daysText(p.active_days)}.`, edit: { type: 'days', fields: ['active_days'] } },
        { key: 'gap', label: 'Time between messages', value: `${p.min_gap_hours} hours`, plain: `A person never gets two messages less than ${p.min_gap_hours} hours apart.`, edit: { type: 'number', field: 'min_gap_hours', current: p.min_gap_hours, min: 1, max: 168 } },
        { key: 'silence', label: 'Before the first follow-up', value: `${p.silence_hours} hours quiet`, plain: `HeySasa waits until a chat has been quiet for ${p.silence_hours} hours before the first follow-up.`, edit: { type: 'number', field: 'silence_hours', current: p.silence_hours, min: 2, max: 168 } },
        { key: 'daily', label: 'Messages per day', value: String(p.daily_cap), plain: `Up to ${p.daily_cap} follow-ups a day, so nobody is flooded.`, edit: { type: 'number', field: 'daily_cap', current: p.daily_cap, min: 0, max: 1000 } },
        { key: 'per_person', label: 'Messages per person', value: String(p.max_per_lead), plain: `Up to ${p.max_per_lead} follow-ups for one person, then HeySasa stops.`, edit: { type: 'number', field: 'max_per_lead', current: p.max_per_lead, min: 1, max: 50 } },
        { key: 'timing', label: 'Send times', value: p.ai_scheduling === 'draft' ? 'Suggested, you approve' : p.ai_scheduling === 'auto' ? 'Chosen by HeySasa' : 'Fixed', plain: p.ai_scheduling === 'draft' ? 'HeySasa picks the best time for each person and shows it to you first.' : p.ai_scheduling === 'auto' ? 'HeySasa picks the best time for each person.' : 'Messages go out at the normal time.', edit: { type: 'choice', fields: ['ai_scheduling'], options: ['off', 'draft', 'auto'] } },
    ];
}

export function describeChat(cap, audience = ['all']) {
    return [
        { key: 'chat_cap', label: 'Chats per day', value: String(cap), plain: `HeySasa can start and answer up to ${cap} customer chats a day.`, edit: { type: 'number', field: 'daily_cap', current: cap, min: 1, max: 1000 } },
        { key: 'chat_audience', label: 'Who HeySasa answers', value: describeAudience(audience), plain: `HeySasa answers ${describeAudience(audience)}. Everyone else you answer yourself.`, edit: null },
        { key: 'chat_pause', label: 'When you join a chat', value: 'HeySasa steps back', plain: 'If you reply to a customer yourself, HeySasa pauses in that chat so you do not talk over each other.', edit: null },
    ];
}

// The saved columns back into the same keys, falling back to the recommended value where a column is empty.
export function prefsFromColumns(row = {}) {
    const prefs = { ...RECOMMENDED.followups };
    for (const [key, column] of Object.entries(FOLLOWUP_COLUMNS)) if (row[column] !== null && row[column] !== undefined) prefs[key] = row[column];
    return prefs;
}
