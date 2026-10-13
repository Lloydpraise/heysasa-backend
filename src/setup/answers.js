// Checks the onboarding answers before anything is saved. Pure, no database.
export const HANDOFF_REASONS = ['asks_for_call', 'ready_to_pay', 'asks_unknown_price', 'angry_or_upset', 'asks_for_human'];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

// Body (every part optional):
//   { hours: { open: "08:00", close: "18:00", days: [1,2,3,4,5] },
//     handoff: ["asks_for_call", "ready_to_pay"],
//     products: { approve: [ids], dismiss: [ids] } }
// Hours and hand-off are saved with the setup row; applying them to follow-up and chat settings is the next step.
export function validateAnswers(body) {
    const out = {};
    const hours = body?.hours;
    if (hours !== undefined) {
        const days = Array.isArray(hours?.days) ? [...new Set(hours.days)] : null;
        if (!TIME.test(hours?.open || '') || !TIME.test(hours?.close || '') || !days || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
            return { error: 'invalid_hours' };
        }
        out.hours = { open: hours.open, close: hours.close, days };
    }
    if (body?.handoff !== undefined) {
        if (!Array.isArray(body.handoff) || body.handoff.some((r) => !HANDOFF_REASONS.includes(r))) return { error: 'invalid_handoff' };
        out.handoff = [...new Set(body.handoff)];
    }
    if (body?.products !== undefined) {
        const clean = (list) => (Array.isArray(list) ? list : []).filter((v) => (typeof v === 'string' && v.trim()) || Number.isSafeInteger(v));
        const approve = clean(body.products?.approve), dismiss = clean(body.products?.dismiss);
        if (approve.length > 200 || dismiss.length > 200) return { error: 'too_many_products' };
        if (approve.some((id) => dismiss.includes(id))) return { error: 'product_in_both_lists' };
        out.products = { approve, dismiss };
    }
    return { value: out };
}

