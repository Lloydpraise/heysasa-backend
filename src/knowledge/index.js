import { supabase } from '../config/supabase.js';
import { logEvent } from '../services/debugConsole.js';
import { requireBusinessAuth } from '../middleware/businessAuth.js';
import { billAiUsage } from '../services/aiBilling.js';
import { canAffordAssistant } from '../businessAi/billing.js';
import { createFileAi } from './openaiFiles.js';
import { createExtractor } from './extract.js';
import { createKnowledgeService } from './service.js';
import { createKnowledgeRouter } from './routes.js';

export const KNOWLEDGE_RUNNER = 'knowledge_analysis';

const log = (level, message, metadata = {}) => logEvent({
    level: level === 'warn' ? 'warn' : level,
    area: 'knowledge',
    event: 'knowledge.activity',
    message,
    business_id: metadata.businessId ?? null,
    details: metadata.details ?? {},
});

// pdf-parse and mammoth are loaded only when a PDF or a Word file is analysed.
// 'pdf-parse/lib/pdf-parse.js' (not the package root) avoids a debug routine in the package's index that reads a test file.
const loadPdfParse = async () => (await import('pdf-parse/lib/pdf-parse.js')).default;
const loadMammoth = async () => { const m = await import('mammoth'); return m.default ?? m; };

// Wires Knowledge to the real database and OpenAI. In index.js:
//   const knowledge = createKnowledgeForApp(); app.use('/knowledge', knowledge.router); knowledge.start();
export function createKnowledgeForApp() {
    const apiKey = process.env.OPENAI_API_KEY;
    const service = createKnowledgeService({
        supabase, log,
        canAfford: (businessId) => canAffordAssistant(supabase, businessId),
        makeAi(businessId, accountId = null) {
            const ai = createFileAi({
                apiKey,
                onUsage: ({ model, promptTokens, cachedTokens, completionTokens }) => {
                    billAiUsage(supabase, { businessId, accountId, runner: KNOWLEDGE_RUNNER, model, promptTokens, cachedTokens, completionTokens })
                        .catch((e) => log('error', `knowledge billing failed: ${e.message}`, { businessId }));
                },
            });
            return { ai, extractor: createExtractor({ ai, loadPdfParse, loadMammoth, log: (l, m) => log(l, m, { businessId }) }) };
        },
    });
    return {
        router: createKnowledgeRouter({ auth: requireBusinessAuth, service }),
        service,
        // A restart can interrupt an analysis: pick up anything still marked 'processing' shortly after boot, then now and then.
        start() {
            const run = () => service.resumeStuck().catch((e) => log('warn', `knowledge resume failed: ${e.message}`));
            setTimeout(run, 20_000).unref?.();
            setInterval(run, 10 * 60_000).unref?.();
        },
    };
}
