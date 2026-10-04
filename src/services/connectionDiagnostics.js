// Turns an Evolution `connection.update` webhook into something a human can
// read in the persisted logs: the state, WhatsApp's close code, what that code
// usually means, and a cleaned copy of the payload (no QR, pairing code or keys).

// Baileys / WhatsApp Web close codes.
const CLOSE_CODE_MEANINGS = {
    401: 'logged out: the number was unlinked from the phone (Linked devices) or WhatsApp logged the session out',
    403: 'forbidden: WhatsApp refused the session, commonly a restriction or ban on the number',
    408: 'timed out: the connection to WhatsApp was lost or timed out',
    411: 'multi-device mismatch: the phone and the linked session got out of sync',
    428: 'connection closed: the socket to WhatsApp dropped (network or server side), usually reconnects on its own',
    440: 'connection replaced: the same number was opened somewhere else, which kicked this session out',
    500: 'bad session: the stored session is corrupt and the number must be paired again',
    503: 'WhatsApp service unavailable',
    515: 'restart required: normal right after pairing, the session restarts itself',
};

const REDACT_KEYS = new Set(['qrcode', 'qrcodebase64', 'base64', 'pairingcode', 'pairing_code', 'code', 'apikey', 'token', 'authorization']);

function redact(value, depth = 0) {
    if (depth > 6 || value === null || value === undefined) return value ?? null;
    if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
    if (typeof value === 'object') {
        const out = {};
        for (const [key, val] of Object.entries(value)) {
            out[key] = REDACT_KEYS.has(key.toLowerCase()) ? '[redacted]' : redact(val, depth + 1);
        }
        return out;
    }
    if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}...`;
    return value;
}

function firstNumber(...candidates) {
    for (const candidate of candidates) {
        const n = Number(candidate);
        if (candidate !== null && candidate !== undefined && candidate !== '' && Number.isFinite(n)) return n;
    }
    return null;
}

function firstText(...candidates) {
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
    return null;
}

export function describeConnectionUpdate(payload) {
    const data = payload?.data || {};
    const state = String(data.state || data.status || data.connection || '').toLowerCase() || 'unknown';
    const instance = payload?.instance || data.instance || null;
    const lastError = data.lastDisconnect?.error || data.error || null;

    const statusCode = firstNumber(
        data.statusReason,
        data.statusCode,
        data.reason,
        data.disconnectReason,
        data.disconnect_reason,
        lastError?.output?.statusCode,
        lastError?.statusCode,
        lastError?.data?.statusCode,
    );
    const reasonText = firstText(
        typeof data.reason === 'string' ? data.reason : null,
        data.message,
        lastError?.message,
        typeof lastError === 'string' ? lastError : null,
    );
    const meaning = statusCode !== null
        ? (CLOSE_CODE_MEANINGS[statusCode] || 'unrecognised close code')
        : null;

    return {
        state,
        instance,
        statusCode,
        reasonText,
        meaning,
        raw: redact({ event: payload?.event, instance, date_time: payload?.date_time, data }),
    };
}

export function summariseClose(info) {
    const parts = [`WhatsApp disconnected (${info.instance || 'unknown instance'})`];
    if (info.statusCode !== null) parts.push(`code ${info.statusCode}, ${info.meaning}`);
    else parts.push('no close code in the payload');
    if (info.reasonText) parts.push(`detail: ${info.reasonText}`);
    return parts.join(': ');
}
