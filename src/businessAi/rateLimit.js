// A small in-memory sliding window per business, to protect spend. Resets when the server restarts, which is fine.
export function createRateLimiter({ max = 30, windowMs = 10 * 60_000, now = () => Date.now() } = {}) {
  const hits = new Map();
  return function take(key) {
    const t = now();
    const recent = (hits.get(key) ?? []).filter((at) => t - at < windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      return { ok: false, retryAfterSec: Math.ceil((windowMs - (t - recent[0])) / 1000) };
    }
    recent.push(t);
    hits.set(key, recent);
    return { ok: true };
  };
}
