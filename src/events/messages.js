// Messages API: the caller writes the message, HeySasa only sends it and reports back (MESSAGES_API.md).
// Built for Lashtribe, whose own sequences decide who gets what and when; works for any app with a HeySasa API key.
//
//   POST   /v1/messages        { phone, name?, text?, media?, external_id?, send_at?, respect_quiet_hours?, metadata? }
//   GET    /v1/messages/:id    status, sent / delivered / read / replied times
//   DELETE /v1/messages/:id    cancel one that has not gone out yet
//
// A message is a business_events row with event_type 'message', so the engine sends it exactly like a website event:
// the built-in antiban, the WhatsApp number check, wallet billing, do-not-contact. Every change of state is posted to
// the key's webhook (webhookDispatcher.js in the engine; the triggers in 20261109000000_messages_api_webhooks.sql).
import { createHmac, randomBytes } from 'node:crypto';
import { normalizePhone } from './templates.js';

export const MESSAGE_EVENT = 'message';
export const MEDIA_TYPES = new Set(['image', 'video', 'document']);
const MAX_TEXT = 4096;
const MAX_CAPTION = 1024;
const MAX_METADATA_BYTES = 2_000;
const MAX_AHEAD_MS = 7 * 24 * 3_600_000;
const MESSAGE_FIELDS = 'id, event_type, external_id, phone, name, status, send_at, sent_at, delivered_at, read_at, replied_at, attempts, last_error, created_at, payload, media';

export function httpError(status, code, message) { return Object.assign(new Error(message || code), { status, code }); }

export const publicMessage = (row) => ({
    id: row.id,
    external_id: row.external_id ?? null,
    phone: row.phone ? `+${row.phone}` : null,
    status: row.status,
    send_at: row.send_at,
    sent_at: row.sent_at ?? null,
    delivered_at: row.delivered_at ?? null,
    read_at: row.read_at ?? null,
    replied_at: row.replied_at ?? null,
    error: ['failed', 'skipped', 'cancelled'].includes(row.status) ? row.last_error ?? null : null,
    metadata: row.payload?.metadata ?? {},
});

/** Checks and tidies a POST /v1/messages body. Throws a 400 with a plain reason. */
export function parseMessageBody(body, now = Date.now()) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'invalid_body', 'Send a JSON object.');
    const phone = normalizePhone(body.phone ?? body.to ?? body.whatsapp);
    if (!phone) throw httpError(400, 'invalid_phone', 'Set "phone" to the WhatsApp number, for example "+254712345678".');

    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (text.length > MAX_TEXT) throw httpError(400, 'text_too_long', `Keep "text" under ${MAX_TEXT} characters.`);

    let media = null;
    if (body.media != null) {
        const m = body.media;
        if (typeof m !== 'object' || Array.isArray(m)) throw httpError(400, 'invalid_media', '"media" is { "type": "image" | "video" | "document", "url": "https://..." }.');
        const type = String(m.type ?? '').toLowerCase();
        if (!MEDIA_TYPES.has(type)) throw httpError(400, 'invalid_media', '"media.type" is image, video or document.');
        let url;
        try { url = new URL(String(m.url ?? '')); } catch { url = null; }
        if (!url || url.protocol !== 'https:') throw httpError(400, 'invalid_media', '"media.url" must be a public https:// link.');
        const caption = typeof m.caption === 'string' ? m.caption.trim() : '';
        if (caption.length > MAX_CAPTION) throw httpError(400, 'caption_too_long', `Keep "media.caption" under ${MAX_CAPTION} characters.`);
        media = {
            type,
            url: url.toString(),
            ...(caption ? { caption } : {}),
            ...(typeof m.file_name === 'string' && m.file_name.trim() ? { file_name: m.file_name.trim().slice(0, 120) } : {}),
            ...(typeof m.mime_type === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(m.mime_type) ? { mime_type: m.mime_type } : {}),
        };
    }
    if (!text && !media) throw httpError(400, 'empty_message', 'Set "text", "media", or both.');

    let sendAt = now;
    if (body.send_at != null && body.send_at !== '') {
        const at = Date.parse(String(body.send_at));
        if (!Number.isFinite(at)) throw httpError(400, 'invalid_send_at', '"send_at" is an ISO time, for example "2026-11-10T09:00:00+03:00".');
        if (at > now + MAX_AHEAD_MS) throw httpError(400, 'invalid_send_at', '"send_at" can be at most 7 days ahead.');
        sendAt = Math.max(now, at);
    }

    let metadata = {};
    if (body.metadata != null) {
        if (typeof body.metadata !== 'object' || Array.isArray(body.metadata)) throw httpError(400, 'invalid_metadata', '"metadata" is a JSON object (it comes back in every webhook).');
        if (Buffer.byteLength(JSON.stringify(body.metadata)) > MAX_METADATA_BYTES) throw httpError(400, 'invalid_metadata', 'Keep "metadata" under 2 KB.');
        metadata = body.metadata;
    }

    const rawExternal = body.external_id ?? body.message_id ?? null;
    const externalId = rawExternal == null || rawExternal === '' ? null : String(rawExternal).slice(0, 120);
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) || null : null;

    return {
        phone, name, externalId, media, metadata,
        // With media the words travel as the caption (WhatsApp shows one bubble); "text" wins over media.caption.
        message: media ? (text || media.caption || '') : text,
        sendAt: new Date(sendAt).toISOString(),
        respectQuietHours: body.respect_quiet_hours === true,
    };
}

/** Webhook signature: HMAC-SHA256 of "<timestamp>.<raw body>" with the key's webhook secret. */
export function signWebhook(secret, timestamp, rawBody) {
    return createHmac('sha256', String(secret)).update(`${timestamp}.${rawBody}`).digest('hex');
}
export const generateWebhookSecret = () => `whsec_${randomBytes(24).toString('base64url')}`;

// deps: the same as createEventsRouter's, plus apiKeyAuth / accountFor / wrap from it.
export function mountMessageRoutes(router, { db, contacts, apiKeyAuth, accountFor, wrap, log = () => {}, now = () => Date.now() }) {
    async function acceptMessage({ businessId, accountId, apiKeyId, body }) {
        const m = parseMessageBody(body, now());

        if (m.externalId) {
            const { data: existing, error } = await db.from('business_events').select(MESSAGE_FIELDS)
                .eq('business_id', businessId).eq('event_type', MESSAGE_EVENT).eq('external_id', m.externalId).maybeSingle();
            if (error) throw error;
            if (existing) return { row: existing, duplicate: true };
        }

        const jid = `${m.phone}@s.whatsapp.net`;
        const contact = await contacts.getOrCreateContact(businessId, jid, m.name, null, accountId);
        if (!contact?.id) throw httpError(500, 'contact_failed');
        const { data: flags } = await db.from('contacts').select('do_not_contact').eq('id', contact.id).maybeSingle();
        if (flags?.do_not_contact === true) throw httpError(409, 'opted_out', 'This person asked not to be messaged (they wrote STOP).');
        const conversationId = await contacts.getOrCreateConversation(businessId, contact.id, jid);

        const row = {
            business_id: businessId, account_id: accountId, api_key_id: apiKeyId, event_type: MESSAGE_EVENT, external_id: m.externalId,
            phone: m.phone, name: m.name, payload: { metadata: m.metadata, requested_at: m.sendAt },
            contact_id: contact.id, conversation_id: conversationId, message: m.message, media: m.media,
            respect_quiet_hours: m.respectQuietHours, status: 'scheduled', send_at: m.sendAt,
        };
        const { data: inserted, error } = await db.from('business_events').insert(row).select(MESSAGE_FIELDS).single();
        if (error?.code === '23505' && m.externalId) {
            const { data: existing } = await db.from('business_events').select(MESSAGE_FIELDS)
                .eq('business_id', businessId).eq('event_type', MESSAGE_EVENT).eq('external_id', m.externalId).maybeSingle();
            if (existing) return { row: existing, duplicate: true };
        }
        if (error) throw error;
        log('info', 'messages.accepted', { businessId, accountId, eventId: inserted.id, contactId: contact.id, media: m.media?.type ?? null });
        return { row: inserted, duplicate: false };
    }

    async function ownMessage(req) {
        const id = String(req.params.id);
        const byId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
        let q = db.from('business_events').select(MESSAGE_FIELDS).eq('business_id', req.apiKey.business_id).eq('event_type', MESSAGE_EVENT);
        q = byId ? q.eq('id', id) : q.eq('external_id', id.slice(0, 120));
        const { data, error } = await q.maybeSingle();
        if (error) throw error;
        if (!data) throw httpError(404, 'not_found', 'No such message.');
        return data;
    }

    router.post('/v1/messages', apiKeyAuth, wrap(async (req, res) => {
        const accountId = await accountFor(req.apiKey.business_id, req.apiKey.account_id);
        const { row, duplicate } = await acceptMessage({ businessId: req.apiKey.business_id, accountId, apiKeyId: req.apiKey.id, body: req.body });
        res.status(duplicate ? 200 : 202);
        return { ...publicMessage(row), duplicate };
    }));

    // :id is HeySasa's id or your own external_id
    router.get('/v1/messages/:id', apiKeyAuth, wrap(async (req) => publicMessage(await ownMessage(req))));

    router.delete('/v1/messages/:id', apiKeyAuth, wrap(async (req) => {
        const row = await ownMessage(req);
        if (row.status !== 'scheduled') throw httpError(409, 'not_cancellable', `It is already ${row.status}.`);
        const { data, error } = await db.from('business_events').update({ status: 'cancelled', last_error: 'cancelled_by_caller' })
            .eq('id', row.id).eq('status', 'scheduled').select(MESSAGE_FIELDS).maybeSingle();
        if (error) throw error;
        if (!data) throw httpError(409, 'not_cancellable', 'It is already being sent.');
        return publicMessage(data);
    }));

    return { acceptMessage };
}
