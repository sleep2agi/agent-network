// get_all_status response cache (perf).
//
// Production 2026-11-09: ~20 LLM agents each called get_all_status about once a
// minute (465 calls / 22 min). Every call re-read all ~400 sessions and built a
// ~580 KB JSON string (then wrapped/escaped again by MCP) — several MB of
// short-lived garbage per call. The Hub's event loop stalled 2–9 s every few
// seconds (663 stalls in ~2 h) and phone sends sat at 「发送中」.
//
// Identical requests within TTL_MS reuse one serialized response. The key is the
// caller's full read scope (which already encodes network + per-member
// restrictions) plus every filter, so two callers share an entry only when the
// SQL they would run is identical. Status that is ≤10 s stale is fine for a roster.
export const ALL_STATUS_TTL_MS = 10_000;
const MAX_ENTRIES = 256;
const cache = new Map<string, { at: number; text: string }>();

export function allStatusCacheKey(scope: unknown, filters: unknown): string {
  return JSON.stringify([scope, filters]);
}

/** Return the cached text for `key`, or build, store and return it. */
export function cachedAllStatus(key: string | null, build: () => string, now: () => number = Date.now): { text: string; hit: boolean } {
  if (key === null) return { text: build(), hit: false }; // uncacheable scope
  const t = now();
  const hit = cache.get(key);
  if (hit && t - hit.at < ALL_STATUS_TTL_MS) return { text: hit.text, hit: true };
  const text = build();
  if (cache.size >= MAX_ENTRIES) {
    for (const [k, v] of cache) if (t - v.at >= ALL_STATUS_TTL_MS) cache.delete(k);
    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  }
  cache.set(key, { at: t, text });
  return { text, hit: false };
}

/** Tests only. */
export function clearAllStatusCache(): void { cache.clear(); }
