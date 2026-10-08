// Small shared helpers for the agent tools. Nothing here talks to the network.

// A ToolError carries a message that is safe and kind enough to show the owner as it is. Any other error is treated
// as a bug: it is logged, and the owner only sees a short "that didn't work" line.
export class ToolError extends Error {}

export const plural = (n, one, many = `${one}s`) => `${Number(n).toLocaleString('en-KE')} ${Number(n) === 1 ? one : many}`;
export const clip = (text, max) => { const t = String(text ?? ''); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };
export const money = (n, currency = 'KES') => `${currency ? `${currency} ` : ''}${Math.round(Number(n) || 0).toLocaleString('en-KE')}`;
export const isUuid = (v) => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);
export const uniq = (list) => [...new Set((list ?? []).filter((v) => v !== null && v !== undefined && v !== ''))];
export const chunk = (list, size = 200) => { const out = []; for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size)); return out; };
export const asText = (v) => (typeof v === 'string' ? v.trim() : '');
export const daysSince = (iso, now = new Date()) => (iso ? Math.max(0, (now.getTime() - new Date(iso).getTime()) / 86_400_000) : null);
export const round1 = (n) => Math.round(Number(n) * 10) / 10;

// A database error is a bug as far as the owner is concerned: throw it as a plain Error (the runner hides the detail).
export function must(result, what) {
  if (result?.error) throw new Error(`${what}: ${result.error.message}`);
  return result?.data;
}

// Reads every row of a query in pages. `build(from, to)` must return a fresh query with .range(from, to) applied.
export async function fetchAll(build, { page = 1000, max = 20000 } = {}) {
  const rows = [];
  for (let from = 0; from < max; from += page) {
    const data = must(await build(from, from + page - 1), 'read rows') ?? [];
    rows.push(...data);
    if (data.length < page) break;
  }
  return rows;
}

// Counts how often each value appears, biggest first. `values` may hold strings or lists of strings.
export function topCounts(values, limit = 8) {
  const counts = new Map();
  for (const v of values) {
    for (const item of Array.isArray(v) ? v : [v]) {
      const key = String(item ?? '').trim().toLowerCase();
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([name, count]) => ({ name, count }));
}

// Keeps the last 30 minutes of searches so a list can be made from "the 42 people I just found" without the model
// ever having to repeat 42 ids. Searches are private to one business.
export function createSearchCache({ ttlMs = 30 * 60_000, max = 300, now = () => Date.now() } = {}) {
  const map = new Map();
  let seq = 0;
  const sweep = () => {
    const t = now();
    for (const [key, v] of map) if (t - v.at > ttlMs) map.delete(key);
    while (map.size > max) map.delete(map.keys().next().value);
  };
  return {
    put(businessId, ids, meta = {}) { sweep(); const id = `s${now().toString(36)}${(++seq).toString(36)}`; map.set(id, { businessId, ids, meta, at: now() }); return id; },
    get(businessId, id) { sweep(); const v = map.get(id); return v && v.businessId === businessId ? v : null; },
  };
}

// Works out which leads a tool call means: a search the assistant just ran, or ids it was given.
export function resolveLeadIds(ctx, { search_id: searchId, lead_ids: leadIds }, { max = 500 } = {}) {
  let ids = [];
  if (searchId) {
    const found = ctx.searches.get(ctx.businessId, searchId);
    if (!found) throw new ToolError('That search has expired. Run the search again first.');
    ids = found.ids;
  } else if (Array.isArray(leadIds)) {
    ids = uniq(leadIds);
  }
  if (ids.length > max) throw new ToolError(`That is ${plural(ids.length, 'lead')}, which is too many for one go. The limit is ${max}. Narrow it down first.`);
  return ids;
}
