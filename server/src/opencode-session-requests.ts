// #4821 Hub↔daemon 会话列表请求通道。
//
// 为什么需要：Hub 不能主动调 daemon（daemon 在后面 NAT 里），daemon 只能拉。
// node_create_requests 已经证明「Hub 写请求行 → daemon 拉 → daemon ack」这套可靠，
// 这里照同一形状再做一条只读通道，专门取 OpenCode V2 的 session 列表。
//
// 与 create 通道的差异（有意为之）：
//   · 只读、无副作用，所以允许**短 TTL 复用**已成功的结果（同 node+cursor 60 秒内命中直接返回），
//     避免 App 列表刷新把 daemon 打满；
//   · 同 (node, cursor) 只有一个 pending 行（并发点两次不产生两条请求）；
//   · 结果体是**已经投影过**的 HubSession 数组（投影在 opencode-sessions-project.ts），
//     这里只存 JSON 字符串，不解析上游形状。
import type { Database } from "bun:sqlite";

export const SESSION_REQUEST_TTL_MS = 60_000;
export const SESSION_REQUEST_MAX_AGE_MS = 5 * 60_000;

export type SessionRequestRow = {
  request_id: string;
  network_id: string;
  daemon_node_id: string;
  cursor: string | null;
  limit_n: number;
  status: "pending" | "delivered" | "succeeded" | "failed";
  result_json: string | null;
  error: string | null;
  created_at: number;
  created_by: string | null;
  delivered_at: number | null;
  acked_at: number | null;
};

export function ensureSessionRequestsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS node_session_requests (
      request_id      TEXT PRIMARY KEY,
      network_id      TEXT NOT NULL,
      daemon_node_id  TEXT NOT NULL,
      cursor          TEXT,
      limit_n         INTEGER NOT NULL,
      status          TEXT NOT NULL,
      result_json     TEXT,
      error           TEXT,
      created_at      INTEGER NOT NULL,
      created_by      TEXT,
      delivered_at    INTEGER,
      acked_at        INTEGER
    )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_nsr_daemon_status ON node_session_requests(daemon_node_id, status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_nsr_network ON node_session_requests(network_id, created_at)`);
}

/** 同 node + cursor 的新鲜成功结果（TTL 内）。 */
export function findFreshResult(
  db: Database,
  networkId: string,
  nodeId: string,
  cursor: string | null,
  now = Date.now(),
  ttlMs = SESSION_REQUEST_TTL_MS,
): SessionRequestRow | null {
  return db.get<SessionRequestRow>(
    `SELECT * FROM node_session_requests
      WHERE network_id = ?1 AND daemon_node_id = ?2
        AND COALESCE(cursor, '') = ?3 AND status = 'succeeded'
        AND created_at > ?4
      ORDER BY created_at DESC LIMIT 1`,
    [networkId, nodeId, cursor ?? "", now - ttlMs],
  ) ?? null;
}

/** 复用同 node + cursor 仍在飞的请求（并发刷新不重复建行）。 */
export function findOpenRequest(
  db: Database,
  networkId: string,
  nodeId: string,
  cursor: string | null,
  now = Date.now(),
): SessionRequestRow | null {
  return db.get<SessionRequestRow>(
    `SELECT * FROM node_session_requests
      WHERE network_id = ?1 AND daemon_node_id = ?2
        AND COALESCE(cursor, '') = ?3 AND status IN ('pending', 'delivered')
        AND created_at > ?4
      ORDER BY created_at DESC LIMIT 1`,
    [networkId, nodeId, cursor ?? "", now - SESSION_REQUEST_MAX_AGE_MS],
  ) ?? null;
}

export function createSessionRequest(
  db: Database,
  args: { networkId: string; nodeId: string; cursor: string | null; limit: number; createdBy: string | null },
): SessionRequestRow {
  const requestId = `ssr_${crypto.randomUUID()}`;
  const now = Date.now();
  db.run(
    `INSERT INTO node_session_requests
       (request_id, network_id, daemon_node_id, cursor, limit_n, status, created_at, created_by)
     VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7)`,
    [requestId, args.networkId, args.nodeId, args.cursor, args.limit, now, args.createdBy],
  );
  return db.get<SessionRequestRow>("SELECT * FROM node_session_requests WHERE request_id = ?1", [requestId])!;
}

export function getSessionRequest(db: Database, requestId: string): SessionRequestRow | null {
  return db.get<SessionRequestRow>("SELECT * FROM node_session_requests WHERE request_id = ?1", [requestId]) ?? null;
}

/** daemon 拉：把 pending 翻成 delivered 并返回内容（同一行不会被两个 daemon 拿到）。 */
export function takePendingForDaemon(db: Database, daemonNodeId: string, limitN = 5): SessionRequestRow[] {
  const rows = db.all<SessionRequestRow>(
    `SELECT * FROM node_session_requests
      WHERE daemon_node_id = ?1 AND status = 'pending'
      ORDER BY created_at ASC LIMIT ?2`,
    [daemonNodeId, limitN],
  );
  const now = Date.now();
  for (const row of rows) {
    db.run(
      `UPDATE node_session_requests SET status = 'delivered', delivered_at = ?1
        WHERE request_id = ?2 AND status = 'pending'`,
      [now, row.request_id],
    );
    row.status = "delivered";
    row.delivered_at = now;
  }
  return rows;
}

/** daemon ack：只接受「已投递」的行，成功必须有结果体。 */
export function ackSessionRequest(
  db: Database,
  args: { requestId: string; ok: boolean; resultJson?: string | null; error?: string | null },
): { ok: true } | { ok: false; error: string } {
  const row = getSessionRequest(db, args.requestId);
  if (!row) return { ok: false, error: "request_not_found" };
  if (row.status === "succeeded" || row.status === "failed") return { ok: true }; // 幂等
  if (row.status !== "delivered" && row.status !== "pending") return { ok: false, error: "request_not_open" };
  if (args.ok && !args.resultJson) return { ok: false, error: "result_required" };
  db.run(
    `UPDATE node_session_requests SET status = ?1, result_json = ?2, error = ?3, acked_at = ?4
      WHERE request_id = ?5`,
    [args.ok ? "succeeded" : "failed", args.ok ? args.resultJson! : null, args.ok ? null : (args.error ?? "failed"), Date.now(), args.requestId],
  );
  return { ok: true };
}

/** 老行清理（挂到已有的清扫循环里；不删最近 5 分钟的，便于排障）。 */
export function purgeStaleSessionRequests(db: Database, now = Date.now()): number {
  const before = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM node_session_requests")?.n ?? 0;
  db.run("DELETE FROM node_session_requests WHERE created_at < ?1", [now - 24 * 60 * 60_000]);
  const after = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM node_session_requests")?.n ?? 0;
  return before - after;
}
