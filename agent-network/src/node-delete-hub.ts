// #516 — `anet node delete` also removes the node's row on the Hub.
//
// Before this, delete removed only the local files; the Hub row stayed and the
// node showed "offline" in every client forever (#502 audit: a deleted node's
// row was still listed after `Deleted "<alias>"`).
//
// 🔴 The Hub's DELETE /api/nodes/:ref matches node_id OR node_name OR alias.
//    Aliases are reused (the Hub accepts duplicate aliases in one network, and a
//    second machine can create a node with the same name), so deleting by alias
//    could remove SOMEONE ELSE's row. This module only ever deletes by the local
//    config's node_id, and only after the Hub has listed a row whose node_id is
//    exactly that value. A row that merely shares the alias is reported and left
//    alone.

export type HubRemoval =
  /** The Hub had a row with exactly this node_id and deleted it. */
  | { kind: "removed"; nodeId: string }
  /** No row with this node_id. `otherRows` share the alias but belong to other nodes — untouched. */
  | { kind: "absent"; nodeId: string; otherRows: string[] }
  /** Nothing to do on a Hub: no Hub configured, or a legacy config without node_id. */
  | { kind: "skipped"; reason: "no-hub" | "no-node-id" }
  /** Unreachable / HTTP error / not logged in. Local deletion still happens; caller exits non-zero. */
  | { kind: "failed"; nodeId: string; reason: string };

export type HubRemovalInput = {
  hub?: string;
  token?: string;
  nodeId?: string;
  alias?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

function describeHttpFailure(status: number, body: any): string {
  const err = typeof body?.error === "string" ? body.error : "";
  if (status === 401) return `the Hub rejected the login (HTTP 401${err ? `: ${err}` : ""}) — run: anet login`;
  if (status === 403) return `the Hub refused (HTTP 403${err ? `: ${err}` : ""}) — this login cannot delete that node`;
  return `HTTP ${status}${err ? `: ${err}` : ""}`;
}

async function readJson(res: Response): Promise<any> {
  try { return await res.json(); } catch { return null; }
}

export async function removeNodeFromHub(input: HubRemovalInput): Promise<HubRemoval> {
  const hub = (input.hub || "").replace(/\/+$/, "");
  if (!hub) return { kind: "skipped", reason: "no-hub" };
  const nodeId = input.nodeId || "";
  if (!nodeId) return { kind: "skipped", reason: "no-node-id" };
  const doFetch = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 10_000;
  const headers: Record<string, string> = input.token ? { Authorization: `Bearer ${input.token}` } : {};
  const call = (url: string, method: string) =>
    doFetch(url, { method, headers, signal: AbortSignal.timeout(timeoutMs) });

  try {
    // 1. Is there a row with EXACTLY this node_id? (the server filters too; we re-check the field)
    const listRes = await call(`${hub}/api/nodes?node_id=${encodeURIComponent(nodeId)}`, "GET");
    const list = await readJson(listRes);
    if (!listRes.ok || !list || !Array.isArray(list.nodes)) {
      return { kind: "failed", nodeId, reason: listRes.ok ? "the Hub answered, but not with a node list" : describeHttpFailure(listRes.status, list) };
    }
    const mine = list.nodes.filter((r: any) => r && r.node_id === nodeId);
    if (mine.length === 0) {
      let otherRows: string[] = [];
      if (input.alias) {
        try {
          const aliasRes = await call(`${hub}/api/nodes?alias=${encodeURIComponent(input.alias)}`, "GET");
          const aliasList = await readJson(aliasRes);
          if (aliasRes.ok && Array.isArray(aliasList?.nodes)) {
            otherRows = aliasList.nodes
              .map((r: any) => String(r?.node_id ?? ""))
              .filter((id: string) => id && id !== nodeId);
          }
        } catch { /* informational only */ }
      }
      return { kind: "absent", nodeId, otherRows };
    }

    // 2. Delete by node_id — never by alias.
    const delRes = await call(`${hub}/api/nodes/${encodeURIComponent(nodeId)}`, "DELETE");
    const del = await readJson(delRes);
    if (delRes.status === 404) return { kind: "absent", nodeId, otherRows: [] };
    if (!delRes.ok || !del?.ok) return { kind: "failed", nodeId, reason: describeHttpFailure(delRes.status, del) };
    if (del.node_id && del.node_id !== nodeId) {
      return { kind: "failed", nodeId, reason: `the Hub reported deleting node_id ${del.node_id}, not ${nodeId}` };
    }
    return { kind: "removed", nodeId };
  } catch (e: any) {
    const msg = e?.name === "TimeoutError" ? `no answer within ${Math.round(timeoutMs / 1000)}s` : (e?.message || String(e));
    return { kind: "failed", nodeId, reason: `could not reach ${hub} (${msg})` };
  }
}

/** The exact command that retries only the Hub half once the local files are gone. */
export function hubRetryCommand(nodeId: string, hub?: string): string {
  const q = (v: string) => /^[A-Za-z0-9._:/@%+=-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`;
  return `anet node delete ${q(nodeId)} --hub-only${hub ? ` --hub ${q(hub)}` : ""}`;
}

/** Lines to print for a removal result. `warn` lines go to stderr. */
export function describeHubRemoval(r: HubRemoval, ctx: { displayName: string; hub?: string }): { info: string[]; warn: string[] } {
  switch (r.kind) {
    case "removed":
      return { info: [ctx.displayName === r.nodeId ? `[anet] Removed node_id ${r.nodeId} from the Hub` : `[anet] Removed "${ctx.displayName}" (node_id ${r.nodeId}) from the Hub`], warn: [] };
    case "absent": {
      const info = [`[anet] The Hub has no row for node_id ${r.nodeId} — nothing to remove there`];
      if (r.otherRows.length) {
        info.push(`[anet] Left untouched: ${r.otherRows.length} Hub row(s) named "${ctx.displayName}" belong to other node_id(s): ${r.otherRows.join(", ")}`);
      }
      return { info, warn: [] };
    }
    case "skipped":
      return r.reason === "no-hub"
        ? { info: [`[anet] No Hub configured — only the local files were removed`], warn: [] }
        : { info: [], warn: [`[anet] ⚠ This node's config has no node_id, so its Hub row (if any) cannot be matched safely and was not touched. Remove it from the app/dashboard node list if it is still shown.`] };
    case "failed":
      return {
        info: [],
        warn: [
          `[anet] ⚠ Local files were deleted, but the Hub row was NOT removed: ${r.reason}`,
          `[anet]   The node will keep showing as offline until it is removed. Retry with:`,
          `[anet]     ${hubRetryCommand(r.nodeId, ctx.hub)}`,
        ],
      };
  }
}
