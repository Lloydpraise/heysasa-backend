// The tool registry and the rules for running a batch of tool calls.

export type ToolRow = {
  name: string; business_id: string | null; description: string; parameters: Record<string, unknown>;
  kind: 'builtin' | 'rpc' | 'http'; target: string; phase: 'lookup' | 'write' | 'send';
};

export type ToolCall = { call_id: string; name: string; arguments: string };
export type ToolResult = { call_id: string; name: string; output: string; ok: boolean; ms: number; not_run?: boolean };

const MAX_OUTPUT_CHARS = 6000;
const TOOL_TIMEOUT_MS = 20_000;

// A business's own tool replaces a global tool with the same name. Sorted by name so the tool list
// is byte-identical from turn to turn, which is what lets OpenAI's prompt cache reuse it.
export function resolveTools(rows: ToolRow[], businessId: string): ToolRow[] {
  const byName = new Map<string, ToolRow>();
  for (const row of rows) {
    if (row.business_id && row.business_id !== businessId) continue;
    const existing = byName.get(row.name);
    if (!existing || (row.business_id && !existing.business_id)) byName.set(row.name, row);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function toModelTools(rows: ToolRow[]) {
  return rows.map((r) => ({ type: 'function', name: r.name, description: r.description, parameters: r.parameters, strict: false }));
}

const clip = (text: string) => (text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}... [cut]` : text);
const stringify = (value: unknown) => clip(typeof value === 'string' ? value : JSON.stringify(value));

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export type RunTool = (row: ToolRow, args: Record<string, unknown>) => Promise<unknown>;

// Rules:
//  - lookup and write tools run together, and we wait for all of them.
//  - a send tool (the customer will see it) never runs in the same step as other tools, because it may depend on
//    their results (send_products needs search_products). It is bounced with a message and the AI calls it again.
//  - several send calls in one step run one after another, never at the same time.
export async function executeBatch(calls: ToolCall[], tools: ToolRow[], run: RunTool): Promise<ToolResult[]> {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const hasNonSend = calls.some((c) => byName.get(c.name)?.phase !== 'send');

  const runOne = async (call: ToolCall): Promise<ToolResult> => {
    const started = Date.now();
    const row = byName.get(call.name);
    const done = (output: unknown, ok: boolean, extra: Partial<ToolResult> = {}): ToolResult =>
      ({ call_id: call.call_id, name: call.name, output: stringify(output), ok, ms: Date.now() - started, ...extra });

    if (!row) return done({ error: `There is no tool called "${call.name}".` }, false);
    let args: Record<string, unknown> = {};
    try {
      args = call.arguments ? JSON.parse(call.arguments) : {};
    } catch {
      return done({ error: 'The arguments were not valid JSON. Call the tool again with valid JSON.' }, false);
    }
    if (row.phase === 'send' && hasNonSend) {
      return done({ error: 'not_run', message: 'This tool was not run because other tools were called in the same step. Read their results, then call this tool again on its own.' }, false, { not_run: true });
    }
    try {
      return done(await withTimeout(run(row, args), TOOL_TIMEOUT_MS, call.name), true);
    } catch (error) {
      return done({ error: String((error as Error)?.message ?? error) }, false);
    }
  };

  const parallel = calls.filter((c) => byName.get(c.name)?.phase !== 'send');
  const sends = calls.filter((c) => byName.get(c.name)?.phase === 'send');
  const results = new Map<string, ToolResult>();

  for (const r of await Promise.all(parallel.map(runOne))) results.set(r.call_id, r);
  for (const call of sends) results.set(call.call_id, await runOne(call));

  return calls.map((c) => results.get(c.call_id)!);
}
