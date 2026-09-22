// Sends you a WhatsApp message the moment something serious breaks,
// instead of you finding out from a customer. Fires off the same event
// stream the console reads (debugConsole.js's onEvent), so this needs no
// separate polling.
import { onEvent, logEvent } from './debugConsole.js';
import { sendPlatformMessage } from '../../followup-engine/src/sender-baileys/evolutionSender.js';

// system: crashes. sender: send failures worth knowing about immediately
// (the worker already retries transient ones quietly — see
// sendFailures.js — so what reaches 'error' level here is meant to be
// alert-worthy, not routine). connection: a business's number dropping.
const ALERT_AREAS = new Set(['system', 'sender', 'connection']);
const RATE_LIMIT_MS = 15 * 60_000;
const lastSentByKey = new Map();

export function startAlerts() {
    const phone = process.env.LLOYD_PHONE;
    if (!phone) {
        logEvent({ level: 'warn', area: 'system', event: 'alerts.disabled', message: 'LLOYD_PHONE not set — error alerts will not be sent' });
        return;
    }
    if (!process.env.PLATFORM_EVOLUTION_INSTANCE) {
        logEvent({ level: 'warn', area: 'system', event: 'alerts.disabled', message: 'PLATFORM_EVOLUTION_INSTANCE not set — error alerts will not be sent' });
        return;
    }

    onEvent((event) => {
        if (event.level !== 'error') return;
        if (!ALERT_AREAS.has(event.area)) return;

        const key = `${event.area}:${event.event}`;
        const now = Date.now();
        const last = lastSentByKey.get(key) || 0;
        if (now - last < RATE_LIMIT_MS) return;
        lastSentByKey.set(key, now);

        const when = new Date(event.ts).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' });
        const text = `⚠️ HeySasa alert\n${event.area} — ${event.event}\n${event.message}\n${when}`;
        sendPlatformMessage(phone, text).catch((error) => {
            // Deliberately not routed back through logEvent for area
            // 'sender'/'system' — a failing alert send must never trigger
            // another alert about itself.
            console.error(`[Alerts] Failed to send WhatsApp alert: ${error.message}`);
        });
    });

    logEvent({ level: 'info', area: 'system', event: 'alerts.enabled', message: `Alerts will be sent to ${phone}` });
}
