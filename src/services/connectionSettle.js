// How a whatsapp_sessions row settles. The row has three states:
//   connected - Evolution confirms WhatsApp is open
//   pending   - WhatsApp is (or is about to be) connected but the backend has not
//               confirmed it yet, e.g. right after pairing, or a missed webhook
//   (deleted) - only when Evolution CONFIRMS the number is disconnected
// A webhook is only a hint to go and ask Evolution; what Evolution answers is
// what gets written, so webhooks arriving late or out of order cannot flip anything.

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const STATE_MAP = {
    open: 'open', connected: 'open',
    close: 'close', closed: 'close', disconnected: 'close',
    connecting: 'connecting',
};

// Evolution's connectionState payload -> 'open' | 'connecting' | 'close' | null
export function normaliseEvolutionState(payload) {
    const raw = String(payload?.instance?.state ?? payload?.state ?? '').toLowerCase();
    return STATE_MAP[raw] ?? null;
}

// A connection.update webhook's state -> 'open' | 'connecting' | 'close'.
// Anything else (unknown, empty) is treated as transient.
export function webhookStateOf(state) {
    return STATE_MAP[String(state || '').toLowerCase()] ?? 'connecting';
}

// evolution: 'open' | 'connecting' | 'close' | 'missing' (instance not found) | null (unreachable)
export function decideSettle({ webhookState, evolution, existingStatus }) {
    if (evolution === 'open') return { action: 'connected' };
    if (evolution === 'close' || evolution === 'missing') return { action: 'disconnect' };
    if (evolution === 'connecting') {
        // A reconnect blip on a confirmed session is not a reason to stop sending.
        return { action: existingStatus === 'connected' ? 'keep' : 'pending' };
    }
    // Evolution unreachable: never delete, never downgrade. Trust a webhook that says open.
    if (webhookState === 'open') return { action: 'connected' };
    if (webhookState === 'connecting' && !existingStatus) return { action: 'pending' };
    return { action: 'keep' };
}

// Reads Evolution's state; if it says closed, waits and reads again so a reconnect in
// progress is not mistaken for a disconnect. Returns the last read.
export async function readConfirmedState(read, { delayMs = 4000, wait = sleep } = {}) {
    const first = await read();
    if (first !== 'close' && first !== 'missing') return first;
    await wait(delayMs);
    return read();
}
