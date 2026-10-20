// Tells people when a number drops, so follow-ups do not quietly stop while everyone assumes
// everything is running. WhatsApp connections blink off and on all the time, so nothing is sent
// unless the number is still gone after a short grace period, and no business is told more than
// once every 6 hours.
//
// Two audiences:
//  - the business owner (owner_phone, falling back to phone), when there is a number to tell
//  - you (LLOYD_PHONE), on every real drop, with WhatsApp's close code when we have it. This is also
//    what covers a business with no owner phone saved, which used to be silent.
import { supabase } from '../config/supabase.js';
import { logEvent } from './debugConsole.js';
import { sendPlatformMessage } from '../../followup-engine/src/sender-baileys/evolutionSender.js';

const GRACE_MS = 2 * 60_000;
const REPEAT_MS = 6 * 60 * 60_000;
const lastNoticeAt = new Map();

export function scheduleDisconnectNotice({ businessId, instanceName, reason = null }) {
    const timer = setTimeout(() => {
        checkAndNotify(businessId, instanceName, reason).catch((error) => {
            logEvent({ level: 'warn', area: 'connection', event: 'connection.owner_notice_error', message: error.message, details: { businessId } });
        });
    }, GRACE_MS);
    if (typeof timer.unref === 'function') timer.unref();
}

const reasonText = (reason) => {
    if (reason?.code !== null && reason?.code !== undefined) return `code ${reason.code}${reason.meaning ? `: ${reason.meaning}` : ''}`;
    if (reason?.text) return reason.text;
    return 'WhatsApp gave no reason';
};

// Your own alert. Never throws and never routes a failure back into an alerting area.
async function alertOperator({ businessId, name, instanceName, reason, ownerOutcome }) {
    const phone = process.env.LLOYD_PHONE;
    if (!phone) return { ok: false, error: 'LLOYD_PHONE not set' };
    const when = new Date().toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' });
    const text = `⚠️ HeySasa: ${name} (${businessId}) WhatsApp disconnected\nReason: ${reasonText(reason)}\nInstance: ${instanceName}\nOwner: ${ownerOutcome}\n${when}`;
    try {
        const result = await sendPlatformMessage(phone, text);
        return result ?? { ok: true };
    } catch (error) {
        console.error(`[DisconnectNotice] Could not alert operator: ${error.message}`);
        return { ok: false, error: error.message };
    }
}

async function checkAndNotify(businessId, instanceName, reason) {
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
        logEvent({ level: 'error', area: 'connection', event: 'connection.heysasa_disconnected', message: `The HeySasa WhatsApp number disconnected (${reasonText(reason)})`, details: { businessId, instanceName, status_code: reason?.code ?? null } });
        return;
    }

    lastNoticeAt.set(businessId, Date.now());

    const to = business.owner_phone || business.phone;
    let ownerOutcome;
    if (!to) {
        ownerOutcome = 'not told (no owner phone saved)';
        logEvent({ level: 'warn', area: 'connection', event: 'connection.owner_notice_no_phone', message: `${business.name} disconnected but has no owner phone to tell (${reasonText(reason)})`, details: { businessId, instanceName, status_code: reason?.code ?? null } });
    } else {
        const link = process.env.APP_URL ? `\nReconnect here: ${process.env.APP_URL}` : '\nOpen HeySasa and reconnect your WhatsApp.';
        const text = `Hi, your WhatsApp for ${business.name} has disconnected, so HeySasa cannot send follow-ups until it is connected again.${link}\n(If you disconnected on purpose, you can ignore this.)`;
        const result = await sendPlatformMessage(to, text);
        ownerOutcome = result?.ok ? 'told' : `could not be told (${result?.error ?? 'unknown'})`;
        logEvent({
            level: result?.ok ? 'info' : 'warn', area: 'connection',
            event: result?.ok ? 'connection.owner_notified' : 'connection.owner_notice_failed',
            message: result?.ok ? `Told ${business.name} their WhatsApp disconnected` : `Could not tell ${business.name}: ${result?.error ?? 'unknown'}`,
            details: { businessId, instanceName },
        });
    }

    const operator = await alertOperator({ businessId, name: business.name, instanceName, reason, ownerOutcome });
    logEvent({
        level: operator?.ok ? 'info' : 'warn', area: 'connection',
        event: operator?.ok ? 'connection.operator_alerted' : 'connection.operator_alert_failed',
        message: operator?.ok ? `Alerted you that ${business.name} disconnected (${reasonText(reason)})` : `Could not alert you about ${business.name}: ${operator?.error ?? 'unknown'}`,
        details: { businessId, instanceName },
    });
}
