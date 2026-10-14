// The "Aha! set up is done" WhatsApp message. It goes out once per business, and only when there is something
// real to approve (so it is a win, not homework). Dependencies come in through `deps` so it can be tested.

export const READY_TEXT = (appUrl) =>
    `Aha! Set up is done. Now you can preview and approve your first follow-ups! Let's get these people buying!${appUrl ? `\n${appUrl}` : ''}`;

export function createReadyNotifier(deps) {
    const log = deps.log || (() => {});
    const loggedNoPhone = new Set();

    async function checkOnce() {
        let sent = 0;
        for (const setup of await deps.listWaiting()) {
            const id = setup.business_id;
            const business = await deps.getBusiness(id);
            if (!business || business.business_type === 'heysasa') continue;   // HeySasa's own number cannot message itself
            if (!business.followup_ai_enabled) continue;                         // nothing will be written until follow-ups are on
            if ((await deps.countPending(id)) < 1) continue;                     // no drafts yet: wait

            const to = business.owner_phone || business.phone;
            if (!to) {
                if (!loggedNoPhone.has(id)) { loggedNoPhone.add(id); log('warn', 'setup.ready_no_phone', { businessId: id }); }
                continue;
            }
            const result = await deps.send(to, READY_TEXT(deps.appUrl));
            if (result?.ok) { await deps.markSent(id); sent += 1; log('info', 'setup.ready_message_sent', { businessId: id }); }
            else log('warn', 'setup.ready_message_failed', { businessId: id, error: result?.error ?? 'unknown' });
        }
        return sent;
    }

    function start(intervalMs = 60_000) {
        const timer = setInterval(() => checkOnce().catch((error) => log('warn', 'setup.ready_check_failed', { error: String(error?.message || error) })), intervalMs);
        timer.unref?.();
        return timer;
    }

    return { checkOnce, start };
}
