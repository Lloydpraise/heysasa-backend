import { supabase } from '../config/supabase.js';
import { logEvent } from '../services/debugConsole.js';
import { createStore } from './store.js';
import { createNotes } from './notes.js';
import { createOrchestrator } from './orchestrator.js';
import { createAssistantRouter } from './routes.js';
import { requireBusinessAuth } from '../middleware/businessAuth.js';
import { makeEmbedder, makeStreamingModel } from './openai.js';
import { billEmbeddingUsage, billModelUsage, canAffordAssistant } from './billing.js';
import { createAgent } from './agent/index.js';

const log = (level, message, metadata = {}) => logEvent({
  level: level === 'warn' ? 'warn' : level,
  area: 'assistant',
  event: metadata.event ?? 'assistant.activity',
  message,
  business_id: metadata.businessId ?? null,
  duration_ms: metadata.durationMs ?? null,
  details: metadata.details ?? {},
});

// Wires Ask HeySasa to the real database and OpenAI. app.use('/assistant', assistantRouter) in index.js.
export function createAssistantRouterForApp() {
  const apiKey = process.env.OPENAI_API_KEY;
  const store = createStore(supabase);
  const embed = makeEmbedder({
    apiKey,
    onUsage: ({ businessId, model, promptTokens }) => { billEmbeddingUsage(supabase, { businessId, model, promptTokens }).catch((e) => log('error', `embedding billing failed: ${e.message}`)); },
  });
  const notes = createNotes({ store, embed, log });
  const agent = createAgent({ supabase, store, canAfford: (businessId) => canAffordAssistant(supabase, businessId), log });
  const handleChat = createOrchestrator({
    store, notes, embed, agent, callModel: makeStreamingModel({ apiKey }),
    canAfford: (businessId) => canAffordAssistant(supabase, businessId),
    billModel: (args) => billModelUsage(supabase, args),
    model: process.env.BUSINESS_ASSISTANT_MODEL || 'gpt-5-mini',
    effort: process.env.BUSINESS_ASSISTANT_EFFORT || 'low',
    log,
  });
  return createAssistantRouter({ auth: requireBusinessAuth, store, notes, handleChat, agent, skillsForBusiness: (id) => store.loadSkills(id), log });
}
