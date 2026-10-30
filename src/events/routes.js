// Events API: a client's website tells HeySasa that something happened and HeySasa sends the WhatsApp message for it.
// See EVENTS_API.md for the contract the website follows.
//
// Public (website, server to server, API key in "Authorization: Bearer hs_live_..."):
//   POST   /v1/events                       { event, phone, name?, event_id?, data? } -> 202 { id, status, send_at }
//   GET    /v1/events/:id                   delivery status of one event
//
// Dashboard (signed-in owner; Preferences -> Integrations -> Website):
//   GET    /integrations/website            keys (masked), templates, merge fields, recent events
//   POST   /integrations/api-keys           (owner/admin) { label, accountId? } -> the key, shown once
//   DELETE /integrations/api-keys/:id       (owner/admin) revoke
//   PUT    /integrations/event-templates/:type  (owner/admin) { enabled, body, delayMinutes, respectQuietHours }
//   DELETE /integrations/event-templates/:type  (owner/admin) back to the built-in default (or remove a custom event)
//   POST   /integrations/test-event         (owner/admin) { phone, name? } -> sends a sample "order.paid" to that phone
//
// The event is saved in business_events with the message already written; the follow-up engine sends it through the
// built-in antiban (sender-baileys/eventSender.js). A paid order cancels a cart reminder still waiting for that person.
import { Router } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import {
    DEFAULT_TEMPLATES, EVENT_TYPE_RE, MERGE_FIELDS, PURCHASE_EVENTS, REMINDER_EVENTS,
    normalizePhone, renderTemplate, resolveTemplate,
} from './templates.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_RE = /^hs_live_[A-Za-z0-9_-]{20,80}$/;
const MAX_PAYLOAD_BYTES = 20_000;
const RATE_PER_MINUTE = 120;
const LAST_USED_EVERY_MS = 60_000;
const EVENT_FIELDS = 'id, event_type, external_id, phone, name, status, send_at, sent_at, attempts, last_error, created_at, message';

function httpError(status, code, message) { return Object.assign(new Error(message || code), { status, code }); }

export const hashKey = (key) => createHash('sha256').update(String(key)).digest('hex');
export function generateKey() {
    const key = `hs_live_${randomBytes(24).toString('base64url')}`;
    return { key, prefix: key.slice(0, 14), hash: hashKey(key) };
}

function readKey(req) {
    const auth = String(req.get('authorization') || '');
    const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    return bearer || String(req.get('x-api-key') || '').trim();
}

const publicEvent = (row) => ({
    id: row.id, event: row.event_type, event_id: row.external_id ?? null, status: row.status,
    send_at: row.send_at, sent_at: row.sent_at ?? null, error: row.status === 'failed' || row.status === 'skipped' || row.status === 'cancelled' ? row.last_error ?? null : null,
});

// deps: { db, scope, admin, contacts: { getOrCreateContact, getOrCreateConversation }, apiBaseUrl?, log?, now? }
export function createEventsRouter({ db, scope, admin, contacts, apiBaseUrl = '', log = () => {}, now = () => Date.now() }) {
    const router = Router();
    const hits = new Map();        // key id -> [ms] in the last minute
    const lastUsedWrite = new Map(); // key id -> ms

    const wrap = (fn) => async (req, res) => {
        try {
            const out = await fn(req, res);
            if (!res.headersSent) res.json({ ok: true, ...out });
        } catch (error) {
            const status = Number(error.status) || 500;
            if (status >= 500) log('error', 'events.route_failed', { path: req.path, businessId: req.businessId ?? null, error: error.message });
            res.status(status).json({ ok: false, error: error.code || 'server_error', message: status >= 500 ? 'Something went wrong on our side. Try again.' : error.message });
        }
    };

    // ── API key auth for websites ──────────────────────────────────────────────────────────────────
    async function apiKeyAuth(req, _res, next) {
        try {
            const key = readKey(req);
            if (!key) throw httpError(401, 'missing_api_key', 'Send your key as "Authorization: Bearer hs_live_...".');
            if (!KEY_RE.test(key)) throw httpError(401, 'invalid_api_key', 'That API key is not valid.');
            const { data, error } = await db.from('api_keys').select('id, business_id, account_id, revoked_at').eq('key_hash', hashKey(key)).maybeSingle();
            if (error) throw error;
            if (!data || data.revoked_at) throw httpError(401, 'invalid_api_key', 'That API key is not valid or was revoked.');

            const t = now();
            const recent = (hits.get(data.id) ?? []).filter((at) => t - at < 60_000);
            if (recent.length >= RATE_PER_MINUTE) throw httpError(429, 'rate_limited', `At most ${RATE_PER_MINUTE} events a minute per key.`);
            recent.push(t);
            hits.set(data.id, recent);

            if (t - (lastUsedWrite.get(data.id) ?? 0) > LAST_USED_EVERY_MS) {
                lastUsedWrite.set(data.id, t);
                void db.from('api_keys').update({ last_used_at: new Date(t).toISOString() }).eq('id', data.id).then(() => {}, () => {});
            }
            req.apiKey = data;
            req.businessId = data.business_id;
            next();
        } catch (error) {
            const status = Number(error.status) || 500;
            if (status >= 500) log('error', 'events.auth_failed', { error: error.message });
            next(Object.assign(error, { status }));
        }
    }
    const keyError = (err, _req, res, next) => {
        if (!err) return next();
        const status = Number(err.status) || 500;
        res.status(status).json({ ok: false, error: err.code || 'server_error', message: status >= 500 ? 'Something went wrong on our side. Try again.' : err.message });
    };

    // The WhatsApp account an event goes out on: the key's own, else the business's primary account (null before accounts).
    async function accountFor(businessId, keyAccountId) {
        if (keyAccountId) return keyAccountId;
        const { data } = await db.from('accounts').select('id').eq('business_id', businessId).eq('is_primary', true).maybeSingle();
        return data?.id ?? null;
    }

    // Shared by the website API and the dashboard's test button.
    async function acceptEvent({ businessId, accountId, apiKeyId = null, body }) {
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'invalid_body', 'Send a JSON object.');
        if (Buffer.byteLength(JSON.stringify(body)) > MAX_PAYLOAD_BYTES) throw httpError(413, 'payload_too_large', 'Keep the event under 20 KB.');
        const eventType = String(body.event ?? body.type ?? '').trim().toLowerCase();
        if (!EVENT_TYPE_RE.test(eventType) || eventType.length > 60) throw httpError(400, 'invalid_event', 'Set "event", for example "cart.abandoned" or "order.paid".');
        const phone = normalizePhone(body.phone ?? body.whatsapp);
        if (!phone) throw httpError(400, 'invalid_phone', 'Set "phone" to the customer\'s WhatsApp number, for example "+254712345678".');
        const externalId = body.event_id ?? body.eventId ?? null;
        const external = externalId == null || externalId === '' ? null : String(externalId).slice(0, 120);
        const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) || null : null;
        const data = body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : {};

        // The same event sent again is answered with the first one, never a second message.
        if (external) {
            const { data: existing, error } = await db.from('business_events').select(EVENT_FIELDS)
                .eq('business_id', businessId).eq('event_type', eventType).eq('external_id', external).maybeSingle();
            if (error) throw error;
            if (existing) return { event: existing, duplicate: true };
        }

        const [{ data: saved, error: tplError }, { data: business, error: bizError }] = await Promise.all([
            db.from('event_templates').select('*').eq('business_id', businessId).eq('event_type', eventType).maybeSingle(),
            db.from('businesses').select('name').eq('business_id', businessId).maybeSingle(),
        ]);
        if (tplError) throw tplError;
        if (bizError) throw bizError;
        const template = resolveTemplate(eventType, saved);
        if (!template) {
            throw httpError(422, 'event_not_enabled', saved
                ? `"${eventType}" is switched off in HeySasa.`
                : `HeySasa has no message for "${eventType}". Use a built-in event or add a template for it in Preferences -> Integrations.`);
        }

        const jid = `${phone}@s.whatsapp.net`;
        const contact = await contacts.getOrCreateContact(businessId, jid, name, null, accountId);
        if (!contact?.id) throw httpError(500, 'contact_failed');
        const conversationId = await contacts.getOrCreateConversation(businessId, contact.id, jid);

        const message = renderTemplate(template.body, { name: name ?? contact.name, businessName: business?.name, data });
        const sendAt = new Date(now() + template.delayMinutes * 60_000).toISOString();

        // A purchase cancels the cart reminder still waiting for this person.
        if (PURCHASE_EVENTS.has(eventType)) {
            const { error } = await db.from('business_events').update({ status: 'cancelled', last_error: `cancelled_by_${eventType}` })
                .eq('business_id', businessId).eq('contact_id', contact.id).in('event_type', [...REMINDER_EVENTS]).eq('status', 'scheduled');
            if (error) log('warn', 'events.cancel_reminder_failed', { businessId, error: error.message });
        }

        const row = {
            business_id: businessId, account_id: accountId, api_key_id: apiKeyId, event_type: eventType, external_id: external,
            phone, name, payload: data, contact_id: contact.id, conversation_id: conversationId, message,
            respect_quiet_hours: template.respectQuietHours, status: 'scheduled', send_at: sendAt,
        };
        const { data: inserted, error } = await db.from('business_events').insert(row).select(EVENT_FIELDS).single();
        if (error?.code === '23505' && external) {
            const { data: existing } = await db.from('business_events').select(EVENT_FIELDS)
                .eq('business_id', businessId).eq('event_type', eventType).eq('external_id', external).maybeSingle();
            if (existing) return { event: existing, duplicate: true };
        }
        if (error) throw error;
        log('info', 'events.accepted', { businessId, accountId, eventId: inserted.id, eventType, contactId: contact.id, sendAt });
        return { event: inserted, duplicate: false };
    }

    // ── website API ────────────────────────────────────────────────────────────────────────────────
    router.post('/v1/events', apiKeyAuth, wrap(async (req, res) => {
        const accountId = await accountFor(req.apiKey.business_id, req.apiKey.account_id);
        const { event, duplicate } = await acceptEvent({ businessId: req.apiKey.business_id, accountId, apiKeyId: req.apiKey.id, body: req.body });
        res.status(duplicate ? 200 : 202);
        return { ...publicEvent(event), duplicate };
    }));

    router.get('/v1/events/:id', apiKeyAuth, wrap(async (req) => {
        if (!UUID.test(String(req.params.id))) throw httpError(404, 'not_found', 'No such event.');
        const { data, error } = await db.from('business_events').select(EVENT_FIELDS).eq('id', req.params.id).eq('business_id', req.apiKey.business_id).maybeSingle();
        if (error) throw error;
        if (!data) throw httpError(404, 'not_found', 'No such event.');
        return publicEvent(data);
    }));
    router.use('/v1', keyError);

    // ── dashboard ──────────────────────────────────────────────────────────────────────────────────
    router.get('/integrations/website', scope, wrap(async (req) => {
        const [keys, saved, events] = await Promise.all([
            req.scope.isAdmin
                ? db.from('api_keys').select('id, label, key_prefix, account_id, created_at, last_used_at').eq('business_id', req.businessId).is('revoked_at', null).order('created_at', { ascending: false })
                : Promise.resolve({ data: [] }),
            db.from('event_templates').select('*').eq('business_id', req.businessId),
            db.from('business_events').select(EVENT_FIELDS).eq('business_id', req.businessId).order('created_at', { ascending: false }).limit(20),
        ]);
        for (const r of [keys, saved, events]) if (r.error) throw r.error;
        const savedByType = new Map((saved.data ?? []).map((t) => [t.event_type, t]));
        const types = [...new Set([...Object.keys(DEFAULT_TEMPLATES), ...savedByType.keys()])];
        const templates = types.map((type) => {
            const builtIn = DEFAULT_TEMPLATES[type] ?? null;
            const row = savedByType.get(type) ?? null;
            return {
                event: type,
                label: builtIn?.label ?? type,
                description: builtIn?.description ?? 'Your own event.',
                builtIn: !!builtIn,
                customized: !!row,
                enabled: row ? row.enabled : true,
                body: row?.body ?? builtIn.body,
                delayMinutes: row?.delay_minutes ?? builtIn.delayMinutes,
                respectQuietHours: row?.respect_quiet_hours ?? builtIn.respectQuietHours,
            };
        });
        return {
            apiBaseUrl,
            canManage: req.scope.isAdmin,
            keys: keys.data ?? [],
            templates,
            mergeFields: MERGE_FIELDS.map(([field, meaning]) => ({ field, meaning })),
            events: events.data ?? [],
        };
    }));

    router.post('/integrations/api-keys', admin, wrap(async (req, res) => {
        const label = String(req.body?.label ?? '').trim().slice(0, 60) || 'Website';
        const accountId = req.body?.accountId ?? req.scope.accountId ?? null;
        if (accountId && (!UUID.test(String(accountId)) || !req.scope.accountIds.includes(accountId))) throw httpError(403, 'account_not_allowed');
        const { count, error: countError } = await db.from('api_keys').select('id', { count: 'exact', head: true }).eq('business_id', req.businessId).is('revoked_at', null);
        if (countError) throw countError;
        if ((count ?? 0) >= 10) throw httpError(400, 'too_many_keys', 'Revoke a key you no longer use first (10 at most).');
        const { key, prefix, hash } = generateKey();
        const { data, error } = await db.from('api_keys').insert({
            business_id: req.businessId, account_id: accountId, label, key_prefix: prefix, key_hash: hash, created_by: req.userId ?? null,
        }).select('id, label, key_prefix, account_id, created_at, last_used_at').single();
        if (error) throw error;
        log('info', 'events.key_created', { businessId: req.businessId, keyId: data.id, accountId });
        res.status(201);
        return { key, apiKey: data };
    }));

    router.delete('/integrations/api-keys/:id', admin, wrap(async (req) => {
        if (!UUID.test(String(req.params.id))) throw httpError(404, 'not_found');
        const { data, error } = await db.from('api_keys').update({ revoked_at: new Date(now()).toISOString() })
            .eq('id', req.params.id).eq('business_id', req.businessId).is('revoked_at', null).select('id').maybeSingle();
        if (error) throw error;
        if (!data) throw httpError(404, 'not_found');
        log('info', 'events.key_revoked', { businessId: req.businessId, keyId: data.id });
        return { revoked: data.id };
    }));

    router.put('/integrations/event-templates/:type', admin, wrap(async (req) => {
        const type = String(req.params.type).toLowerCase();
        if (!EVENT_TYPE_RE.test(type) || type.length > 60) throw httpError(400, 'invalid_event', 'Event names use lowercase letters, numbers, _ and dots.');
        const builtIn = DEFAULT_TEMPLATES[type] ?? null;
        const body = typeof req.body?.body === 'string' ? req.body.body.trim() : (builtIn?.body ?? '');
        if (!body || body.length > 1000) throw httpError(400, 'invalid_body', 'Write a message of up to 1000 characters.');
        const delay = Number(req.body?.delayMinutes ?? builtIn?.delayMinutes ?? 0);
        if (!Number.isInteger(delay) || delay < 0 || delay > 10080) throw httpError(400, 'invalid_delay', 'The delay is 0 to 10080 minutes (7 days).');
        const row = {
            business_id: req.businessId, event_type: type,
            enabled: req.body?.enabled !== false,
            body,
            delay_minutes: delay,
            respect_quiet_hours: typeof req.body?.respectQuietHours === 'boolean' ? req.body.respectQuietHours : (builtIn?.respectQuietHours ?? false),
            updated_at: new Date(now()).toISOString(),
        };
        const { data, error } = await db.from('event_templates').upsert(row, { onConflict: 'business_id,event_type' }).select('*').single();
        if (error) throw error;
        return { template: data };
    }));

    router.delete('/integrations/event-templates/:type', admin, wrap(async (req) => {
        const { error } = await db.from('event_templates').delete().eq('business_id', req.businessId).eq('event_type', String(req.params.type).toLowerCase());
        if (error) throw error;
        return { reset: true };
    }));

    router.post('/integrations/test-event', admin, wrap(async (req, res) => {
        const accountId = await accountFor(req.businessId, req.scope.accountId ?? null);
        const stamp = now();
        const { event } = await acceptEvent({
            businessId: req.businessId, accountId,
            body: {
                event: 'order.paid', event_id: `test_${stamp}`, phone: req.body?.phone, name: req.body?.name || 'Test customer',
                data: { order_id: `TEST-${String(stamp).slice(-5)}`, total: 2500, currency: 'KES', items: [{ name: 'Sample item', qty: 1 }] },
            },
        });
        res.status(202);
        return { event };
    }));

    return router;
}
