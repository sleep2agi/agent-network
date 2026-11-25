/**
 * Match a node alias against Hub `GET /api/stats/sse`'s `sessions` map.
 *
 * Hub keys every active SSE stream as `${networkId || "global"}:${alias}`
 * (see server/src/push.ts:clientKey). Checking bare `sessions[alias]` missed
 * all real Hub keys, causing `anet node ls` to render `○` for live nodes and
 * `sseAllConnected()` to always return `"no"`.
 *
 * Cross-network isolation: when `networkId` is specified, only `${networkId}:${alias}`
 * (or a legacy unprefixed `alias` key) matches — never `${otherNetwork}:${alias}`.
 */
export function sseConnectionCountForAlias(
  sessions: Record<string, number> | null | undefined,
  alias: string,
  networkId?: string | null,
): number {
  if (!alias || !sessions || typeof sessions !== "object") return 0;
  const net = typeof networkId === "string" && networkId.trim() ? networkId.trim() : null;
  if (net) {
    const scoped = sessions[`${net}:${alias}`];
    if (typeof scoped === "number" && scoped > 0) return scoped;
  } else {
    const globalScoped = sessions[`global:${alias}`];
    if (typeof globalScoped === "number" && globalScoped > 0) return globalScoped;
  }
  const bare = sessions[alias];
  return typeof bare === "number" && bare > 0 ? bare : 0;
}

export function isAliasSseConnected(
  sessions: Record<string, number> | null | undefined,
  alias: string,
  networkId?: string | null,
): boolean {
  return sseConnectionCountForAlias(sessions, alias, networkId) >= 1;
}
