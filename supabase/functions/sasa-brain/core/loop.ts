// The model loop: ask the model, run the tools it asks for (together, waiting for all of them), give the results
// back, repeat until it writes the message. The model call and the tool runner are passed in, so this file has
// no network code and can be tested with scripted fakes.

import type { ToolCall, ToolResult } from './tools.ts';

// deno-lint-ignore no-explicit-any
export type ModelCall = (body: Record<string, any>) => Promise<any>;

export type Usage = { input: number; cached: number; output: number };
export type Step = {
  round: number; thoughts: string;
  calls: Array<{ name: string; arguments: string; output: string; ok: boolean; ms: number; not_run?: boolean }>;
};
export type LoopResult = {
  text: string; steps: Step[]; thoughts: string; usage: Usage; lastResponseId: string | null; rounds: number; hitLimit: boolean;
};

// deno-lint-ignore no-explicit-any
export function parseResponse(res: any) {
  const calls: ToolCall[] = [];
  const thoughts: string[] = [];
  const texts: string[] = [];
  for (const item of res?.output ?? []) {
    if (item.type === 'function_call') {
      calls.push({ call_id: item.call_id, name: item.name, arguments: item.arguments ?? '' });
    } else if (item.type === 'reasoning') {
      for (const s of item.summary ?? []) if (s?.text) thoughts.push(String(s.text));
    } else if (item.type === 'message') {
      for (const c of item.content ?? []) if (c?.type === 'output_text' && c.text) texts.push(String(c.text));
    }
  }
  const usage = res?.usage ?? {};
  return {
    calls, thoughts: thoughts.join('\n'), text: texts.join('').trim(),
    usage: { input: usage.input_tokens ?? 0, cached: usage.input_tokens_details?.cached_tokens ?? 0, output: usage.output_tokens ?? 0 } as Usage,
  };
}

export async function runLoop(opts: {
  callModel: ModelCall; model: string; instructions: string; tools: unknown[];
  // deno-lint-ignore no-explicit-any
  input: any[]; previousResponseId?: string | null;
  executeCalls: (calls: ToolCall[]) => Promise<ToolResult[]>;
  maxRounds?: number; effort?: string; cacheKey?: string;
  // deno-lint-ignore no-explicit-any
  extraInput?: () => any[];
  noTools?: boolean;
}): Promise<LoopResult> {
  const maxRounds = opts.maxRounds ?? 6;
  const steps: Step[] = [];
  const usage: Usage = { input: 0, cached: 0, output: 0 };
  const allThoughts: string[] = [];
  let previous = opts.previousResponseId ?? null;
  let input = opts.input;
  let text = '';
  let round = 0;
  let hitLimit = false;

  for (; round < maxRounds; round++) {
    const lastRound = round === maxRounds - 1;
    const res = await opts.callModel({
      model: opts.model,
      instructions: opts.instructions,
      tools: opts.tools,
      tool_choice: opts.noTools || lastRound ? 'none' : 'auto',
      parallel_tool_calls: true,
      input,
      ...(previous ? { previous_response_id: previous } : {}),
      ...(opts.effort ? { reasoning: { effort: opts.effort, summary: 'auto' } } : {}),
      ...(opts.cacheKey ? { prompt_cache_key: opts.cacheKey } : {}),
      store: true,
    });
    const parsed = parseResponse(res);
    usage.input += parsed.usage.input; usage.cached += parsed.usage.cached; usage.output += parsed.usage.output;
    if (parsed.thoughts) allThoughts.push(parsed.thoughts);
    previous = res?.id ?? previous;

    if (!parsed.calls.length) {
      text = parsed.text;
      steps.push({ round, thoughts: parsed.thoughts, calls: [] });
      round++;
      break;
    }
    if (lastRound) { hitLimit = true; steps.push({ round, thoughts: parsed.thoughts, calls: [] }); round++; break; }

    const results = await opts.executeCalls(parsed.calls);
    steps.push({
      round, thoughts: parsed.thoughts,
      calls: results.map((r, i) => ({ name: r.name, arguments: parsed.calls[i].arguments, output: r.output, ok: r.ok, ms: r.ms, ...(r.not_run ? { not_run: true } : {}) })),
    });
    input = [
      ...results.map((r) => ({ type: 'function_call_output', call_id: r.call_id, output: r.output })),
      ...(opts.extraInput?.() ?? []),
    ];
  }

  return { text, steps, thoughts: allThoughts.join('\n---\n'), usage, lastResponseId: previous, rounds: round, hitLimit };
}
