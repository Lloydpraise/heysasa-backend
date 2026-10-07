// The model loop: ask the model, run the tools it asks for (together), hand the results back, repeat until it writes
// the answer. The model call and the tool runner are passed in, so this file has no network code.
//
// onRound(round) fires before each model call; onDelta(text) streams output text; onTools(calls) fires when the model
// asked for tools (so the UI can say what is happening); onUsage(response) fires after EVERY response (for billing).

export function parseResponse(res) {
  const calls = [];
  const texts = [];
  for (const item of res?.output ?? []) {
    if (item.type === 'function_call') calls.push({ call_id: item.call_id, name: item.name, arguments: item.arguments ?? '' });
    else if (item.type === 'message') {
      for (const c of item.content ?? []) if (c?.type === 'output_text' && c.text) texts.push(String(c.text));
    }
  }
  const u = res?.usage ?? {};
  return { calls, text: texts.join('').trim(), usage: { input: u.input_tokens ?? 0, cached: u.input_tokens_details?.cached_tokens ?? 0, output: u.output_tokens ?? 0 } };
}

export async function runLoop({
  callModel, model, instructions, tools, input, runCalls, effort = 'low', cacheKey, maxRounds = 4, maxOutputTokens = 1800,
  onRound = () => {}, onDelta = () => {}, onTools = () => {}, onUsage = () => {},
}) {
  const usage = { input: 0, cached: 0, output: 0 };
  const toolsUsed = [];
  let previous = null;
  let nextInput = input;
  let text = '';
  let rounds = 0;
  let hitLimit = false;

  for (; rounds < maxRounds; rounds++) {
    const lastRound = rounds === maxRounds - 1;
    onRound(rounds);
    const res = await callModel({
      model,
      instructions,
      tools,
      tool_choice: lastRound ? 'none' : 'auto',
      parallel_tool_calls: true,
      input: nextInput,
      max_output_tokens: maxOutputTokens,
      ...(previous ? { previous_response_id: previous } : {}),
      ...(effort ? { reasoning: { effort } } : {}),
      ...(cacheKey ? { prompt_cache_key: cacheKey } : {}),
      store: true,
    }, onDelta);
    const parsed = parseResponse(res);
    usage.input += parsed.usage.input; usage.cached += parsed.usage.cached; usage.output += parsed.usage.output;
    previous = res?.id ?? previous;
    await onUsage(res);

    if (!parsed.calls.length) { text = parsed.text; rounds++; break; }
    if (lastRound) { hitLimit = true; rounds++; break; }

    onTools(parsed.calls);
    const results = await runCalls(parsed.calls);
    for (const r of results) toolsUsed.push(r.name);
    nextInput = results.map((r) => ({ type: 'function_call_output', call_id: r.call_id, output: r.output }));
  }
  return { text, usage, rounds, hitLimit, toolsUsed, lastResponseId: previous };
}
