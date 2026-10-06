// Safety net for whatsapp_sessions. A row is 'connected' (Evolution confirms it),
// 'pending' (WhatsApp is connected or about to be, the backend has not confirmed it
// yet) or deleted (only once Evolution confirms the number is disconnected).
// Webhooks can be missed or reordered (backend restart, slow Supabase lookup, DNS
// blip), so every INTERVAL we ask Evolution directly:
//   - pending/connecting row, Evolution says 'open'  -> promote to 'connected'
//   - connected row, Evolution says closed or gone, and still so after a re-check
//     -> run the normal disconnect handling (pause campaigns, notify, delete)
// Anything Evolution cannot confirm (unreachable, still connecting) is left alone.
import { supabase } from '../config/supabase.js';
import { summariseClose } from './connectionDiagnostics.js';
import { logEvent } from './debugConsole.js';
import { readConfirmedState, sleep } from './connectionSettle.js';
import { handleConfirmedDisconnect, readEvolutionState, withInstanceLock } from './webhookHandler.js';

const INTERVAL_MS = Number(process.env.CONNECTION_RECONCILE_MS || 60_000);
const CONFIRM_DELAY_MS = Number(process.env.CLOSE_CONFIRM_DELAY_MS || 4000);
const SETTLE_MS = 20_000; // leave brand-new rows alone, the webhook is probably still landing
const PLACEHOLDER_STATUSES = ['pending', 'connecting'];

export async function reconcileConnections({
    now = Date.now(),
    read = readEvolutionState,
    disconnect = handleConfirmedDisconnect,
    wait = sleep,
} = {}) {
    const { data: sessions, error } = await supabase
        .from('whatsapp_sessions')
        .select('id, business_id, instance_name, status, updated_at, session_data')
        .in('status', [...PLACEHOLDER_STATUSES, 'connected']);
    if (error) throw error;

    let promoted = 0;
    let disconnected = 0;
    for (const session of sessions || []) {
        if (!session.instance_name) continue;
        if (now - Date.parse(session.updated_at) < SETTLE_MS) continue;
        try {
            const state = await read(session.instance_name);

            if (PLACEHOLDER_STATUSES.includes(session.status) && state === 'open') {
                // Guarded on the old status so a webhook that landed meanwhile is not clobbered.
                const { data: updated, error: updateError } = await supabase
                    .from('whatsapp_sessions')
                    .update({
                        status: 'connected',
                        session_data: { ...(session.session_data || {}), qr_code: null, pairing_code: null, evolution_state: 'open', confirmed_at: new Date().toISOString() },
                        updated_at: new Date().toISOString(),
                    })
                    .eq('id', session.id)
                    .eq('status', session.status)
                    .select('id');
                if (updateError) throw updateError;
                if (updated?.length) {
                    promoted += 1;
                    logEvent({
                        level: 'warn', area: 'connection', event: 'connection.reconciled',
                        message: `Evolution reports ${session.instance_name} open but the session said ${session.status}: corrected to connected`,
                        business_id: session.business_id, entity_id: session.instance_name,
                        details: { was: session.status, evolution_state: state },
                    });
                }
            } else if (session.status === 'connected' && (state === 'close' || state === 'missing')) {
                const didDisconnect = await withInstanceLock(session.instance_name, async () => {
                    const confirmed = await readConfirmedState(() => read(session.instance_name), { delayMs: CONFIRM_DELAY_MS, wait });
                    if (confirmed !== 'close' && confirmed !== 'missing') return false;
                    // A webhook may have handled it while we waited.
                    const { data: still } = await supabase.from('whatsapp_sessions').select('id, status').eq('id', session.id).maybeSingle();
                    if (still?.status !== 'connected') return false;
                    const info = {
                        state: 'close', instance: session.instance_name, statusCode: null,
                        reasonText: `Evolution reports the instance ${confirmed === 'missing' ? 'no longer exists' : 'closed'} (found by the connection reconciler)`,
                        meaning: null, raw: { source: 'reconciler', evolution_state: confirmed },
                    };
                    logEvent({
                        level: 'warn', area: 'connection', event: 'connection.reconcile_disconnect',
                        message: `${summariseClose(info)} (no close webhook was received)`,
                        business_id: session.business_id, entity_id: session.instance_name,
                        details: { evolution_state: confirmed },
                    });
                    await disconnect({ info, businessId: session.business_id, instanceName: session.instance_name });
                    return true;
                });
                if (didDisconnect) disconnected += 1;
            }
        } catch (err) {
            logEvent({
                level: 'error', area: 'connection', event: 'connection.reconcile_session_failed',
                message: `Reconcile failed for ${session.instance_name}: ${err?.message || err}`,
                business_id: session.business_id, entity_id: session.instance_name,
            });
        }
    }
    return { checked: sessions?.length || 0, promoted, disconnected };
}

export function startConnectionReconciler() {
    const timer = setInterval(() => {
        reconcileConnections().catch((err) => {
            logEvent({ level: 'error', area: 'connection', event: 'connection.reconcile_failed', message: `Connection reconcile failed: ${err?.message || err}` });
        });
    }, INTERVAL_MS);
    timer.unref?.();
    logEvent({ level: 'info', area: 'system', event: 'connection.reconciler_started', message: `Connection reconciler running every ${Math.round(INTERVAL_MS / 1000)}s` });
}
