import { sendAgentNotice } from "./agent-notice.js";
import { db, uuidv4 } from "./db.js";
import { parseDbTimestampMs } from "./db-timestamp.js";
import { pendingInboxCount } from "./inbox-count.js";
import { pushEvent } from "./push.js";

export const SCHEDULE_TARGET_OFFLINE_NOTICE_KIND = "schedule_target_offline";
const SESSION_STALE_MS = 5 * 60_000;

type SessionRow = { status: string | null; updated_at: string | null; last_seen_at: string | null };

/** Same status + five-minute timestamp rule as the existing task delivery resolver. */
export function scheduledTargetOffline(nodeId: string, alias: string, networkId: string, nowMs = Date.now()): boolean {
  const session = db.get<SessionRow>(
    "SELECT status, updated_at, last_seen_at FROM sessions WHERE node_id = ?1 AND network_id = ?2 ORDER BY updated_at DESC LIMIT 1",
    nodeId, networkId,
  ) ?? db.get<SessionRow>(
    "SELECT status, updated_at, last_seen_at FROM sessions WHERE alias = ?1 AND network_id = ?2 AND node_id IS NULL ORDER BY updated_at DESC LIMIT 1",
    alias, networkId,
  );
  if (!session) return true;
  const raw = session.last_seen_at || session.updated_at;
  const seen = raw ? parseDbTimestampMs(raw) : 0;
  return String(session.status || "").toLowerCase() === "offline" || !Number.isFinite(seen) || nowMs - seen > SESSION_STALE_MS;
}

export type OfflineNotice = {
  scheduleId: string; scheduleName: string; networkId: string;
  createdBy: string | null; createdByNodeId: string | null;
  targetAlias: string;
};

function noticeText(n: OfflineNotice): string {
  return `定时任务「${n.scheduleName}」的目标节点 ${n.targetAlias} 已离线，本轮已跳过且没有创建任务。节点恢复在线后，后续轮次会自动照常派发。`;
}

/** Post-commit delivery. The transaction has already claimed this offline episode. */
export function sendOfflineNotice(n: OfflineNotice): string | null {
  try {
    const text = noticeText(n);
    const meta = { schedule_target_offline: { schedule_id: n.scheduleId, target_alias: n.targetAlias, reason: "target_offline" } };
    if (!n.createdByNodeId) {
      if (!n.createdBy) return null;
      return sendAgentNotice({
        networkId: n.networkId, userId: n.createdBy, fromAlias: n.targetAlias,
        kind: SCHEDULE_TARGET_OFFLINE_NOTICE_KIND, title: "定时任务目标节点离线", text,
        severity: "warning", meta, idPrefix: "dm_sched_offline_",
      });
    }
    const creator = db.get<{ alias: string | null }>(
      "SELECT alias FROM nodes WHERE node_id = ?1 AND network_id = ?2", n.createdByNodeId, n.networkId,
    );
    if (!creator?.alias) return null;
    const id = `sched_offline_${uuidv4()}`;
    db.run(
      `INSERT INTO inbox (id, session_name, node_id, type, priority, content, from_session, network_id, meta_json)
       VALUES (?1, ?2, ?3, 'message', 'normal', ?4, 'hub', ?5, ?6)`,
      [id, creator.alias, n.createdByNodeId, `[定时任务目标节点离线] ${text}\n(这是告警，不需要回复。)`, n.networkId, JSON.stringify(meta)],
    );
    pushEvent(creator.alias, { type: "new_message", inbox_count: pendingInboxCount(creator.alias, n.networkId), from: "hub", message_id: id }, n.networkId);
    return id;
  } catch (e: any) {
    console.error(`[scheduled-tasks] offline notice failed schedule=${n.scheduleId}: ${e?.message || e}`);
    return null;
  }
}
