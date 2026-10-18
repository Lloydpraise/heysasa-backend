// Sends the WhatsApp alert for each new handoff, from the HeySasa number to the people the handoff is for.
// The chat AI (an edge function) writes a row to handoff_events with the recipients already decided; this picks the
// rows up. Dependencies come in through `deps` so it can be tested.

const clip = (t, n) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const MAX_ATTEMPTS = 3;

export function handoffMessage(event, appUrl = '') {
    const who = clip(event.contact_name, 60) || (event.contact_phone ? `+${event.contact_phone}` : 'A customer');
    const lines = [
        `${event.urgency === 'high' ? '🚨 Urgent handoff' : '🔔 Handoff'} — ${who} needs you.`,
        event.rule_label ? `Case: ${clip(event.rule_label, 80)}` : null,
        event.reason ? `Why: ${clip(event.reason, 160)}` : null,
        event.summary ? clip(event.summary, 500) : null,
        event.contact_phone ? `Chat with them: https://wa.me/${event.contact_phone}` : null,
        appUrl ? `Or open HeySasa: ${appUrl}` : null,
    ];
    return lines.filter(Boolean).join('\n');
}

export function createHandoffNotifier({ supabase, send, appUrl = '', log = () => {}, now = () => new Date() }) {
    async function finish(id, patch) {
        await supabase.from('handoff_events').update(patch).eq('id', id);
    }

    async function notify(event) {
        const people = Array.isArray(event.recipients) ? event.recipients : [];
        if (!people.length) {
            await finish(event.id, { notify_status: 'skipped', notify_error: 'no_recipient_number', notify_attempts: event.notify_attempts + 1 });
            log('warn', 'handoff.no_recipient', { businessId: event.business_id });
            return { sent: 0, failed: 0 };
        }
        const text = handoffMessage(event, appUrl);
        let sent = 0;
        const errors = [];
        for (const person of people) {
            const result = await send(person.phone, text).catch((e) => ({ ok: false, error: String(e?.message || e) }));
            if (result?.ok) sent += 1; else errors.push(`${person.name}: ${result?.error || 'not sent'}`);
        }
        const attempts = event.notify_attempts + 1;
        if (sent === people.length) {
            await finish(event.id, { notify_status: 'sent', notified_at: now().toISOString(), notify_attempts: attempts, notify_error: null });
        } else if (attempts >= MAX_ATTEMPTS) {
            await finish(event.id, { notify_status: sent ? 'partial' : 'failed', notify_attempts: attempts, notify_error: errors.join('; ').slice(0, 500) });
            log('warn', 'handoff.alert_failed', { businessId: event.business_id, error: errors.join('; ') });
        } else {
            await finish(event.id, { notify_attempts: attempts, notify_error: errors.join('; ').slice(0, 500) });   // stays 'pending': tried again next round
        }
        return { sent, failed: people.length - sent };
    }

    async function checkOnce() {
        const { data, error } = await supabase.from('handoff_events').select('*').eq('notify_status', 'pending').order('created_at', { ascending: true }).limit(20);
        if (error) { log('warn', 'handoff.poll_failed', { error: error.message }); return 0; }
        let handled = 0;
        for (const event of data ?? []) { await notify(event); handled += 1; }
        return handled;
    }

    function start(intervalMs = 8_000) {
        const timer = setInterval(() => checkOnce().catch((e) => log('warn', 'handoff.poll_failed', { error: String(e?.message || e) })), intervalMs);
        timer.unref?.();
        return timer;
    }

    return { checkOnce, notify, start };
}
