// /admin API — used by public/admin.html. Everything here runs with the service role
// (bypasses RLS), so it is gated by requireDebugToken. NOTE: swap that gate for a real
// login (Supabase Auth + allowlist) before opening this to anyone but you.
import { Router } from 'express';
import { supabase } from './config/supabase.js';
import { requireDebugToken } from './middleware/debugAuth.js';
import { logEvent } from './services/debugConsole.js';
import { AI_PROMPT_CATALOG } from './aiPromptCatalog.js';

const MAX_STEPS = 8;

function cleanSteps(input) {
    if (!Array.isArray(input) || input.length < 1 || input.length > MAX_STEPS) {
        throw httpError(400, `steps must be 1-${MAX_STEPS} messages`);
    }
    return input.map((s, i) => {
        const content = String(s?.content ?? '').trim();
        if (!content) throw httpError(400, `message ${i + 1} is empty`);
        if (content.length > 1200) throw httpError(400, `message ${i + 1} is too long (max 1200 chars)`);
        const delay = i === 0 ? 0 : Math.max(0, Math.min(720, Math.round(Number(s?.delay_hours ?? 24)) || 0));
        return { step_number: i + 1, content, delay_hours: delay };
    });
}

function httpError(status, message) {
    return Object.assign(new Error(message), { status });
}

const norm = (v) => {
    const t = String(v ?? '').trim();
    return t ? t : null;
};
const sameScope = (row, industry, businessType) =>
    (row.industry ?? '').toLowerCase() === (industry ?? '').toLowerCase() &&
    (row.business_type ?? '') === (businessType ?? '');

export function createAdminRouter({ getFollowupPort, isFollowupRunning }) {
    const router = Router();
    router.use('/admin/api', requireDebugToken);

    const wrap = (fn) => async (req, res) => {
        try {
            const data = await fn(req);
            res.json({ ok: true, ...(data ?? {}) });
        } catch (e) {
            const status = e.status || 500;
            if (status >= 500) {
                logEvent({ level: 'error', area: 'admin', event: 'admin.api_error', message: `${req.method} ${req.path}: ${e.message}` });
            }
            res.status(status).json({ ok: false, error: e.message });
        }
    };
    const must = ({ data, error }) => {
        if (error) throw httpError(500, error.message);
        return data;
    };

    async function engineCall(path, { method = 'GET', body } = {}) {
        if (!isFollowupRunning()) throw httpError(503, 'followup engine is not running');
        const response = await fetch(`http://127.0.0.1:${getFollowupPort()}${path}`, {
            method,
            headers: { 'Content-Type': 'application/json', 'x-debug-token': process.env.DEBUG_TOKEN },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(90_000),
        });
        const json = await response.json().catch(() => null);
        if (!response.ok) throw httpError(response.status === 401 ? 502 : response.status, json?.error || `engine_${response.status}`);
        return json;
    }

    // ── Reference data ───────────────────────────────────────────────────
    router.get('/admin/api/meta', wrap(async () => {
        const [biz, rules] = await Promise.all([
            supabase.from('businesses').select('business_id, name, industry, business_type').order('name'),
            supabase.from('auto_campaign_defaults').select('rule_id'),
        ]);
        const businesses = must(biz);
        return {
            businesses,
            industries: [...new Set(businesses.map((b) => (b.industry || '').trim()).filter(Boolean))].sort(),
            businessTypes: [...new Set(businesses.map((b) => b.business_type).filter(Boolean))].sort(),
            ruleIds: [...new Set(must(rules).map((r) => r.rule_id))].sort(),
        };
    }));

    // ── Campaign defaults (versioned) ────────────────────────────────────
    router.get('/admin/api/defaults', wrap(async () => {
        const rows = must(await supabase.from('auto_campaign_defaults').select('*').eq('is_active', true));
        rows.sort((a, b) => a.rule_id.localeCompare(b.rule_id) || (a.industry ? 1 : 0) - (b.industry ? 1 : 0) || (a.industry ?? '').localeCompare(b.industry ?? ''));
        return { defaults: rows };
    }));

    router.get('/admin/api/defaults/history', wrap(async (req) => {
        const { rule_id: ruleId } = req.query;
        if (!ruleId) throw httpError(400, 'rule_id required');
        const industry = norm(req.query.industry);
        const businessType = norm(req.query.business_type);
        const rows = must(await supabase.from('auto_campaign_defaults').select('*').eq('rule_id', ruleId));
        return { history: rows.filter((r) => sameScope(r, industry, businessType)).sort((a, b) => b.version - a.version) };
    }));

    // Effective default for a business (what its owner would see on first open)
    router.get('/admin/api/defaults/effective', wrap(async (req) => {
        const { business_id: businessId, rule_id: ruleId } = req.query;
        if (!businessId || !ruleId) throw httpError(400, 'business_id and rule_id required');
        const data = must(await supabase.rpc('resolve_auto_campaign_default', { p_business_id: businessId, p_rule_id: ruleId }));
        const row = Array.isArray(data) ? data[0] : data;
        return { effective: row ?? null };
    }));

    // Saving never edits in place: the current active row for that scope is retired and a
    // new version is inserted, so any earlier version can be restored.
    async function publishVersion({ ruleId, industry, businessType, campaignName, objective, playbook, sequenceMode, steps }) {
        const known = must(await supabase.from('auto_campaign_defaults').select('*').eq('rule_id', ruleId));
        if (!known.length) throw httpError(400, `unknown rule_id "${ruleId}"`);
        if (!String(campaignName ?? '').trim() || !String(objective ?? '').trim() || !String(playbook ?? '').trim()) {
            throw httpError(400, 'name, objective and playbook are required');
        }
        if (!['linear', 'conditional'].includes(sequenceMode ?? 'linear')) throw httpError(400, 'bad sequence_mode');
        const cleaned = cleanSteps(steps);

        const scoped = known.filter((r) => sameScope(r, industry, businessType));
        const active = scoped.find((r) => r.is_active);
        const nextVersion = Math.max(0, ...scoped.map((r) => r.version)) + 1;

        if (active) must(await supabase.from('auto_campaign_defaults').update({ is_active: false, updated_at: new Date().toISOString() }).eq('id', active.id));
        const { data, error } = await supabase.from('auto_campaign_defaults').insert({
            rule_id: ruleId, industry, business_type: businessType,
            campaign_name: String(campaignName).trim(), objective: String(objective).trim(), playbook: String(playbook).trim(),
            sequence_mode: sequenceMode ?? 'linear', steps: cleaned, version: nextVersion, is_active: true,
        }).select().single();
        if (error) {
            if (active) await supabase.from('auto_campaign_defaults').update({ is_active: true }).eq('id', active.id); // roll back
            throw httpError(500, error.message);
        }
        logEvent({ level: 'info', area: 'admin', event: 'admin.default_saved', message: `Default ${ruleId} (${industry ?? 'global'}/${businessType ?? 'any'}) -> v${nextVersion}` });
        return data;
    }

    router.put('/admin/api/defaults', wrap(async (req) => {
        const b = req.body ?? {};
        const row = await publishVersion({
            ruleId: b.rule_id, industry: norm(b.industry), businessType: norm(b.business_type),
            campaignName: b.campaign_name, objective: b.objective, playbook: b.playbook,
            sequenceMode: b.sequence_mode, steps: b.steps,
        });
        return { default: row };
    }));

    router.post('/admin/api/defaults/:id/restore', wrap(async (req) => {
        const old = must(await supabase.from('auto_campaign_defaults').select('*').eq('id', req.params.id).single());
        const row = await publishVersion({
            ruleId: old.rule_id, industry: old.industry, businessType: old.business_type,
            campaignName: old.campaign_name, objective: old.objective, playbook: old.playbook,
            sequenceMode: old.sequence_mode, steps: old.steps,
        });
        return { default: row };
    }));

    // Turn off an industry / business-type override (falls back to the next most specific
    // default). The global default can't be switched off — every business needs one.
    router.delete('/admin/api/defaults/:id', wrap(async (req) => {
        const row = must(await supabase.from('auto_campaign_defaults').select('*').eq('id', req.params.id).single());
        if (!row.industry && !row.business_type) throw httpError(400, 'the global default cannot be deactivated');
        must(await supabase.from('auto_campaign_defaults').update({ is_active: false, updated_at: new Date().toISOString() }).eq('id', row.id));
        return {};
    }));

    // ── AI prompts (ai_bots_config overrides) ────────────────────────────
    router.get('/admin/api/bots', wrap(async () => {
        const rows = must(await supabase.from('ai_bots_config').select('bot_id, bot_name, prompt, model, temperature, max_tokens, is_active, updated_at').order('bot_id'));
        let fallbacks = {};
        let catalog = { ...AI_PROMPT_CATALOG };
        let defaultModel = 'gpt-4.1-mini';
        try {
            const e = await engineCall('/admin/engine/bot-fallbacks');
            fallbacks = e.fallbacks ?? {};
            catalog = { ...(e.catalog ?? {}), ...catalog };
            defaultModel = e.defaultModel ?? defaultModel;
        } catch { /* engine down: editor still works, just without built-in text */ }
        return { bots: rows, fallbacks, catalog, defaultModel };
    }));

    router.put('/admin/api/bots/:botId', wrap(async (req) => {
        const botId = req.params.botId;
        if (!/^[a-z0-9_]{3,60}$/.test(botId)) throw httpError(400, 'bad bot id');
        const b = req.body ?? {};
        const prompt = String(b.prompt ?? '').trim();
        if (prompt.length < 20) throw httpError(400, 'prompt is too short');
        const temperature = b.temperature === '' || b.temperature == null ? null : Number(b.temperature);
        if (temperature != null && !(temperature >= 0 && temperature <= 2)) throw httpError(400, 'temperature must be 0-2');
        const maxTokens = b.max_tokens === '' || b.max_tokens == null ? null : Math.round(Number(b.max_tokens));
        if (maxTokens != null && !(maxTokens >= 50 && maxTokens <= 4000)) throw httpError(400, 'max_tokens must be 50-4000');
        const model = String(b.model ?? '').trim();
        if (!model) throw httpError(400, 'model required');

        const fields = { prompt, model, temperature, max_tokens: maxTokens, is_active: b.is_active !== false, updated_at: new Date().toISOString() };
        const existing = must(await supabase.from('ai_bots_config').select('id').eq('bot_id', botId).maybeSingle());
        if (existing) {
            must(await supabase.from('ai_bots_config').update(fields).eq('id', existing.id));
        } else {
            // NOT NULL columns without defaults on this table; output_format 'text' since
            // these engine prompts return plain messages (JSON bots keep their existing rows).
            must(await supabase.from('ai_bots_config').insert({
                bot_id: botId, bot_name: String(b.bot_name || AI_PROMPT_CATALOG[botId]?.bot_name || botId), system_number: 900, phase: 0,
                role_summary: 'Admin override', output_format: 'text', ...fields,
            }));
        }
        logEvent({ level: 'info', area: 'admin', event: 'admin.bot_saved', message: `Bot ${botId} saved (${fields.is_active ? 'active' : 'inactive'})` });
        return { note: 'The engine caches bot prompts for up to 60 seconds.' };
    }));

    // ── Leads + preview ──────────────────────────────────────────────────
    router.get('/admin/api/leads', wrap(async (req) => {
        const { business_id: businessId } = req.query;
        if (!businessId) throw httpError(400, 'business_id required');
        const q = String(req.query.q ?? '').trim().replace(/[%,()]/g, ' ');
        let query = supabase.from('contacts')
            .select('id, name, phone, intent_score, lead_quality, product_interests')
            .eq('business_id', businessId).order('intent_score', { ascending: false, nullsFirst: false }).limit(15);
        if (q) query = query.or(`name.ilike.%${q}%,phone.ilike.%${q}%`);
        return { leads: must(await query) };
    }));

    router.get('/admin/api/customer-profile/:contactId', wrap(async (req) => {
        const data = must(await supabase.from('customer_profiles').select('*').eq('contact_id', req.params.contactId).maybeSingle());
        return { profile: data };
    }));

    router.post('/admin/api/preview-rewrite', wrap(async (req) => {
        const b = req.body ?? {};
        const out = await engineCall('/admin/engine/preview-rewrite', {
            method: 'POST',
            body: { contact_id: b.contact_id, message: b.message, rule_id: b.rule_id, objective: b.objective, playbook: b.playbook },
        });
        return out;
    }));

    // ── Overview + manual runs ───────────────────────────────────────────
    router.get('/admin/api/auto-campaigns', wrap(async () => {
        const campaigns = must(await supabase.from('campaigns')
            .select('id, business_id, rule_id, status, ai_rewrite_enabled, auto_approve, whatsapp_instance_name, created_at').eq('kind', 'auto'));
        if (!campaigns.length) return { campaigns: [] };
        const ids = campaigns.map((c) => c.id);
        const [enr, biz] = await Promise.all([
            supabase.from('campaign_enrollments').select('campaign_id, status').in('campaign_id', ids),
            supabase.from('businesses').select('business_id, name').in('business_id', [...new Set(campaigns.map((c) => c.business_id))]),
        ]);
        const counts = {};
        for (const e of must(enr)) {
            counts[e.campaign_id] ??= {};
            counts[e.campaign_id][e.status] = (counts[e.campaign_id][e.status] ?? 0) + 1;
        }
        const names = Object.fromEntries(must(biz).map((x) => [x.business_id, x.name]));
        return { campaigns: campaigns.map((c) => ({ ...c, business_name: names[c.business_id] ?? c.business_id, enrollments: counts[c.id] ?? {} })) };
    }));

    // ── Waitlist ─────────────────────────────────────────────────────────
    const WAITLIST_STATUSES = ['new', 'welcomed', 'nurturing', 'conversation', 'demo_done', 'trial', 'paid', 'lost', 'opted_out'];
    // These stop the follow-up messages for that person.
    const WAITLIST_STOP_STATUSES = ['conversation', 'demo_done', 'trial', 'paid', 'lost', 'opted_out'];
    const HEYSASA_ID = process.env.HEYSASA_BUSINESS_ID || 'heysasa';

    async function waitlistCampaignIds() {
        const rows = must(await supabase.from('campaigns').select('id').eq('business_id', HEYSASA_ID).eq('rule_id', 'waitinglist').eq('kind', 'auto'));
        return rows.map((r) => r.id);
    }

    router.get('/admin/api/waitlist', wrap(async () => {
        const leads = must(await supabase.from('waitlist_leads')
            .select('id, created_at, name, business_name, industry, phone, utm_source, utm_campaign, status, notes, consent_whatsapp, contact_id')
            .order('created_at', { ascending: false }).limit(1000));
        const campaignIds = await waitlistCampaignIds();
        const contactIds = leads.map((l) => l.contact_id).filter(Boolean);
        const byContact = {};
        let totalSteps = null;
        if (campaignIds.length && contactIds.length) {
            const enrol = must(await supabase.from('campaign_enrollments')
                .select('lead_id, status, current_step').in('campaign_id', campaignIds).in('lead_id', contactIds));
            for (const e of enrol) byContact[e.lead_id] = e;
            const steps = must(await supabase.from('campaign_steps').select('step_number').in('campaign_id', campaignIds));
            totalSteps = steps.length ? Math.max(...steps.map((s) => s.step_number)) : null;
        }
        const count = (keyFn) => leads.reduce((acc, l) => { const k = keyFn(l); acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});
        const nairobiDay = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });
        return {
            totalSteps,
            summary: {
                total: leads.length,
                byStatus: count((l) => l.status),
                bySource: count((l) => l.utm_source || 'direct'),
                byDay: count((l) => nairobiDay(l.created_at)),
            },
            leads: leads.map((l) => ({
                ...l,
                step: byContact[l.contact_id]?.current_step ?? null,
                drip: byContact[l.contact_id]?.status ?? (l.contact_id ? 'not_enrolled' : 'no_contact'),
            })),
        };
    }));

    router.post('/admin/api/waitlist/:id', wrap(async (req) => {
        const patch = {};
        if (req.body?.status !== undefined) {
            if (!WAITLIST_STATUSES.includes(req.body.status)) throw httpError(400, 'invalid_status');
            patch.status = req.body.status;
        }
        if (req.body?.notes !== undefined) patch.notes = String(req.body.notes).slice(0, 2000);
        if (!Object.keys(patch).length) throw httpError(400, 'nothing_to_update');

        const lead = must(await supabase.from('waitlist_leads').update(patch).eq('id', req.params.id).select('id, contact_id, status').single());

        // Moving someone to a "we are talking now / done" status stops their follow-up messages.
        let stopped = 0;
        if (patch.status && WAITLIST_STOP_STATUSES.includes(patch.status) && lead.contact_id) {
            const campaignIds = await waitlistCampaignIds();
            if (campaignIds.length) {
                const rows = must(await supabase.from('campaign_enrollments').update({ status: 'exited' })
                    .in('campaign_id', campaignIds).eq('lead_id', lead.contact_id).in('status', ['pending', 'active']).select('id'));
                stopped = rows.length;
            }
        }
        logEvent({ level: 'info', area: 'waitlist', event: 'waitlist.updated', message: `Waitlist ${req.params.id} -> ${patch.status ?? 'notes'}`, details: { stopped } });
        return { stopped };
    }));

    router.post('/admin/api/run/sync-customer-profiles', wrap(async () => ({ result: must(await supabase.rpc('sync_customer_profiles')) })));
    router.post('/admin/api/run/sync-auto-lists', wrap(async () => {
        must(await supabase.rpc('sync_auto_lists'));
        return { result: 'sync_auto_lists finished' };
    }));

    return router;
}
