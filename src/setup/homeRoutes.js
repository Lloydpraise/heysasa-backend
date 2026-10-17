// Routes behind the Home screen (daily mode) and the two switches in setup mode:
//   GET  /setup/defaults                       the recommended settings in plain words, for "See the settings"
//   POST /setup/switches                       turn follow-ups and/or auto chat on or off (with defaults or changes)
//   GET  /home/approvals                       everything waiting for the owner, grouped into a few cards
//   POST /home/approvals/messages/approve      one click for a whole group of messages { campaignId: "<id>" | "other" }
//   GET  /home/summary                         small numbers for Home: what HeySasa did, what it is doing, what could be done next
import express from 'express';
import { supabase } from '../config/supabase.js';
import { normalizeOutboundMedia } from '../../followup-engine/src/lib/media.js';
import { resolveBusinessId } from './auth.js';
import { buildSetupDeps } from './setupDeps.js';
import { groupApprovals } from './homeApprovals.js';
import { shapeHomeSummary } from './homeSummary.js';
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
        const columns = ['business_type', 'followup_ai_enabled', 'chat_ai_enabled', 'chat_ai_daily_cap', 'persona_pack_status', 'subscription_active', ...Object.values(FOLLOWUP_COLUMNS)].join(', ');
        const { data: business } = await supabase.from('businesses').select(columns).eq('business_id', businessId).maybeSingle();
        if (!business) return res.status(404).json({ ok: false, error: 'business_not_found' });
        const setup = await store.get(businessId);

        const followupsOn = business.followup_ai_enabled === true;
        const prefs = followupsOn ? prefsFromColumns(business) : followupPrefsFor(setup?.answers || {});
        const chatCap = business.chat_ai_enabled && business.chat_ai_daily_cap > 0 ? business.chat_ai_daily_cap : RECOMMENDED.chat.daily_cap;
        return res.json({
            ok: true,
            subscription_active: business.subscription_active !== false,
            wallet: { has_balance: hasBalance(business, await loadBalance(supabase, businessId)) },
            followups: { on: followupsOn, prefs, lines: describeFollowups(prefs) },
            chat: { on: business.chat_ai_enabled === true, daily_cap: chatCap, lines: describeChat(chatCap), persona_ready: business.persona_pack_status === 'ready' },
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
        const now = Date.now();
        const since = new Date(now - 24 * 3600_000).toISOString();
        const dormantBefore = new Date(now - 14 * 24 * 3600_000).toISOString();
        const open = '(won,lost)';
        const leads = () => supabase.from('contacts').select('id', head).eq('business_id', businessId).eq('lead_type', 'business');

        const [
            sent24h, hot, messages, playbooks,
            business, balance, queued, nextSend, chatOut, newLeads, handoffs,
            adLeads, waiting, dormant, noPrice,
        ] = await Promise.all([
            cnt(supabase.from('follow_up_queue').select('id', head).eq('business_id', businessId).eq('status', 'sent').gte('processed_at', since)),
            cnt(leads().gte('intent_score', 70).not('lead_state', 'in', open)),
            cnt(supabase.from('follow_up_queue').select('id', head).eq('business_id', businessId).eq('approval_status', 'awaiting_approval')),
            cnt(supabase.from('ad_playbooks').select('id', head).eq('business_id', businessId).eq('status', 'review')),
            supabase.from('businesses').select('followup_ai_enabled, chat_ai_enabled, persona_pack_status').eq('business_id', businessId).maybeSingle(),
            supabase.from('business_balances').select('balance_kes').eq('business_id', businessId).maybeSingle(),
            cnt(supabase.from('follow_up_queue').select('id', head).eq('business_id', businessId).eq('status', 'ready_to_send')),
            supabase.from('follow_up_queue').select('scheduled_at').eq('business_id', businessId).eq('status', 'ready_to_send')
                .gte('scheduled_at', new Date(now).toISOString()).order('scheduled_at', { ascending: true }).limit(1),
            supabase.from('chat_ai_outbox').select('conversation_id').eq('business_id', businessId).eq('status', 'sent').gte('sent_at', since).limit(1000),
            cnt(leads().gte('created_at', since)),
            cnt(supabase.from('conversations').select('id', head).eq('business_id', businessId).eq('handover_flag', true).is('handover_resolved_at', null)),
            cnt(leads().eq('is_ad_lead', true).eq('do_not_contact', false).or('lifetime_followups_sent.is.null,lifetime_followups_sent.eq.0').not('lead_state', 'in', open)),
            cnt(leads().eq('awaiting_reply', true).gte('hours_awaiting_reply', 12).not('lead_state', 'in', open)),
            cnt(leads().eq('do_not_contact', false).gte('intent_score', 40).lt('last_inbound_at', dormantBefore).not('lead_state', 'in', open)),
            cnt(supabase.from('products').select('id', head).eq('business_id', businessId).is('price', null)),
        ]);

        const chatRows = chatOut?.data || [];
        return res.json({
            ok: true,
            ...shapeHomeSummary({
                sent_24h: sent24h, ready_to_buy: hot, waiting_messages: messages, waiting_plans: playbooks,
                followups_on: business?.data?.followup_ai_enabled === true,
                chat_on: business?.data?.chat_ai_enabled === true,
                persona_ready: business?.data?.persona_pack_status === 'ready',
                balance_kes: balance?.data?.balance_kes ?? null,
                queued_now: queued,
                next_send_at: nextSend?.data?.[0]?.scheduled_at || null,
                chat_replies_24h: chatRows.length,
                chat_chats_24h: new Set(chatRows.map((r) => r.conversation_id).filter(Boolean)).size,
                new_leads_24h: newLeads,
                handoffs_open: handoffs,
                ad_leads_untouched: adLeads,
                waiting_for_reply: waiting,
                dormant_leads: dormant,
                products_without_price: noPrice,
            }),
        });
    } catch (error) { return next(error); }
});

export default router;
