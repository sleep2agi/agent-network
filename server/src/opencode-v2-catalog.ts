// Hub authorization for a native OpenCode V2 catalog read.
//
// The caller names a daemon and a child node. Identity, generation, and the
// project directory come from Hub rows. The queued payload has no URL,
// authorization, settings, headers, or body. The daemon reads its own
// already-running loopback and acks a whitelist snapshot.
//
// `status: "pending"` means the read was authorized and stored. It does not
// mean a daemon received the doorbell or produced a snapshot. Only
// `status: "ready"` is a snapshot, and that snapshot stays completeness
// unknown / invocation unverified.

import { resolve } from "node:path";
import { z } from "zod/v4";
import { db, uuidv4 } from "./db.js";
import { getUserNetworkRole } from "./auth.js";

const TTL_MS = 60_000;
const MAX_PENDING = 100;
const SECRET = /^(sk-|gh[pousr]_|github_pat_|xox[baprs]-|AKIA|AIza|ya29\.|glpat-)/i;

export const CATALOG_ERROR_CODES = [
  "invalid_target", "unauthorized", "unavailable", "invalid_response", "scope_mismatch", "too_large",
] as const;
export type CatalogErrorCode = (typeof CATALOG_ERROR_CODES)[number];

const identifier = z.string().min(1).max(512).refine(value => !/[\s\u0000-\u001f\u007f]/.test(value) && !SECRET.test(value));
const directoryText = z.string().min(1).max(1024).refine(value => value === resolve(value) && !/[\u0000-\u001f\u007f]/.test(value));

export const opencodeCatalogSnapshotSchema = z.object({
  scope: z.object({
    networkId: z.string().min(1).max(200),
    daemonId: z.string().min(1).max(200),
    directory: directoryText,
  }).strict(),
  source: z.literal("opencode-v2-api"),
  state: z.literal("snapshot"),
  invocationVerified: z.literal(false),
  completeness: z.literal("unknown"),
  observedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/),
  providers: z.array(z.object({
    id: identifier,
    activation: z.enum(["auto", "enabled", "disabled"]),
  }).strict()).max(20_000),
  models: z.array(z.object({
    providerId: identifier,
    id: identifier,
  }).strict()).max(20_000),
  defaultModel: z.object({ providerId: identifier, id: identifier }).strict().nullable(),
}).strict();

export type OpenCodeCatalogSnapshotWire = z.infer<typeof opencodeCatalogSnapshotSchema>;

export const opencodeCatalogAckSchema = z.object({
  request_id: z.string().min(1).max(200),
  error: z.enum(CATALOG_ERROR_CODES).optional(),
  snapshot: opencodeCatalogSnapshotSchema.optional(),
}).strict();

interface PendingCatalogRead {
  requestId: string;
  daemonNodeId: string;
  daemonAlias: string;
  networkId: string;
  nodeId: string;
  alias: string;
  directory: string | null;
  expiresAt: number;
  taken: boolean;
}

export interface StoredCatalogRead {
  requestId: string;
  networkId: string;
  daemonNodeId: string;
  nodeId: string;
  status: "pending" | "ready" | "failed" | "expired";
  error?: CatalogErrorCode;
  snapshot?: OpenCodeCatalogSnapshotWire;
  expiresAt: number;
}

const pending = new Map<string, PendingCatalogRead>();
const stored = new Map<string, StoredCatalogRead>();

export function resetOpenCodeCatalogForTest(): void {
  pending.clear();
  stored.clear();
}

export function expireOpenCodeCatalogForTest(requestId: string): void {
  // Just past the read deadline, still inside the retention window. Setting
  // the deadline to 0 would also drop the stored row and look like not_found.
  const expiredAt = Date.now() - 1;
  const row = pending.get(requestId);
  if (row) row.expiresAt = expiredAt;
  const result = stored.get(requestId);
  if (result) result.expiresAt = expiredAt;
}

function childNodeId(requestId: string): string | null {
  return requestId.startsWith("cr_") ? `node_${requestId.slice(3)}` : null;
}

function supervisorRole(snapshot: string | null): boolean {
  if (!snapshot) return false;
  try {
    const parsed = JSON.parse(snapshot) as { role?: unknown };
    return parsed.role === "host_supervisor";
  } catch {
    return false;
  }
}

function v2Flags(flagsJson: string): boolean {
  try {
    const flags = JSON.parse(flagsJson) as { opencodeGeneration?: unknown; opencodeUnsafeTools?: unknown };
    return flags.opencodeGeneration === "v2" && flags.opencodeUnsafeTools === true;
  } catch {
    return false;
  }
}

export interface QueueCatalogInput {
  callerUserId: string | null;
  callerIsNode: boolean;
  networkId: string | null;
  daemonNodeId: string;
  nodeId: string;
}

function evictExpired(now = Date.now()): void {
  for (const [id, row] of pending) {
    if (now > row.expiresAt) pending.delete(id);
  }
  for (const [id, row] of stored) {
    if (row.status === "pending" && now > row.expiresAt) row.status = "expired";
    if (now > row.expiresAt + TTL_MS) stored.delete(id);
  }
}

export function queueOpenCodeCatalogRead(input: QueueCatalogInput):
  | { ok: true; request_id: string; status: "pending"; daemon_alias: string; network_id: string }
  | { ok: false; error: string } {
  evictExpired();
  if (input.callerIsNode) return { ok: false, error: "user_token_required" };
  if (!input.callerUserId) return { ok: false, error: "auth_required" };
  if (!input.networkId) return { ok: false, error: "network_id_required" };
  const role = getUserNetworkRole(input.callerUserId, input.networkId);
  if (!role) return { ok: false, error: "access_denied" };
  if (pending.size >= MAX_PENDING) return { ok: false, error: "catalog_busy" };

  const daemon = db.get<{ node_id: string; alias: string; config_snapshot: string | null }>(
    `SELECT node_id, alias, config_snapshot FROM nodes WHERE node_id = ?1 AND network_id = ?2`,
    input.daemonNodeId, input.networkId,
  );
  if (!daemon) return { ok: false, error: "daemon_not_found" };
  if (!supervisorRole(daemon.config_snapshot)) return { ok: false, error: "daemon_not_supervisor" };

  const child = db.get<{ node_id: string }>(
    `SELECT node_id FROM nodes WHERE node_id = ?1 AND network_id = ?2`,
    input.nodeId, input.networkId,
  );
  if (!child) return { ok: false, error: "node_not_found" };

  const creates = db.all<{
    request_id: string; daemon_node_id: string; child_name: string; runtime: string;
    flags_json: string; workdir: string | null; status: string;
  }>(
    `SELECT request_id, daemon_node_id, child_name, runtime, flags_json, workdir, status
       FROM node_create_requests
      WHERE network_id = ?1 AND daemon_node_id = ?2 AND status IN ('succeeded', 'delivered')`,
    input.networkId, input.daemonNodeId,
  );
  const owned = creates.filter(row => childNodeId(row.request_id) === input.nodeId && row.daemon_node_id === input.daemonNodeId);
  if (owned.length !== 1) return { ok: false, error: "node_not_found" };
  const row = owned[0]!;
  if (row.runtime !== "opencode-cli" || !v2Flags(row.flags_json)) return { ok: false, error: "not_opencode_v2" };

  const requestId = `cat_${uuidv4()}`;
  const directory = typeof row.workdir === "string" && row.workdir.length > 0 ? row.workdir : null;
  const record: PendingCatalogRead = {
    requestId,
    daemonNodeId: daemon.node_id,
    daemonAlias: daemon.alias,
    networkId: input.networkId,
    nodeId: input.nodeId,
    alias: row.child_name,
    directory,
    expiresAt: Date.now() + TTL_MS,
    taken: false,
  };
  pending.set(requestId, record);
  stored.set(requestId, {
    requestId,
    networkId: input.networkId,
    daemonNodeId: daemon.node_id,
    nodeId: input.nodeId,
    status: "pending",
    expiresAt: record.expiresAt,
  });
  return { ok: true, request_id: requestId, status: "pending", daemon_alias: daemon.alias, network_id: input.networkId };
}

export function takeOpenCodeCatalogRequest(requestId: string, daemonNodeId: string):
  | { ok: true; request_id: string; node_id: string; alias: string; directory: string | null; scope: { networkId: string; daemonId: string } }
  | { ok: false; error: "catalog_request_unavailable" } {
  const row = pending.get(requestId);
  if (!row || row.daemonNodeId !== daemonNodeId || row.taken) return { ok: false, error: "catalog_request_unavailable" };
  if (Date.now() > row.expiresAt) {
    row.taken = true;
    const result = stored.get(requestId);
    if (result && result.status === "pending") result.status = "expired";
    return { ok: false, error: "catalog_request_unavailable" };
  }
  row.taken = true;
  return {
    ok: true,
    request_id: row.requestId,
    node_id: row.nodeId,
    alias: row.alias,
    directory: row.directory,
    scope: { networkId: row.networkId, daemonId: row.daemonNodeId },
  };
}

function consistent(snapshot: OpenCodeCatalogSnapshotWire): boolean {
  const providers = new Set<string>();
  for (const row of snapshot.providers) {
    if (providers.has(row.id)) return false;
    providers.add(row.id);
  }
  const models = new Set<string>();
  for (const row of snapshot.models) {
    if (!providers.has(row.providerId)) return false;
    const key = JSON.stringify([row.providerId, row.id]);
    if (models.has(key)) return false;
    models.add(key);
  }
  if (snapshot.defaultModel && !models.has(JSON.stringify([snapshot.defaultModel.providerId, snapshot.defaultModel.id]))) return false;
  return Buffer.byteLength(JSON.stringify(snapshot), "utf8") <= 2 * 1024 * 1024;
}

export function ackOpenCodeCatalog(daemonNodeId: string, body: unknown):
  | { ok: true; status: "ready" | "failed"; error?: CatalogErrorCode }
  | { ok: false; error: "catalog_request_unavailable" | "invalid_ack" } {
  const parsed = opencodeCatalogAckSchema.safeParse(body);
  if (!parsed.success) return { ok: false, error: "invalid_ack" };
  const ack = parsed.data;
  const hasSnapshot = ack.snapshot !== undefined;
  const hasError = ack.error !== undefined;
  if (hasSnapshot === hasError) return { ok: false, error: "invalid_ack" };
  const row = pending.get(ack.request_id);
  const result = stored.get(ack.request_id);
  if (!row || !result || row.daemonNodeId !== daemonNodeId || !row.taken) {
    return { ok: false, error: "catalog_request_unavailable" };
  }
  if (Date.now() > row.expiresAt || result.status !== "pending") {
    if (result.status === "pending") result.status = "expired";
    return { ok: false, error: "catalog_request_unavailable" };
  }
  if (ack.error) {
    result.status = "failed";
    result.error = ack.error;
    return { ok: true, status: "failed", error: ack.error };
  }
  const snapshot = ack.snapshot!;
  // A stored workdir must match. A null workdir (legacy create) has no
  // hub-side path to compare; the daemon binds that read to the project
  // directory it already owns. Hub does not see that filesystem.
  const directoryOk = row.directory ? resolve(snapshot.scope.directory) === resolve(row.directory) : true;
  if (snapshot.scope.networkId !== row.networkId || snapshot.scope.daemonId !== row.daemonNodeId || !directoryOk || !consistent(snapshot)) {
    result.status = "failed";
    result.error = "invalid_response";
    return { ok: true, status: "failed", error: "invalid_response" };
  }
  result.status = "ready";
  result.snapshot = snapshot;
  return { ok: true, status: "ready" };
}

export function getOpenCodeCatalogResult(input: {
  callerUserId: string | null;
  callerIsNode: boolean;
  networkId: string | null;
  requestId: string;
}):
  | { ok: true; status: "pending"; request_id: string }
  | { ok: true; status: "ready"; request_id: string; snapshot: OpenCodeCatalogSnapshotWire }
  | { ok: false; status?: "failed" | "expired"; error: string; request_id?: string } {
  if (input.callerIsNode) return { ok: false, error: "user_token_required" };
  if (!input.callerUserId) return { ok: false, error: "auth_required" };
  if (!input.networkId) return { ok: false, error: "network_id_required" };
  if (!getUserNetworkRole(input.callerUserId, input.networkId)) return { ok: false, error: "access_denied" };
  evictExpired();
  const result = stored.get(input.requestId);
  if (!result || result.networkId !== input.networkId) return { ok: false, error: "not_found" };
  if (result.status === "pending" && Date.now() > result.expiresAt) result.status = "expired";
  if (result.status === "pending") return { ok: true, status: "pending", request_id: result.requestId };
  if (result.status === "ready" && result.snapshot) {
    return { ok: true, status: "ready", request_id: result.requestId, snapshot: result.snapshot };
  }
  if (result.status === "expired") return { ok: false, status: "expired", error: "unavailable", request_id: result.requestId };
  return { ok: false, status: "failed", error: result.error || "unavailable", request_id: result.requestId };
}
