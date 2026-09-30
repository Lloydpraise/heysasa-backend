// Tells a business owner on WhatsApp when their number drops, so follow-ups do not
// quietly stop while they assume everything is running. WhatsApp connections blink
// off and on all the time, so nothing is sent unless the number is still gone after
// a short grace period, and no business is told more than once every 6 hours.
import { supabase } from '../config/supabase.js';
import { logEvent } from './debugConsole.js';
import { sendPlatformMessage } from '../../followup-engine/src/sender-baileys/evolutionSender.js';

const GRACE_MS = 2 * 60_000;
const REPEAT_MS = 6 * 60 * 60_000;
const lastNoticeAt = new Map();

export function scheduleDisconnectNotice({ businessId, instanceName }) {
    const timer = setTimeout(() => {
        checkAndNotify(businessId, instanceName).catch((error) => {
            logEvent({ level: 'warn', area: 'connection', event: 'connection.owner_notice_error', message: error.message, details: { businessId } });
        });
    }, GRACE_MS);
    if (typeof timer.unref === 'function') timer.unref();
}

async function checkAndNotify(businessId, instanceName) {
    // Came back during the grace period? Then there is nothing to report.
    const { data: live } = await supabase.from('whatsapp_sessions').select('id')
        .eq('business_id', businessId).eq('instance_name', instanceName).eq('status', 'connected').limit(1);
    if (live?.length) return;

    if (Date.now() - (lastNoticeAt.get(businessId) || 0) < REPEAT_MS) return;

    const { data: business } = await supabase.from('businesses')
        .select('name, owner_phone, phone, business_type').eq('business_id', businessId).maybeSingle();
    if (!business) return;

    // HeySasa's own number is the one that sends these notices, so it cannot tell itself.
    // This shows on the console and reaches you through the normal error alerts.
    if (business.business_type === 'heysasa') {
        logEvent({ level: 'error', area: 'connection', event: 'connection.heysasa_disconnected', message: 'The HeySasa WhatsApp number disconnected', details: { businessId, instanceName } });
        return;
    }

    const to = business.owner_phone || business.phone;
    if (!to) {
        logEvent({ level: 'warn', area: 'connection', event: 'connection.owner_notice_no_phone', message: `${business.name} disconnected but has no owner phone to tell`, details: { businessId } });
        return;
    }

    const link = process.env.APP_URL ? `\nReconnect here: ${process.env.APP_URL}` : '\nOpen HeySasa and reconnect your WhatsApp.';
    const text = `Hi, your WhatsApp for ${business.name} has disconnected, so HeySasa cannot send follow-ups until it is connected again.${link}\n(If you disconnected on purpose, you can ignore this.)`;

    lastNoticeAt.set(businessId, Date.now());
    const result = await sendPlatformMessage(to, text);
    logEvent({
        level: result?.ok ? 'info' : 'warn', area: 'connection',
        event: result?.ok ? 'connection.owner_notified' : 'connection.owner_notice_failed',
        message: result?.ok ? `Told ${business.name} their WhatsApp disconnected` : `Could not tell ${business.name}: ${result?.error ?? 'unknown'}`,
        details: { businessId, instanceName },
    });
}
