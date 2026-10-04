import { supabase } from '../config/supabase.js';
import { debugLog } from '../services/debugConsole.js';
import { createStore } from './store.js';
import { createOrchestrator } from './orchestrator.js';

// Phase 1: no brain yet, so this only evaluates the gates. Phase 2 passes the brain in here.
const handle = createOrchestrator({ store: createStore(supabase), brain: null, log: debugLog });

// Called by the webhook after an incoming message is saved. Must never throw into the webhook.
export function triggerChatAi(input) {
  handle(input).catch((error) => {
    debugLog('error', 'Chat AI', 'Chat AI could not process a message', { businessId: input.businessId, error: error.message });
  });
}
