// Pure helpers for the setup runner. No database, no network, easy to test.

export const FIRST_BUNDLE = 100;  // newest leads first: this is what makes Home ready in minutes
export const NEXT_BUNDLE = 500;   // then the rest in the analyser's normal batch size

// ids must already be ordered newest first. Returns an array of id arrays.
export function planBundles(ids, { first = FIRST_BUNDLE, rest = NEXT_BUNDLE } = {}) {
    const list = [...new Set((ids || []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))];
    if (!list.length) return [];
    const bundles = [list.slice(0, first)];
    for (let i = first; i < list.length; i += rest) bundles.push(list.slice(i, i + rest));
    return bundles;
}

// History arrives from WhatsApp in several webhook chunks. It is "settled" once the contact count
// has stayed the same for quietMs. samples: [{ at, count }], oldest first.
export function historySettled({ samples, now, quietMs = 15_000, minCount = 1 }) {
    if (!samples?.length) return false;
    const last = samples[samples.length - 1];
    if (last.count < minCount) return false;
    let since = last.at;
    for (let i = samples.length - 1; i >= 0 && samples[i].count === last.count; i--) since = samples[i].at;
    return now - since >= quietMs;
}
