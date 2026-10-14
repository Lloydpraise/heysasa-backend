// Real dependencies for the ready-message notifier.
import { supabase } from '../config/supabase.js';
import { logEvent } from '../services/debugConsole.js';
import { sendPlatformMessage } from '../../followup-engine/src/sender-baileys/evolutionSender.js';
import { createReadyNotifier } from './readyNotifier.js';

export function buildReadyNotifier() {
    return createReadyNotifier({
        appUrl: process.env.APP_URL || '',
        log: (level, event, details) => logEvent({ level, area: 'setup', event, message: event, details }),
        send: (to, text) => sendPlatformMessage(to, text),
        async listWaiting() {
            const { data } = await supabase.from('business_setup').select('business_id')
                .is('ready_message_sent_at', null).in('status', ['home_ready', 'finishing', 'done']).not('home_ready_at', 'is', null).limit(50);
            return data || [];
        },
        async getBusiness(id) {
            const { data } = await supabase.from('businesses').select('business_id, business_type, owner_phone, phone, followup_ai_enabled').eq('business_id', id).maybeSingle();
            return data || null;
        },
        async countPending(id) {
            const head = { count: 'exact', head: true };
            const [{ count: messages }, { count: playbooks }] = await Promise.all([
                supabase.from('follow_up_queue').select('id', head).eq('business_id', id).eq('approval_status', 'awaiting_approval'),
                supabase.from('ad_playbooks').select('id', head).eq('business_id', id).eq('status', 'review'),
            ]);
            return (messages || 0) + (playbooks || 0);
        },
        async markSent(id) {
            await supabase.from('business_setup').update({ ready_message_sent_at: new Date().toISOString() }).eq('business_id', id);
        },
    });
}
