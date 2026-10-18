import { supabase } from '../config/supabase.js';
import { logEvent } from '../services/debugConsole.js';
import { requireBusinessAuth } from '../middleware/businessAuth.js';
import { sendPlatformMessage } from '../../followup-engine/src/sender-baileys/evolutionSender.js';
import { createHandoffNotifier } from './notifier.js';
import { createHandoffRouter } from './routes.js';

const log = (level, event, details = {}) => logEvent({ level, area: 'handoff', event: `handoff.${event.replace(/^handoff\./, '')}`, message: event, business_id: details.businessId ?? null, details });

// Wires handoffs to the real database and the HeySasa WhatsApp number. In index.js:
//   const handoff = createHandoffForApp(); app.use('/handoff', handoff.router); handoff.start();
export function createHandoffForApp() {
    const appUrl = process.env.APP_URL || '';
    const send = (to, text) => sendPlatformMessage(to, text);
    const notifier = createHandoffNotifier({ supabase, send, appUrl, log });
    return {
        router: createHandoffRouter({ auth: requireBusinessAuth, supabase, send, appUrl }),
        notifier,
        start: () => notifier.start(),
    };
}
