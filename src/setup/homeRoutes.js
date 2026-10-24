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
import { shapeHomeSummary } from './homeSummary.js';
import { RECOMMENDED, followupPrefsFor, prefsFromColumns, describeFollowups, describeChat } from './defaults.js';
import { forAccount, forAccountOrShared } from '../middleware/accessScope.js';
import { loadAccountSettings } from '../services/accounts.js';

const router = express.Router();
const { store } = buildSetupDeps();
const head = { count: 'exact', head: true };
const cnt = async (query) => { const { count, error } = await query; return error ? 0 : (count || 0); };

// Everything here is per WhatsApp account (ACCOUNTS.md): reads use forAccount(req.scope); settings are the
// account's view (business default + accounts.settings). The business-wide view sees every account's numbers.

router.get('/setup/defaults', async (req, res, next) => {
    try {
        const businessId = await resolveBusinessId(req, res);
        if (!businessId) return;
        const business = await loadAccountSettings(supabase, req.accountId, businessId);
        if (!business) return res.status(404).json({ ok: false, error: 'business_not_found' });
        const setup = await store.get(businessId, req.accountId);

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
        if (!req.accountId && !req.scope?.isAdmin) return res.status(400).json({ ok: false, error: 'account_required' });
        const { followups, chat, overrides } = req.body || {};
        const result = await applySwitches({ supabase, store, businessId, request: { followups, chat, overrides }, scope: req.scope });
        if (result.error) return res.status(result.status || 400).json({ ok: false, error: result.error });
        return res.json(result);
    } catch (error) { return next(error); }
});

async function loadApprovals(businessId, scope) {
    const [{ data: messages }, { data: playbooks }] = await Promise.all([
        forAccount(supabase.from('follow_up_queue').select('id, campaign_id, draft_message, qc_passed, scheduled_at')
            .eq('business_id', businessId).eq('approval_status', 'awaiting_approval'), scope).order('scheduled_at', { ascending: true }).limit(2000),
        forAccount(supabase.from('ad_playbooks').select('id, ad_id, auto_headline, override_headline').eq('business_id', businessId).eq('status', 'review'), scope),
    ]);
    const campaignIds = [...new Set((messages || []).map((m) => m.campaign_id).filter(Boolean))];
    const { data: campaigns } = campaignIds.length ? await supabase.from('campaigns').select('id, name').in('id', campaignIds) : { data: [] };
    return groupApprovals({ messages: messages || [], campaigns: campaigns || [], playbooks: playbooks || [] });
}

router.get('/home/approvals', async (req, res, next) => {
    try {
        const businessId = await resolveBusinessId(req, res);
        if (!businessId) return;
        return res.json({ ok: true, ...(await loadApprovals(businessId, req.scope)) });
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

        const business = await loadAccountSettings(supabase, req.accountId, businessId);
        let query = forAccount(supabase.from('follow_up_queue').select('id, draft_message, media, qc_passed')
            .eq('business_id', businessId).eq('approval_status', 'awaiting_approval'), req.scope).limit(2000);
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
        res.json({ ok: true, ...shapeHomeSummary(await countHomeSummary(supabase, businessId, Date.now(), req.scope)) });
    } catch (error) { return next(error); }
});

// The raw counts behind Home. Every count is independent and a failed one becomes 0 (see shapeHomeSummary).
// scope (optional): narrows every account-scoped count to the selected account; settings are the account's view.
export async function countHomeSummary(db, businessId, now = Date.now(), scope = null) {
    const iso = (ms) => new Date(ms).toISOString();
    const since = iso(now - 24 * 3600_000);
    const acct = (query) => forAccount(query, scope);
    const customers = () => acct(db.from('contacts').select('id', head).eq('business_id', businessId).eq('lead_type', 'business'));
    const rows = async (query) => { const { data, error } = await query; return error ? [] : (data || []); };

    const [business, balanceUsd, rate, sent24h, hot, messages, playbooks, queuedNow, nextSend, chatTurns, newLeads, handoffs,
        adUntouched, recentInbound, dormant, noPrice] = await Promise.all([
        loadAccountSettings(db, scope?.accountId ?? null, businessId).then((r) => r || {}, () => ({})),
        loadBalance(db, businessId),
        db.from('billing_prices').select('value').eq('key', 'usd_kes_rate').maybeSingle().then((r) => Number(r.data?.value) || null),
        cnt(acct(db.from('follow_up_queue').select('id', head).eq('business_id', businessId).eq('status', 'sent').gte('processed_at', since))),
        cnt(customers().gte('intent_score', 70).not('lead_state', 'in', '(won,lost)')),
        cnt(acct(db.from('follow_up_queue').select('id', head).eq('business_id', businessId).eq('approval_status', 'awaiting_approval'))),
        cnt(acct(db.from('ad_playbooks').select('id', head).eq('business_id', businessId).eq('status', 'review'))),
        cnt(acct(db.from('follow_up_queue').select('id', head).eq('business_id', businessId).eq('status', 'ready_to_send'))),
        rows(acct(db.from('follow_up_queue').select('scheduled_at').eq('business_id', businessId).eq('status', 'ready_to_send').gte('scheduled_at', iso(now))).order('scheduled_at', { ascending: true }).limit(1)),
        rows(acct(db.from('chat_ai_turns').select('conversation_id').eq('business_id', businessId).eq('mode', 'live').in('status', ['replied', 'handoff']).gte('created_at', since)).limit(2000)),
        cnt(customers().gte('created_at', since)),
        cnt(acct(db.from('conversations').select('id', head).eq('business_id', businessId).eq('handover_flag', true).is('handover_resolved_at', null))),
        cnt(customers().eq('is_ad_lead', true).is('last_outbound_at', null).not('lead_state', 'in', '(won,lost)')),
        rows(acct(db.from('contacts').select('last_inbound_at, last_outbound_at').eq('business_id', businessId).eq('lead_type', 'business')
            .lt('last_inbound_at', iso(now - 12 * 3600_000)).gte('last_inbound_at', iso(now - 14 * 86400_000))).limit(2000)),
        cnt(customers().gte('intent_score', 40).lt('last_inbound_at', iso(now - 14 * 86400_000)).not('lead_state', 'in', '(won,lost)')),
        cnt(forAccountOrShared(db.from('products').select('id', head).eq('business_id', businessId).eq('status', 'approved').is('price', null), scope)),
    ]);

    // Waiting for a reply: the customer wrote last, more than 12 hours ago.
    const waitingForReply = recentInbound.filter((c) => !c.last_outbound_at || Date.parse(c.last_outbound_at) < Date.parse(c.last_inbound_at)).length;
    const free = business.business_type === 'heysasa';
    return {
        sent_24h: sent24h, ready_to_buy: hot, waiting_messages: messages, waiting_plans: playbooks,
        followups_on: business.followup_ai_enabled === true,
        chat_on: business.chat_ai_enabled === true,
        persona_ready: business.persona_pack_status === 'ready',
        queued_now: queuedNow,
        next_send_at: nextSend[0]?.scheduled_at || null,
        chat_replies_24h: chatTurns.length,
        chat_chats_24h: new Set(chatTurns.map((t) => t.conversation_id).filter(Boolean)).size,
        new_leads_24h: newLeads,
        handoffs_open: handoffs,
        balance_kes: free || balanceUsd === null || !rate ? null : Math.round(balanceUsd * rate * 100) / 100,
        ad_leads_untouched: adUntouched,
        waiting_for_reply: waitingForReply,
        dormant_leads: dormant,
        products_without_price: noPrice,
    };
}

export default router;
