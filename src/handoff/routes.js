// Routes behind Handoffs (settings in the persona pack, and the "Needs you" card on Home). Scoped to the selected
// WhatsApp account (ACCOUNTS.md): the settings are the account's view (business default + accounts.settings) and
// the handed-over chats are that account's; the business-wide view sees every account.
//
//   GET  /handoff/config                        { config, owner_phone, suggested }
//   PUT  /handoff/config                        save { recipients, rules, default_to, alert_whatsapp }
//   POST /handoff/test                          send a test alert to the default people
//   GET  /handoff/open                          chats the AI handed over that the owner has not marked handled
//   POST /handoff/:conversationId/resolve       mark a handed-over chat as handled

import express from 'express';
import { SUGGESTED_CASES, normalizeHandoffConfig, resolveRecipients } from './config.js';
import { handoffMessage } from './notifier.js';
import { forAccount } from '../middleware/accessScope.js';
import { loadAccountSettings } from '../services/accounts.js';
import { saveAccountSettings } from '../services/accountSettings.js';

export function createHandoffRouter({ auth, supabase, send, appUrl = '' }) {
    const router = express.Router();
    router.use(auth);

    const loadBusiness = (req) => loadAccountSettings(supabase, req.accountId ?? null, req.businessId);
    const scopeOf = (req) => req.scope ?? { businessId: req.businessId, accountId: req.accountId ?? null };

    router.get('/config', async (req, res, next) => {
        try {
            const business = await loadBusiness(req);
            if (!business) return res.status(404).json({ ok: false, error: 'business_not_found' });
            const { config } = normalizeHandoffConfig(business.chat_ai_settings?.handoff);
            return res.json({ ok: true, config, owner_phone: business.owner_phone || business.phone || null, suggested: SUGGESTED_CASES });
        } catch (error) { return next(error); }
    });

    router.put('/config', async (req, res, next) => {
        try {
            const { config, errors } = normalizeHandoffConfig(req.body);
            // Anything that had to be dropped is reported instead of silently saved wrong.
            if (errors.length) return res.status(400).json({ ok: false, error: 'invalid', message: errors[0], errors });
            const business = await loadBusiness(req);
            if (!business) return res.status(404).json({ ok: false, error: 'business_not_found' });
            // Only the handoff key changes; opening hours and the setup answers in the same column stay as they are.
            const settings = { ...(business.chat_ai_settings ?? {}), handoff: config };
            try {
                await saveAccountSettings(supabase, scopeOf(req), { chat_ai_settings: settings });
            } catch {
                return res.status(500).json({ ok: false, error: 'could_not_save' });
            }
            return res.json({ ok: true, config });
        } catch (error) { return next(error); }
    });

    router.post('/test', async (req, res, next) => {
        try {
            const business = await loadBusiness(req);
            if (!business) return res.status(404).json({ ok: false, error: 'business_not_found' });
            const { recipients } = resolveRecipients(business.chat_ai_settings?.handoff, null, business.owner_phone || business.phone);
            if (!recipients.length) return res.status(400).json({ ok: false, error: 'no_number', message: 'There is no alerts number to send to. Add your phone number in Business settings.' });
            const text = handoffMessage({
                urgency: 'normal', contact_name: 'Test customer', rule_label: 'Test alert', reason: 'This is a test, nobody needs you.',
                summary: 'This is how a handoff alert from HeySasa looks.',
            }, appUrl);
            let sent = 0;
            for (const person of recipients) {
                const result = await send(person.phone, text).catch(() => ({ ok: false }));
                if (result?.ok) sent += 1;
            }
            if (!sent) return res.status(502).json({ ok: false, error: 'not_sent', message: 'The test message could not be sent. Check that your WhatsApp is connected, then try again.' });
            return res.json({ ok: true, sent, of: recipients.length });
        } catch (error) { return next(error); }
    });

    router.get('/open', async (req, res, next) => {
        try {
            const { data, error } = await forAccount(supabase.from('conversations')
                .select('id, contact_id, account_id, handover_reason, handover_urgency, handover_summary, handover_at, handover_source, contacts(name, phone)')
                .eq('business_id', req.businessId).eq('handover_flag', true).is('handover_resolved_at', null), req.scope)
                .order('handover_at', { ascending: false }).limit(30);
            if (error) return res.status(500).json({ ok: false, error: 'could_not_load' });
            const items = (data ?? []).map((c) => ({
                conversation_id: c.id, contact_id: c.contact_id, account_id: c.account_id ?? null, name: c.contacts?.name || null, phone: c.contacts?.phone || null,
                reason: c.handover_reason, urgency: c.handover_urgency || 'normal', summary: c.handover_summary, at: c.handover_at, source: c.handover_source,
            }));
            return res.json({ ok: true, items });
        } catch (error) { return next(error); }
    });

    router.post('/:conversationId/resolve', async (req, res, next) => {
        try {
            const { data, error } = await forAccount(supabase.from('conversations')
                .update({ handover_resolved_at: new Date().toISOString() })
                .eq('id', req.params.conversationId).eq('business_id', req.businessId), req.scope).select('id');
            if (error) return res.status(500).json({ ok: false, error: 'could_not_save' });
            if (!data?.length) return res.status(404).json({ ok: false, error: 'not_found' });
            return res.json({ ok: true });
        } catch (error) { return next(error); }
    });

    return router;
}
