import { randomBytes } from "node:crypto";
import { db } from "./db.js";
import { getUserNetworkRole, resolveToken, sessionIdleDays } from "./auth.js";
import { isAgentRestricted } from "./agent-access.js";
import { resolveNodeCaller } from "./create-node.js";
import { pushEvent } from "./push.js";

type Identity = { session_id: string; binding_id: string };
type Credential = { token_id: string; user_id: string; network_id: string | null;
  bound_node_id: string | null; scope: string; role: string };
type Node = { node_id: string; network_id: string; owner_user_id: string | null; alias: string };
type Bridge = Identity & { tokenId: string; expires: number; retired: Set<string> };
type Entry = Identity & { request_id: string; operation: "state" | "background";
  networkId: string; nodeId: string; tokenId: string; requester: string; expires_at: number;
  status: "pending" | "in_progress" | "done" | "failed" | "unknown" | "expired";
  result?: unknown; error?: string };
const TTL = 15_000, LEASE = 75_000, CAP = 1024, HISTORY = 64;
const ROOT = "/api/node-session-control";
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const ERRORS = new Set(["unavailable", "changed", "unsupported", "invalid_response", "request_invalid",
  "request_expired", "request_limit"].map(s => `session_control_${s}`).concat("session_background_outcome_unknown"));
const keys = (o: Record<string, unknown>, allowed: string[]) => Object.keys(o).every(k => allowed.includes(k));
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === "string" && ID.test(v);
const identity = (v: unknown): v is Identity => object(v) && keys(v, ["session_id", "binding_id"])
  && id(v.session_id) && id(v.binding_id);
const same = (a: Identity, b: Identity) => a.session_id === b.session_id && a.binding_id === b.binding_id;
const generation = (token: string, v: Identity) => JSON.stringify([token, v.session_id, v.binding_id]);
const fail = (error: string, status = 409) => Response.json({ ok: false, error }, { status });
const ok = (value: object) => Response.json({ ok: true, ...value });

// Recheck stored identities without storing plaintext bearer tokens. The SQL
// mirrors resolveToken's expiry/revoke/idle rules; membership is checked below.
function credential(tokenId: string): Credential | null {
  const days = sessionIdleDays();
  return db.get<Credential>(`SELECT t.token_id,t.user_id,t.network_id,t.bound_node_id,t.scope,u.role
    FROM api_tokens t JOIN users u ON u.user_id=t.user_id WHERE t.token_id=?1
    AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>datetime('now'))
    AND NOT (t.scope='user' AND t.network_id IS NULL AND ?2>0
      AND COALESCE(t.last_used_at,t.created_at)<datetime('now',?3))`,
    tokenId, days, `-${Math.round(days * 86400)} seconds`) ?? null;
}
function node(nodeId: string): Node | null {
  return db.get<Node>("SELECT node_id,network_id,owner_user_id,alias FROM nodes WHERE node_id=?1", nodeId) ?? null;
}
function human(tokenId: string, n: Node): boolean {
  const c = credential(tokenId);
  if (!c || c.network_id || !n.network_id) return false;
  const role = getUserNetworkRole(c.user_id, n.network_id);
  return !!role && role !== "viewer" && !isAgentRestricted(c.user_id, n.network_id)
    && (c.user_id === n.owner_user_id || role === "owner" || role === "admin" || c.role === "admin");
}
function bound(tokenId: string, n?: Node | null): Node | null {
  const c = credential(tokenId);
  if (!c?.bound_node_id || !c.network_id || c.scope !== "network") return null;
  const target = n ?? node(c.bound_node_id);
  if (!target || c.bound_node_id !== target.node_id || c.network_id !== target.network_id
    || !getUserNetworkRole(c.user_id, c.network_id) || isAgentRestricted(c.user_id, c.network_id)) return null;
  const caller = resolveNodeCaller(tokenId);
  return caller.ok && caller.kind === "node" && caller.nodeId === target.node_id
    && caller.networkId === target.network_id ? target : null;
}
async function body(req: Request): Promise<Record<string, unknown> | null> {
  const reader = req.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 8192) { await reader.cancel(); return null; }
      chunks.push(part.value);
    }
    const v: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return object(v) ? v : null;
  } catch { return null; }
}
function state(value: unknown, e: Entry): boolean {
  return object(value) && keys(value, ["session_id", "binding_id", "supported", "active", "can_request_background", "observed_at"])
    && same(value as Identity, e) && typeof value.supported === "boolean" && typeof value.active === "boolean"
    && typeof value.can_request_background === "boolean" && typeof value.observed_at === "number"
    && Number.isFinite(value.observed_at) && value.observed_at > 0
    && (!value.can_request_background || (value.supported && value.active));
}
function validResult(v: unknown, e: Entry): boolean {
  if (e.operation === "state") return state(v, e);
  return object(v) && keys(v, ["outcome", "state"])
    && (v.outcome === "request_processed" || v.outcome === "already_idle") && state(v.state, e);
}

/** One finite, process-local relay per Hub boot. Restart loses requests (404),
 * never replays them. Multi-worker deployments require process affinity.
 * A claim authorizes one delivery, not proof that any tool moved to background.
 */
export function createNodeSessionControlRelay() {
  const bridges = new Map<string, Bridge>();
  const entries = new Map<string, Entry>();
  const key = (n: Node) => JSON.stringify([n.network_id, n.node_id]);
  function close(e: Entry, error: string) {
    e.status = e.status === "in_progress" ? "unknown" : "failed";
    e.error = e.status === "unknown" ? "session_background_outcome_unknown" : error;
  }
  function refresh(e: Entry, now: number) {
    if (e.status !== "pending" && e.status !== "in_progress") return;
    if (now >= e.expires_at) {
      e.status = e.status === "in_progress" ? "unknown" : "expired";
      e.error = e.status === "unknown" ? "session_background_outcome_unknown" : "session_control_request_expired";
      return;
    }
    const n = node(e.nodeId), b = n && bridges.get(key(n));
    if (!n || n.network_id !== e.networkId || !human(e.requester, n) || !bound(e.tokenId, n)) {
      close(e, "session_control_unavailable");
    } else if (!b || b.expires <= now || b.tokenId !== e.tokenId || !same(b, e)) {
      close(e, "session_control_changed");
    }
  }
  function sweep(now: number) {
    for (const [k, e] of entries) {
      refresh(e, now);
      if (now > e.expires_at + 60_000) entries.delete(k);
    }
  }
  return async function handle(req: Request, url: URL): Promise<Response | null> {
    if (url.pathname !== ROOT && !url.pathname.startsWith(`${ROOT}/`)) return null;
    // Header-only, exact credential kinds; no legacy master/dev-open fallback.
    const raw = req.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1] ?? "";
    const auth = /^(utok_|ntok_)/.test(raw) ? resolveToken(raw) : null;
    if (!auth?.tokenId) return fail("session_control_unavailable", 401);
    const tokenId = auth.tokenId;
    const isHuman = raw.startsWith("utok_") && !auth.networkId;
    const suffix = url.pathname.slice(ROOT.length);
    try {
      if (req.method === "GET" && /^\/(bg|sc)_\d{13}_[A-Za-z0-9_-]{8,64}$/.test(suffix)) {
        const e = entries.get(suffix.slice(1));
        // Unknown/restarted Hub and unauthorized reads reveal no request data.
        if (!isHuman) return fail("session_control_unavailable", 403);
        if (!e) return fail("session_control_unavailable", 404);
        const n = node(e.nodeId);
        if (!n || url.searchParams.get("network_id") !== e.networkId || n.network_id !== e.networkId || !human(tokenId, n)) {
          return fail("session_control_unavailable", 403);
        }
        refresh(e, Date.now());
        return ok({ request_id: e.request_id, status: e.status,
          ...(e.result === undefined ? {} : { result: e.result }), ...(e.error ? { error: e.error } : {}) });
      }
      if (req.method !== "POST") return fail("session_control_request_invalid", 405);
      const v = await body(req);
      if (!v) return fail("session_control_request_invalid", 400);
      const now = Date.now(); sweep(now);
      if (!suffix) {
        if (!isHuman) return fail("session_control_unavailable", 403);
        if (!keys(v, ["network_id", "node_id", "operation", "expected"]) || !id(v.network_id) || !id(v.node_id)
          || (v.operation !== "state" && v.operation !== "background")
          || (v.expected !== undefined && !identity(v.expected)) || (v.operation === "background" && !identity(v.expected))) {
          return fail("session_control_request_invalid", 400);
        }
        const n = node(v.node_id);
        if (!n || n.network_id !== v.network_id || !human(tokenId, n)) return fail("session_control_unavailable", 403);
        const b = bridges.get(key(n));
        if (!b || b.expires <= now || !bound(b.tokenId, n)) return fail("session_control_unavailable");
        if (v.expected && !same(v.expected as Identity, b)) return fail("session_control_changed");
        if (entries.size >= CAP || [...entries.values()].some(e => e.nodeId === n.node_id
          && e.networkId === n.network_id && (e.status === "pending" || e.status === "in_progress"))) {
          return fail("session_control_request_limit", 429);
        }
        const request_id = `${v.operation === "background" ? "bg" : "sc"}_${now}_${randomBytes(18).toString("base64url")}`;
        entries.set(request_id, { session_id: b.session_id, binding_id: b.binding_id, request_id,
          operation: v.operation, networkId: n.network_id, nodeId: n.node_id, tokenId: b.tokenId,
          requester: tokenId, expires_at: now + TTL, status: "pending" });
        pushEvent(n.alias, { type: "session_control", request_id }, n.network_id);
        return ok({ request_id, status: "pending", expires_at: now + TTL });
      }
      if (isHuman || !raw.startsWith("ntok_")) return fail("session_control_unavailable", 403);
      const n = bound(tokenId);
      if (!n) return fail("session_control_unavailable", 403);
      const k = key(n), b = bridges.get(k);
      if (suffix === "/bridge") {
        if (!identity(v)) return fail("session_control_request_invalid", 400);
        const g = generation(tokenId, v);
        if (b?.retired.has(g)) return fail("session_control_changed");
        if (b && (b.tokenId !== tokenId || !same(b, v))) {
          if (b.retired.size >= HISTORY) return fail("session_control_request_limit", 429);
          b.retired.add(generation(b.tokenId, b));
          for (const e of entries.values()) if (e.nodeId === n.node_id && e.networkId === n.network_id
            && (e.status === "pending" || e.status === "in_progress")) close(e, "session_control_changed");
        }
        if (!b && bridges.size >= CAP) return fail("session_control_request_limit", 429);
        bridges.set(k, { ...v, tokenId, expires: now + LEASE, retired: b?.retired ?? new Set() });
        return ok({ expires_at: now + LEASE });
      }
      if (!b || b.expires <= now || b.tokenId !== tokenId) return fail("session_control_changed");
      if (suffix === "/pull") {
        if (!identity(v)) return fail("session_control_request_invalid", 400);
        if (!same(b, v)) return fail("session_control_changed");
        const e = [...entries.values()].find(e => e.nodeId === n.node_id && e.networkId === n.network_id && e.status === "pending");
        if (!e) return ok({ request: null });
        refresh(e, now);
        if (e.status !== "pending") return ok({ request: null });
        // No await between authority recheck, claim, and response. Never requeue.
        e.status = "in_progress";
        return ok({ request: { request_id: e.request_id, operation: e.operation,
          session_id: e.session_id, binding_id: e.binding_id, expires_at: e.expires_at } });
      }
      if (/^\/(bg|sc)_\d{13}_[A-Za-z0-9_-]{8,64}\/ack$/.test(suffix)) {
        if (!keys(v, ["session_id", "binding_id", "status", "result", "error"]) || !id(v.session_id) || !id(v.binding_id)
          || (v.status !== "done" && v.status !== "failed")) return fail("session_control_request_invalid", 400);
        const e = entries.get(suffix.split("/")[1]);
        if (!e) return fail("session_control_unavailable", 404);
        if (e.nodeId !== n.node_id || e.networkId !== n.network_id || e.tokenId !== tokenId || !same(e, v as Identity)
          || !same(b, e)) return fail("session_control_changed");
        refresh(e, now);
        if (e.status !== "in_progress") return fail("session_control_request_expired");
        if (v.status === "done" && validResult(v.result, e) && v.error === undefined) {
          e.status = "done"; e.result = v.result;
        } else if (v.status === "failed" && typeof v.error === "string" && ERRORS.has(v.error) && v.result === undefined) {
          e.status = "failed"; e.error = v.error;
        } else {
          // Invalid/untrusted runtime replies never become success or leak raw errors.
          e.status = "unknown"; e.error = "session_control_invalid_response";
          return fail(e.error, 400);
        }
        return ok({ request_id: e.request_id, status: e.status });
      }
      return fail("session_control_request_invalid", 404);
    } catch { return fail("session_control_unavailable", 503); }
  };
}
