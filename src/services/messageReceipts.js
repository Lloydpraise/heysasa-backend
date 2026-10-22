// Reads WhatsApp delivery/read receipts out of an Evolution `messages.update` webhook.
//
// Evolution's own payload names the WhatsApp message id `keyId` (with `messageId` being Evolution's
// internal id), while raw Baileys shapes nest it under `key.id`. The old handler only looked at
// `key.id`, skipped every update, and still logged "ok" - so no receipt ever reached a message.
// This accepts every shape we know of and returns one clean record per receipt.

// Baileys' numeric status enum, in case a version sends the number instead of the word.
const NUMERIC_STATUS = { 0: 'ERROR', 1: 'PENDING', 2: 'SERVER_ACK', 3: 'DELIVERY_ACK', 4: 'READ', 5: 'PLAYED' };

export function normalizeReceiptStatus(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    if (typeof raw === 'number') return NUMERIC_STATUS[raw] || null;
    const text = String(raw).trim();
    if (/^\d+$/.test(text)) return NUMERIC_STATUS[Number(text)] || null;
    return text.toUpperCase().replace(/-/g, '_');
}

function toUpdateList(payload) {
    const data = payload?.data;
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.updates)) return data.updates;
    if (data && typeof data === 'object') return [data];
    return [];
}

// -> [{ whatsappMessageId, status, fromMe }]; entries without an id or a usable status are dropped,
// and so are receipts for messages the customer sent (we only track our own outbound messages).
export function extractReceiptUpdates(payload) {
    const out = [];
    for (const update of toUpdateList(payload)) {
        if (!update || typeof update !== 'object') continue;
        const whatsappMessageId = update.keyId || update.key?.id || update.messageKeyId || null;
        const status = normalizeReceiptStatus(update.status ?? update.update?.status ?? update.receipt?.status);
        if (!whatsappMessageId || !status) continue;
        const fromMe = update.fromMe ?? update.key?.fromMe;
        if (fromMe === false) continue;
        out.push({ whatsappMessageId: String(whatsappMessageId), status, fromMe: fromMe === true });
    }
    return out;
}

// For the one-off warning when a payload has content but nothing we can read: just its shape, never its values.
export function describePayloadShape(payload) {
    const first = toUpdateList(payload)[0];
    return {
        dataType: Array.isArray(payload?.data) ? 'array' : typeof payload?.data,
        keys: first && typeof first === 'object' ? Object.keys(first).slice(0, 15) : [],
    };
}
