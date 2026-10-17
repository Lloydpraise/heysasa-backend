// Shapes the small numbers behind the Home screen. Pure: no database. The route does the counting,
// this file decides what the owner is told, so the rules can be tested without a server.
//
// Old keys (sent_24h, ready_to_buy, waiting_messages, waiting_plans) stay exactly as they were.

const n = (value) => {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? Math.floor(num) : 0;
};

// KES per message the owner is told about: 1 KES pays for 2 messages. Only ever shown as an estimate.
export const MESSAGES_PER_KES = 2;

export function estimateMessages(balanceKes) {
    const kes = Number(balanceKes);
    if (!Number.isFinite(kes) || kes <= 0) return 0;
    // Round down to a friendly number so the estimate is never promised higher than it is.
    const raw = Math.floor(kes * MESSAGES_PER_KES);
    if (raw >= 1000) return Math.floor(raw / 100) * 100;
    if (raw >= 100) return Math.floor(raw / 10) * 10;
    return raw;
}

// raw: plain counts from the route. Anything missing counts as zero, so a failed count never breaks Home.
export function shapeHomeSummary(raw = {}) {
    const balanceKes = raw.balance_kes === null || raw.balance_kes === undefined ? null : Number(raw.balance_kes);
    return {
        sent_24h: n(raw.sent_24h),
        ready_to_buy: n(raw.ready_to_buy),
        waiting_messages: n(raw.waiting_messages),
        waiting_plans: n(raw.waiting_plans),
        live: {
            followups_on: raw.followups_on === true,
            chat_on: raw.chat_on === true,
            persona_ready: raw.persona_ready === true,
            queued_now: n(raw.queued_now),
            next_send_at: raw.next_send_at || null,
            chat_replies_24h: n(raw.chat_replies_24h),
            chat_chats_24h: n(raw.chat_chats_24h),
            new_leads_24h: n(raw.new_leads_24h),
            handoffs_open: n(raw.handoffs_open),
            balance_kes: Number.isFinite(balanceKes) ? balanceKes : null,
            messages_left: Number.isFinite(balanceKes) ? estimateMessages(balanceKes) : null,
        },
        opportunities: {
            ad_leads_untouched: n(raw.ad_leads_untouched),
            waiting_for_reply: n(raw.waiting_for_reply),
            dormant_leads: n(raw.dormant_leads),
            products_without_price: n(raw.products_without_price),
        },
    };
}
