import { supabase } from '../config/supabase.js';
import { debugLog } from '../services/debugConsole.js';
import { createStore } from './store.js';
import { createOrchestrator } from './orchestrator.js';
import { createBrainCaller } from './brainClient.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

// The brain is the sasa-brain edge function. The gates in the orchestrator run first, so with the business switch OFF
// (the default) this never calls it.
const handle = createOrchestrator({
  store: createStore(supabase),
  brain: createBrainCaller({ url: SUPABASE_URL, serviceKey: SERVICE_KEY }),
  log: debugLog,
});

// Called by the webhook after an incoming message is saved. Must never throw into the webhook.
export function triggerChatAi(input) {
  handle(input).catch((error) => {
    debugLog('error', 'Chat AI', 'Chat AI could not process a message', { businessId: input.businessId, error: error.message });
  });
}
