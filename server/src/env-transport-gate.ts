// #1510 (log-only) — record the secret writes that a future transport gate would
// have refused, without refusing any of them.
//
// Why log-only first: refusing makes an existing workflow fail on upgrade, and
// the nodes that talk plain HTTP today are exactly the ones we cannot see from
// the Hub. This table answers "how many writes would have been blocked, on which
// node" *before* anyone decides to turn the gate on — the same rollout shape as
// #519's stale-open sweep and #525's human_only log mode.
//
// Hourly aggregation, like node_permission_log: a chatty node must not turn this
// into one row per write.
import { db } from "./db.js";
import { getEnvTransportMode, secretTransportVerdict } from "./env-transport-policy.js";

const HOURS_RETAINED = 30 * 24;
const MAX_ROWS = 20_000;

function hourOf(now = new Date()): string {
  return now.toISOString().slice(0, 13);
}

/** Record one would-refuse hit. Never throws: logging must not break a write. */
export function noteEnvTransportWouldRefuse(networkId: string, nodeId: string, route: string, sample?: string): void {
  try {
    const now = new Date();
    if (Math.random() < 0.02) {
      db.run("DELETE FROM env_transport_would_refuse WHERE hour < ?1",
        [hourOf(new Date(now.getTime() - HOURS_RETAINED * 86_400_000))]);
    }
    const count = Number(db.get<{ n: number | string }>("SELECT COUNT(*) AS n FROM env_transport_would_refuse")?.n ?? 0);
    const hour = hourOf(now);
    const s = sample ? sample.slice(0, 120) : null;
    if (count >= MAX_ROWS) {
      db.run(
        "UPDATE env_transport_would_refuse SET hits = hits + 1, sample = COALESCE(sample, ?5) WHERE network_id = ?1 AND node_id = ?2 AND route = ?3 AND hour = ?4",
        [networkId, nodeId, route, hour, s],
      );
      return;
    }
    db.run(
      `INSERT INTO env_transport_would_refuse (network_id, node_id, route, hour, hits, sample) VALUES (?1, ?2, ?3, ?4, 1, ?5)
       ON CONFLICT(network_id, node_id, route, hour) DO UPDATE SET hits = env_transport_would_refuse.hits + 1`,
      [networkId, nodeId, route, hour, s],
    );
  } catch (e) {
    console.error(`[env-transport] would-refuse log failed: ${(e as Error).message}`);
  }
}

/** Where a secret write is aimed: the node's own row, or a daemon's. Returns the
 *  transport the node last reported, or null when it is unknown. */
export function transportOf(networkId: string, nodeId: string): string | null {
  const row = db.get<{ env_transport: string | null }>(
    "SELECT env_transport FROM sessions WHERE network_id = ?1 AND (node_id = ?2 OR alias = ?2) ORDER BY updated_at DESC LIMIT 1",
    [networkId, nodeId],
  );
  return row?.env_transport ?? null;
}

/** Called from the write lanes. Logs when the current policy would refuse.
 *
 * #1510 补丁：以前这里写死了「只有 plain 才记」，于是日得表**永远只反映一种原因**。
 * 现在改成问 `secretTransportVerdict`（把模式仮定为 enforce）：
 * 「如果现在打开 enforce，这一笔会不会被拒、原因是什么」—— 表格才是决策输入。
 * 默认 strict 关闭时结果与以前完全一致（只记 plain）。 */
export function observeSecretWrite(networkId: string, nodeId: string, route: string): void {
  if (getEnvTransportMode() !== "log") return;
  const transport = transportOf(networkId, nodeId);
  const would = secretTransportVerdict(transport, { ...process.env, ANET_SECRET_TRANSPORT_GATE: "enforce" });
  if (!would) return;
  noteEnvTransportWouldRefuse(networkId, nodeId, route, `${would} transport=${transport ?? "unknown"}`);
}

export function readEnvTransportLog(networkId: string, sinceHour: string) {
  return db.all<{ node_id: string; route: string; hour: string; hits: number | string; sample: string | null }>(
    `SELECT node_id, route, hour, hits, sample FROM env_transport_would_refuse
      WHERE network_id = ?1 AND hour >= ?2 ORDER BY hour DESC, node_id, route`,
    [networkId, sinceHour],
  ).map(r => ({ ...r, hits: Number(r.hits) }));
}
