// Transport for CurrentAliasResolver.fetchCanonicalAlias — "what does the hub call node <id> now?"
//
// It used to read the whole network's GET /api/status (full projection) every 30 s per node and
// pick its own row by node_id. On production that was ~3 req/s of ~91 KB gzip responses, ~4% of a
// Hub core, to read one row. Hubs that advertise `status_node_id` in /health `capabilities` accept
// ?node_id=<id>, and with light=1 return just that row (carrying node_id). This module uses that
// when advertised and falls back to the old full read otherwise.
//
//   - Hub advertises the flag   → GET /api/status?node_id=<id>&light=1 (one small request).
//     • a row with our node_id  → its alias
//     • an empty list           → null (the hub doesn't know this node yet). No full read: the filter
//                                 runs under the same scope, so the full read can't find it either.
//     • rows, none of them ours → the hub ignored the param (flag and behaviour disagree): stop
//                                 trusting the flag until the next probe and do the full read now.
//     • non-2xx                 → full read now (same as an old hub).
//   - No flag / /health fails   → full read, exactly as before.
//
// The /health probe is cached for PROBE_TTL_MS so a hub upgrade (or rollback) is picked up without
// restarting the node, at one tiny /health read per node per probe period.
export const STATUS_NODE_ID_CAPABILITY = "status_node_id";
export const PROBE_TTL_MS = 10 * 60_000;

type StatusRow = { node_id?: string; alias?: string };

export type StatusAliasFetcherOptions = {
  hubUrl: string;
  /** Read on every request: the node's token can be refreshed while it runs. */
  token?: () => string | undefined;
  networkId?: string;
  timeoutMs?: number;
  probeTtlMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

export function createStatusAliasFetcher(opts: StatusAliasFetcherOptions): (nodeId: string) => Promise<string | null> {
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 2500;
  const probeTtlMs = opts.probeTtlMs ?? PROBE_TTL_MS;
  let supported: boolean | null = null;
  let probedAt = 0;

  async function get(url: string, auth: boolean): Promise<Response> {
    const headers: Record<string, string> = { Accept: "application/json" };
    const token = auth ? opts.token?.() : undefined;
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      return await doFetch(url, { headers, signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function hubSupportsNodeIdFilter(): Promise<boolean> {
    if (supported !== null && now() - probedAt < probeTtlMs && now() >= probedAt) return supported;
    probedAt = now();
    try {
      const res = await get(`${opts.hubUrl}/health`, false);
      const body = res.ok ? ((await res.json()) as { capabilities?: unknown }) : null;
      supported = Array.isArray(body?.capabilities) && body!.capabilities.includes(STATUS_NODE_ID_CAPABILITY);
    } catch {
      supported = false;
    }
    return supported;
  }

  const statusUrl = (extra: string) => {
    const params = [opts.networkId ? `network_id=${encodeURIComponent(opts.networkId)}` : "", extra].filter(Boolean).join("&");
    return `${opts.hubUrl}/api/status${params ? `?${params}` : ""}`;
  };

  async function fullRead(nodeId: string): Promise<string | null> {
    const res = await get(statusUrl(""), true);
    if (!res.ok) return null;
    const body = (await res.json()) as { sessions?: StatusRow[] };
    return body.sessions?.find((s) => s.node_id === nodeId)?.alias ?? null;
  }

  return async (nodeId: string) => {
    try {
      if (await hubSupportsNodeIdFilter()) {
        const res = await get(statusUrl(`node_id=${encodeURIComponent(nodeId)}&light=1`), true);
        if (res.ok) {
          const rows = ((await res.json()) as { sessions?: StatusRow[] }).sessions;
          if (Array.isArray(rows)) {
            const mine = rows.find((s) => s.node_id === nodeId);
            if (mine) return mine.alias ?? null;
            if (rows.length === 0) return null;
            supported = false;
          }
        }
      }
      return await fullRead(nodeId);
    } catch {
      return null;
    }
  };
}
