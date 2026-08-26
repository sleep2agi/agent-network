import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DbAdapter } from "./db-adapter.js";
import { indexEntryPath, pathForExistingBlob, validateIndexEntry } from "./uploads.js";
import type { SideThreadAttachmentRef, SideThreadCapability } from "./side-thread.js";
import {
  DurableSideThreadCommandPort,
  SideThreadCommandStore,
  handleSideThreadCommandRequest,
  type NodeCommandActor,
} from "./side-thread-command-transport.js";

const GRANT_TTL_MS = 5 * 60_000;

type GrantRow = {
  grant_id: string; file_id: string; network_id: string; node_id: string;
  sha256: string; size: number; media_type: string; expires_at: number;
};

/** Production-only SideThread transport. It remains absent unless the public
 * feature flag is enabled and the configured DB can provide atomic claims. */
export function createProductionSideThreadTransport(db: DbAdapter, now = Date.now, ackWaitMs = 2_500) {
  const store = new SideThreadCommandStore(db, now);
  db.exec(`CREATE TABLE IF NOT EXISTS side_thread_attachment_grants (
    grant_id TEXT PRIMARY KEY, file_id TEXT NOT NULL, network_id TEXT NOT NULL,
    node_id TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL,
    media_type TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
  )`);
  const port = new DurableSideThreadCommandPort({
    store,
    networkForNode(nodeId) {
      return db.get<{ network_id: string | null }>("SELECT network_id FROM nodes WHERE node_id=?1", nodeId)?.network_id ?? null;
    },
    capabilityForNode(nodeId) {
      const row = db.get<{ config_snapshot: string | null }>("SELECT config_snapshot FROM nodes WHERE node_id=?1", nodeId);
      if (!row?.config_snapshot) return unsupported("runtime");
      try {
        const cap = JSON.parse(row.config_snapshot)?.side_thread_capability;
        return validateCapability(cap) ? cap : unsupported("runtime");
      } catch { return unsupported("runtime"); }
    },
    grantAttachment(nodeId, ref) { return issueGrant(db, nodeId, ref, now); },
    // The dedicated node consumer polls asynchronously. Give its durable ACK
    // a bounded window so the coordinator can advance fork→start atomically;
    // timeout remains an honest ambiguous result, never a task fallback.
    ackWaitMs,
  });
  return {
    store,
    port,
    handle: (input: { req: Request; url: URL; actor: NodeCommandActor | null }) =>
      handleSideThreadCommandRequest({ ...input, store, port }),
    attachment: (req: Request, url: URL, actor: NodeCommandActor | null) =>
      serveGrant(db, req, url, actor, now),
  };
}

function issueGrant(db: DbAdapter, nodeId: string, ref: SideThreadAttachmentRef, now: () => number): Record<string, unknown> {
  // Grants are deliberately short-lived and must not become an unbounded
  // metadata cache. Lazy sweeping keeps the hot download path read-only while
  // ensuring every new issuance bounds accumulated expired rows.
  db.run("DELETE FROM side_thread_attachment_grants WHERE expires_at < ?1", [now()]);
  const node = db.get<{ network_id: string | null }>("SELECT network_id FROM nodes WHERE node_id=?1", nodeId);
  if (!node?.network_id) throw new Error("SideThread attachment node scope unavailable");
  const indexPath = indexEntryPath(ref.fileId);
  if (!indexPath) throw new Error("SideThread attachment index unavailable");
  const entry = JSON.parse(readFileSync(indexPath, "utf8"));
  if (!validateIndexEntry(entry) || entry.file_id !== ref.fileId || entry.network_id !== node.network_id)
    throw new Error("SideThread attachment scope mismatch");
  const path = pathForExistingBlob(entry.date_bucket, entry.file_id, entry.ext).absolutePath;
  const bytes = readFileSync(path);
  if (bytes.byteLength !== entry.size) throw new Error("SideThread attachment size changed");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const grantId = `stg_${randomUUID().replace(/-/g, "")}`;
  const mediaType = typeof entry.mime === "string" && entry.mime.length <= 200 ? entry.mime : "application/octet-stream";
  db.run(
    "INSERT INTO side_thread_attachment_grants (grant_id,file_id,network_id,node_id,sha256,size,media_type,expires_at,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
    [grantId, ref.fileId, node.network_id, nodeId, sha256, bytes.byteLength, mediaType, now() + GRANT_TTL_MS, now()],
  );
  return { fileId: ref.fileId, grantId, sha256, size: bytes.byteLength, mediaType };
}

async function serveGrant(db: DbAdapter, req: Request, url: URL, actor: NodeCommandActor | null, now: () => number): Promise<Response | null> {
  const match = url.pathname.match(/^\/api\/side-thread\/attachment-grants\/([^/]+)$/);
  if (!match) return null;
  if (req.method !== "GET") return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  if (!actor) return Response.json({ ok: false, error: "node_token_binding_required" }, { status: 403 });
  let grantId: string;
  try { grantId = decodeURIComponent(match[1]); } catch { return Response.json({ ok: false, error: "invalid_grant" }, { status: 400 }); }
  const row = db.get<GrantRow>("SELECT * FROM side_thread_attachment_grants WHERE grant_id=?1", grantId);
  // 404 deliberately hides existence, ownership and expiry.
  if (!row || row.node_id !== actor.nodeId || row.network_id !== actor.networkId || row.expires_at < now())
    return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  const indexPath = indexEntryPath(row.file_id);
  if (!indexPath) return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  try {
    const entry = JSON.parse(readFileSync(indexPath, "utf8"));
    if (!validateIndexEntry(entry) || entry.network_id !== row.network_id || entry.size !== row.size)
      return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    const bytes = readFileSync(pathForExistingBlob(entry.date_bucket, entry.file_id, entry.ext).absolutePath);
    if (bytes.byteLength !== row.size || createHash("sha256").update(bytes).digest("hex") !== row.sha256)
      return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    return new Response(bytes, { headers: { "Content-Type": row.media_type, "Content-Length": String(row.size), "Cache-Control": "no-store" } });
  } catch { return Response.json({ ok: false, error: "not_found" }, { status: 404 }); }
}

function validateCapability(value: unknown): value is SideThreadCapability {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v.supported === true && v.runtime === "codex-app-server" && v.runtimeVersion === "0.148.0"
    && v.topology === "owned-stdio" && v.evidenceRevision === "test1190-wire-v2"
    && v.mode === "native-exact-fork" && !!v.exactBoundary && typeof v.exactBoundary === "object"
    && (v.exactBoundary as any).through === true && typeof (v.exactBoundary as any).before === "boolean";
}

function unsupported(reason: SideThreadCapability["reason"]): SideThreadCapability {
  return { supported: false, runtime: "unknown", runtimeVersion: "unknown", topology: "unknown", evidenceRevision: "none", reason };
}
