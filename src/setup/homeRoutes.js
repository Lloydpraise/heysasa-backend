// Routes behind the Home screen (daily mode) and the two switches in setup mode:
//   GET  /setup/defaults                       the recommended settings in plain words, for "See the settings"
//   POST /setup/switches                       turn follow-ups and/or auto chat on or off (with defaults or changes)
//   GET  /home/approvals                       everything waiting for the owner, grouped into a few cards
//   POST /home/approvals/messages/approve      one click for a whole group of messages { campaignId: "<id>" | "other" }
//   GET  /home/summary                         small numbers for "while you were away"
import express from 'express';
import { supabase } from '../config/supabase.js';
import { normalizeOutboundMedia } from '../../followup-engine/src/lib/media.js';
import { resolveBusinessId } from './auth.js';
import { buildSetupDeps } from './setupDeps.js';
import { groupApprovals } from './homeApprovals.js';
import { cleanAudience } from '../chatAi/audience.js';
import { applySwitches, hasBalance, loadBalance } from './switches.js';
import { RECOMMENDED, followupPrefsFor, prefsFromColumns, describeFollowups, describeChat, FOLLOWUP_COLUMNS } from './defaults.js';

const router = express.Router();
const { store } = buildSetupDeps();
const head = { count: 'exact', head: true };
const cnt = async (query) => { const { count, error } = await query; return error ? 0 : (count || 0); };

router.get('/setup/defaults', async (req, res, next) => {
    try {
        const businessId = await resolveBusinessId(req, res);
        if (!businessId) return;
        const columns = ['business_type', 'followup_ai_enabled', 'chat_ai_enabled', 'chat_ai_daily_cap', 'chat_ai_settings', 'persona_pack_status', 'subscription_active', ...Object.values(FOLLOWUP_COLUMNS)].join(', ');
        const { data: business } = await supabase.from('businesses').select(columns).eq('business_id', businessId).maybeSingle();
        if (!business) return res.status(404).json({ ok: false, error: 'business_not_found' });
        const setup = await store.get(businessId);

        const followupsOn = business.followup_ai_enabled === true;
        const prefs = followupsOn ? prefsFromColumns(business) : followupPrefsFor(setup?.answers || {});
        const chatCap = business.chat_ai_enabled && business.chat_ai_daily_cap > 0 ? business.chat_ai_daily_cap : RECOMMENDED.chat.daily_cap;
        const savedAudience = cleanAudience(business.chat_ai_settings?.audience);
        const chatAudience = savedAudience || (business.chat_ai_enabled === true ? ['all'] : RECOMMENDED.chat.audience);
        return res.json({
            ok: true,
            subscription_active: business.subscription_active !== false,
            wallet: { has_balance: hasBalance(business, await loadBalance(supabase, businessId)) },
            followups: { on: followupsOn, prefs, lines: describeFollowups(prefs) },
            chat: { on: business.chat_ai_enabled === true, daily_cap: chatCap, audience: chatAudience, lines: describeChat(chatCap, chatAudience), persona_ready: business.persona_pack_status === 'ready' },
        });
    } catch (error) { return next(error); }
});

router.post('/setup/switches', async (req, res, next) => {
    try {
        const businessId = await resolveBusinessId(req, res);
        if (!businessId) return;
        const { followups, chat, overrides } = req.body || {};
        const result = await applySwitches({ supabase, store, businessId, request: { followups, chat, overrides } });
        if (result.error) return res.status(result.status || 400).json({ ok: false, error: result.error });
        return res.json(result);
    } catch (error) { return next(error); }
});

async function loadApprovals(businessId) {
    const [{ data: messages }, { data: playbooks }] = await Promise.all([
        supabase.from('follow_up_queue').select('id, campaign_id, draft_message, qc_passed, scheduled_at')
            .eq('business_id', businessId).eq('approval_status', 'awaiting_approval').order('scheduled_at', { ascending: true }).limit(2000),
        supabase.from('ad_playbooks').select('id, ad_id, auto_headline, override_headline').eq('business_id', businessId).eq('status', 'review'),
    ]);
    const campaignIds = [...new Set((messages || []).map((m) => m.campaign_id).filter(Boolean))];
    const { data: campaigns } = campaignIds.length ? await supabase.from('campaigns').select('id, name').in('id', campaignIds) : { data: [] };
    return groupApprovals({ messages: messages || [], campaigns: campaigns || [], playbooks: playbooks || [] });
}

router.get('/home/approvals', async (req, res, next) => {
    try {
        const businessId = await resolveBusinessId(req, res);
        if (!businessId) return;
        return res.json({ ok: true, ...(await loadApprovals(businessId)) });
    } catch (error) { return next(error); }
});

// Approves the same way the single-message route does (ready_to_send + channel + final text), for one whole group.
// Messages that failed the quality check are left for the owner to open.
router.post('/home/approvals/messages/approve', async (req, res, next) => {
    try {
        const businessId = await resolveBusinessId(req, res);
        if (!businessId) return;
        const campaignId = req.body?.campaignId;
        if (typeof campaignId !== 'string' || !campaignId.trim()) return res.status(400).json({ ok: false, error: 'campaign_required' });

        const { data: business } = await supabase.from('businesses').select('whatsapp_channel').eq('business_id', businessId).maybeSingle();
        let query = supabase.from('follow_up_queue').select('id, draft_message, media, qc_passed')
            .eq('business_id', businessId).eq('approval_status', 'awaiting_approval').limit(2000);
        query = campaignId === 'other' ? query.is('campaign_id', null) : query.eq('campaign_id', campaignId);
        const { data: rows, error } = await query;
        if (error) return res.status(500).json({ ok: false, error: 'could_not_load' });

        let approved = 0, skipped = 0;
        const todo = [];
        for (const row of rows || []) {
            let media = null;
            try { media = normalizeOutboundMedia(row.media); } catch { skipped += 1; continue; }
            const text = String(row.draft_message || '').trim();
            if (row.qc_passed === false || (!text && !media)) { skipped += 1; continue; }
            todo.push({ id: row.id, text, media });
        }
        for (let i = 0; i < todo.length; i += 25) {
            const results = await Promise.all(todo.slice(i, i + 25).map((item) => supabase.from('follow_up_queue').update({
                status: 'ready_to_send', channel: business?.whatsapp_channel ?? null, final_message: item.text, draft_message: item.text,
                media: item.media, approval_status: 'approved',
            }).eq('id', item.id).eq('business_id', businessId).eq('approval_status', 'awaiting_approval')));
            approved += results.filter((r) => !r.error).length;
            skipped += results.filter((r) => r.error).length;
        }
        return res.json({ ok: true, approved, skipped });
    } catch (error) { return next(error); }
});

router.get('/home/summary', async (req, res, next) => {
    try {
        const businessId = await resolveBusinessId(req, res);
        if (!businessId) return;
        const since = new Date(Date.now() - 24 * 3600_000).toISOString();
        const [sent24h, hot, messages, playbooks] = await Promise.all([
            cnt(supabase.from('follow_up_queue').select('id', head).eq('business_id', businessId).eq('status', 'sent').gte('processed_at', since)),
            cnt(supabase.from('contacts').select('id', head).eq('business_id', businessId).eq('lead_type', 'business').gte('intent_score', 70).not('lead_state', 'in', '(won,lost)')),
            cnt(supabase.from('follow_up_queue').select('id', head).eq('business_id', businessId).eq('approval_status', 'awaiting_approval')),
            cnt(supabase.from('ad_playbooks').select('id', head).eq('business_id', businessId).eq('status', 'review')),
        ]);
        return res.json({ ok: true, sent_24h: sent24h, ready_to_buy: hot, waiting_messages: messages, waiting_plans: playbooks });
    } catch (error) { return next(error); }
});

export default router;
