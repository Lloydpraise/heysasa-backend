// Event types, their built-in messages and the merge fields a template may use. See EVENTS_API.md.
//
// A business can change the wording, the delay and the switch of any event in the dashboard (event_templates). Without a
// saved row the default below is used. Any other event name (lowercase, dots allowed, e.g. "booking.confirmed") is
// accepted once the business has saved an enabled template for it.

export const EVENT_TYPE_RE = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;

export const DEFAULT_TEMPLATES = {
    'cart.abandoned': {
        label: 'Abandoned cart',
        description: 'A shopper started checkout with their phone number but did not pay.',
        body: 'Hi {{first_name}}, you left {{items}} in your cart at {{business_name}}. You can finish your order here: {{cart_url}}',
        delayMinutes: 60,
        respectQuietHours: true,
    },
    'order.paid': {
        label: 'Order paid',
        description: 'Payment went through. Sends the receipt straight away.',
        body: 'Hi {{first_name}}, thank you for your order at {{business_name}}! We have received your payment of {{currency}} {{total}} for order {{order_id}}: {{items}}. We will keep you posted.',
        delayMinutes: 0,
        respectQuietHours: false,
    },
    'order.shipped': {
        label: 'Order shipped',
        description: 'The order left the shop. Sends a delivery update.',
        body: 'Hi {{first_name}}, good news: your order {{order_id}} from {{business_name}} is on its way. {{tracking_url}}',
        delayMinutes: 0,
        respectQuietHours: false,
    },
};

// Events that mean the shopper bought: they cancel any reminder still waiting for the same person.
export const PURCHASE_EVENTS = new Set(['order.paid']);
export const REMINDER_EVENTS = new Set(['cart.abandoned']);

export const MERGE_FIELDS = [
    ['first_name', 'The customer\'s first name ("there" when we have none)'],
    ['name', 'The customer\'s full name'],
    ['business_name', 'Your business name'],
    ['order_id', 'data.order_id'],
    ['total', 'data.total'],
    ['currency', 'data.currency (KES when not sent)'],
    ['items', 'data.items, written as "2 x Lash kit, 1 x Glue"'],
    ['cart_url', 'data.cart_url'],
    ['order_url', 'data.order_url'],
    ['tracking_url', 'data.tracking_url'],
    ['data.<anything>', 'Any other field you send inside data'],
];

const MAX_MESSAGE = 1500;

function firstName(name) {
    const text = String(name ?? '').trim();
    if (!text || /^\+?[\d\s\-().]+$/.test(text)) return 'there';
    return text.split(/\s+/)[0];
}

function formatAmount(value) {
    const n = Number(value);
    if (value === '' || value == null || !Number.isFinite(n)) return String(value ?? '');
    return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

// [{ name, qty }] or ["Lash kit"] or a plain string -> "2 x Lash kit, Glue"
export function formatItems(items) {
    if (typeof items === 'string') return items.trim();
    if (!Array.isArray(items)) return '';
    const parts = items.slice(0, 20).map((item) => {
        if (typeof item === 'string') return item.trim();
        if (!item || typeof item !== 'object') return '';
        const name = String(item.name ?? item.title ?? item.product ?? '').trim();
        if (!name) return '';
        const qty = Number(item.qty ?? item.quantity ?? 1);
        return Number.isFinite(qty) && qty > 1 ? `${qty} x ${name}` : name;
    }).filter(Boolean);
    return parts.join(', ');
}

function scalar(value) {
    if (value == null) return '';
    if (typeof value === 'object') return Array.isArray(value) ? formatItems(value) : '';
    return String(value);
}

// Fills {{field}} tokens. A token with no value becomes empty, then leftover blank spaces and dangling punctuation are
// tidied so a missing tracking link does not leave "on its way. ." behind.
export function renderTemplate(body, { name = null, businessName = '', data = {} } = {}) {
    const d = data && typeof data === 'object' ? data : {};
    const fields = {
        first_name: firstName(name),
        name: String(name ?? '').trim() || 'there',
        business_name: String(businessName ?? '').trim() || 'us',
        order_id: scalar(d.order_id ?? d.orderId),
        total: formatAmount(d.total ?? d.amount),
        currency: scalar(d.currency) || 'KES',
        items: formatItems(d.items) || 'your items',
        cart_url: scalar(d.cart_url ?? d.cartUrl),
        order_url: scalar(d.order_url ?? d.orderUrl),
        tracking_url: scalar(d.tracking_url ?? d.trackingUrl),
    };
    const out = String(body ?? '').replace(/\{\{\s*([a-z0-9_.]+)\s*\}\}/gi, (_m, key) => {
        const k = key.toLowerCase();
        if (k.startsWith('data.')) return scalar(d[key.slice(5)]);
        return fields[k] ?? '';
    });
    return out
        .replace(/[ \t]+([.,!?:;])/g, '$1')
        .replace(/:\s*([.!?])/g, '$1')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/[ \t]+$/gm, '')
        .trim()
        .slice(0, MAX_MESSAGE);
}

// The template that applies to an event: the business's saved row over the built-in default.
// Returns null when the event type is unknown or switched off.
export function resolveTemplate(eventType, savedRow) {
    const builtIn = DEFAULT_TEMPLATES[eventType] ?? null;
    if (savedRow) {
        if (!savedRow.enabled) return null;
        return {
            body: savedRow.body,
            delayMinutes: savedRow.delay_minutes ?? builtIn?.delayMinutes ?? 0,
            respectQuietHours: savedRow.respect_quiet_hours ?? builtIn?.respectQuietHours ?? false,
        };
    }
    if (!builtIn) return null;
    return { body: builtIn.body, delayMinutes: builtIn.delayMinutes, respectQuietHours: builtIn.respectQuietHours };
}

// "0712 345 678", "+254712345678", "254712345678", "712345678" -> "254712345678". Returns '' when it cannot be a number.
export function normalizePhone(phone, countryCode = process.env.DEFAULT_PHONE_COUNTRY_CODE || '254') {
    const digits = String(phone ?? '').replace(/\D/g, '');
    const code = String(countryCode).replace(/\D/g, '') || '254';
    if (!digits) return '';
    let out = digits;
    if (digits.startsWith('00')) out = digits.slice(2);
    else if (digits.startsWith(code)) out = digits;
    else if (digits.startsWith('0')) out = `${code}${digits.slice(1)}`;
    else if (digits.length === 9) out = `${code}${digits}`;
    return out.length >= 8 && out.length <= 15 ? out : '';
}
