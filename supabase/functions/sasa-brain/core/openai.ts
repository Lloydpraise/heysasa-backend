// The two OpenAI calls the brain makes. Plain fetch, so it runs in an edge function and in tests with a fake fetch.

const BASE = 'https://api.openai.com/v1';
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

export type OpenAiDeps = { apiKey: string; fetch: typeof fetch; sleep: (ms: number) => Promise<void> };

async function post(deps: OpenAiDeps, path: string, body: unknown, timeoutMs: number) {
  let lastError = 'unknown error';
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await deps.fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deps.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return res.json();
    const text = await res.text().catch(() => '');
    lastError = `OpenAI ${path} returned ${res.status}: ${text.slice(0, 300)}`;
    if (!RETRY_STATUS.has(res.status)) break;
    await deps.sleep(1500);
  }
  throw new Error(lastError);
}

// deno-lint-ignore no-explicit-any
export const makeCallModel = (deps: OpenAiDeps) => (body: Record<string, any>) => post(deps, '/responses', body, 120_000);

export const EMBEDDING_MODEL = 'text-embedding-3-small';

export const makeEmbed = (deps: OpenAiDeps, onUsage?: (model: string, promptTokens: number) => void) => async (text: string): Promise<number[]> => {
  const data = await post(deps, '/embeddings', { model: EMBEDDING_MODEL, input: text.slice(0, 2000) }, 20_000);
  onUsage?.(EMBEDDING_MODEL, Number(data?.usage?.prompt_tokens ?? data?.usage?.total_tokens ?? 0));
  const vector = data?.data?.[0]?.embedding;
  if (!Array.isArray(vector)) throw new Error('OpenAI returned no embedding');
  return vector;
};
