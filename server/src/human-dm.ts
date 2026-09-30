// 多用户账号:人与人私信(同一网络里的两个用户之间)。
//
// 投递复用 user_inbox(与 send_desktop_message 同一张表、同一条 /events/users/me 推送、同一套
// /api/messages?scope=user 未读与 ack),另外记下 sender_user_id —— 由 Hub 按发信人的用户令牌写入,
// 不是客户端声称的 from_session。会话记录按 (收件人, sender_user_id) 双向取,所以发信人看得到自己发的。
//
// 与 Agent 权限无关:受限成员(看不到任何 Agent 的成员)照样能和网络里的其他人私信。

import { db, uuidv4 } from "./db.js";
import { getUserNetworkRole } from "./auth.js";
import { isAgentRestricted } from "./agent-access.js";
import { pushUserEvent, hasUserSubscribers } from "./push.js";
import { existsSync, readFileSync } from "fs";
import { FILE_ID_REGEX, indexEntryPath, validateAttachments, validateIndexEntry } from "./uploads.js";
import { restrictedMemberCanUseFile } from "./restricted-files.js";
import { redactMessageRow } from "./redact-tokens.js";

export const HUMAN_DM_KIND = "human_dm";
const MAX_DM_CHARS = 10_000;

export type HumanDmSendInput = {
  networkId: string;
  sender: { userId: string; username: string };
  toUserId?: unknown;
  toUsername?: unknown;
  message?: unknown;
  attachments?: unknown;
  clientRequestId?: unknown;
};

export type HumanDmSendResult =
  | { ok: true; message: Record<string, unknown>; delivered: boolean }
  | { ok: false; error: string; status: number };

export function sendHumanDm(input: HumanDmSendInput): HumanDmSendResult {
  const { networkId, sender } = input;
  if (!getUserNetworkRole(sender.userId, networkId)) return { ok: false, error: "not a member of this network", status: 403 };
  const text = typeof input.message === "string" ? input.message : "";
  if (text.length > MAX_DM_CHARS) return { ok: false, error: "message_too_long", status: 400 };

  const byId = typeof input.toUserId === "string" && input.toUserId
    ? db.get<{ user_id: string; username: string }>("SELECT user_id, username FROM users WHERE user_id = ?1", input.toUserId)
    : null;
  const byName = typeof input.toUsername === "string" && input.toUsername
    ? db.get<{ user_id: string; username: string }>("SELECT user_id, username FROM users WHERE username = ?1", input.toUsername)
    : null;
  if (byId && byName && byId.user_id !== byName.user_id) return { ok: false, error: "dm_target_mismatch", status: 400 };
  const target = byId ?? byName;
  // 不存在与不在本网络同一个错误,不给用户名探测留差异。
  if (!target || !getUserNetworkRole(target.user_id, networkId)) return { ok: false, error: "dm_target_not_in_network", status: 404 };
  if (target.user_id === sender.userId) return { ok: false, error: "dm_to_self", status: 400 };

  const attachments = validateAttachments(input.attachments);
  if (!attachments.ok) return { ok: false, error: "bad_attachments", status: 400 };
  if (!text.trim() && attachments.attachments.length === 0) return { ok: false, error: "message_required", status: 400 };
  const restricted = isAgentRestricted(sender.userId, networkId);
  for (const a of attachments.attachments) {
    const fileId = (a as { file_id?: string }).file_id;
    if (!fileId) continue;
    const usable = restricted
      ? restrictedMemberCanUseFile(sender.userId, sender.username, networkId, fileId)
      : fileInNetwork(networkId, fileId);
    if (!usable) return { ok: false, error: "attachment_not_accessible", status: 403 };
  }

  const clientRequestId = typeof input.clientRequestId === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(input.clientRequestId)
    ? input.clientRequestId : null;
  // 同一个气泡重试:按 (发信人, client_request_id) 定出同一个 message_id,重投不产生第二条。
  const messageId = clientRequestId
    ? `dm_${sender.userId}_${clientRequestId}`.slice(0, 120)
    : `dm_${uuidv4()}`;
  const metaJson = attachments.attachments.length ? JSON.stringify({ attachments: attachments.attachments }) : null;

  db.transaction(() => {
    db.run(
      // created_at 带毫秒:同一秒里一来一回的两条私信要能排出先后(秒级的 datetime('now') 排不出)。
      `INSERT INTO user_inbox (message_id, network_id, user_id, from_session, kind, title, content, severity, meta_json, sender_user_id, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, 'info', ?7, ?8, strftime('%Y-%m-%d %H:%M:%f', 'now'))
       ON CONFLICT(message_id) DO NOTHING`,
      [messageId, networkId, target.user_id, sender.username, HUMAN_DM_KIND, text, metaJson, sender.userId],
    );
    db.run(
      `INSERT INTO audit_log (user_id, username, action, target_type, target_id, detail, network_id)
       VALUES (?1, ?2, 'human_dm_sent', 'user', ?3, ?4, ?5)`,
      [sender.userId, sender.username, target.user_id, JSON.stringify({ message_id: messageId, attachments: attachments.attachments.length }), networkId],
    );
  });
  const row = db.get<Record<string, unknown>>(
    `SELECT message_id, network_id, user_id, sender_user_id, from_session, kind, content, meta_json, acked, created_at
       FROM user_inbox WHERE message_id = ?1`,
    messageId,
  )!;
  // 推送在提交之后(与 send_desktop_message 同一条规矩:回滚的消息不能先被看见)。
  const delivered = hasUserSubscribers(networkId, target.user_id);
  pushUserEvent(networkId, target.user_id, {
    type: "desktop_message",
    message_id: messageId,
    kind: HUMAN_DM_KIND,
    from: sender.username,
    from_user_id: sender.userId,
    title: null,
    message: text,
    severity: "info",
    created_at: new Date().toISOString(),
    ...(metaJson ? { meta: JSON.parse(metaJson) } : {}),
  });
  return { ok: true, message: redactMessageRow(row), delivered };
}

/** 不受限的成员带附件:文件必须属于这个网络(防把别的网络的 file_id 塞进来)。 */
function fileInNetwork(networkId: string, fileId: string): boolean {
  if (!FILE_ID_REGEX.test(fileId)) return false;
  const path = indexEntryPath(fileId);
  if (!path || !existsSync(path)) return false;
  try {
    const entry = JSON.parse(readFileSync(path, "utf8"));
    return validateIndexEntry(entry) && entry.file_id === fileId && entry.network_id === networkId;
  } catch { return false; }
}

/** 我和某人的私信记录(双向),新的在前。before = 上一页最后一条的 created_at。 */
export function listDmThread(networkId: string, meUserId: string, otherUserId: string, limit = 50, before?: string | null) {
  const params: unknown[] = [networkId, meUserId, otherUserId];
  let sql = `SELECT message_id, network_id, user_id, sender_user_id, from_session, kind, content, meta_json, acked, created_at
               FROM user_inbox
              WHERE network_id = ?1 AND kind = '${HUMAN_DM_KIND}'
                AND ((user_id = ?2 AND sender_user_id = ?3) OR (user_id = ?3 AND sender_user_id = ?2))`;
  if (before) { params.push(before); sql += ` AND created_at < ?${params.length}`; }
  params.push(Math.max(1, Math.min(limit, 200)));
  sql += ` ORDER BY created_at DESC, rowid DESC LIMIT ?${params.length}`;
  return db.all<Record<string, unknown>>(sql, ...params).map((row) => ({
    ...redactMessageRow(row),
    direction: row.sender_user_id === meUserId ? "out" : "in",
  }));
}

/** 我在这个网络里的私信会话:每个对方一行,最后一条时间 + 我这边的未读数。 */
export function listDmThreads(networkId: string, meUserId: string) {
  return db.all<{ other_user_id: string; last_at: string; unread: number }>(
    `SELECT other_user_id, MAX(created_at) AS last_at, SUM(unread) AS unread FROM (
       SELECT sender_user_id AS other_user_id, created_at, CASE WHEN acked = 0 THEN 1 ELSE 0 END AS unread
         FROM user_inbox WHERE network_id = ?1 AND user_id = ?2 AND kind = '${HUMAN_DM_KIND}' AND sender_user_id IS NOT NULL
       UNION ALL
       SELECT user_id AS other_user_id, created_at, 0 AS unread
         FROM user_inbox WHERE network_id = ?1 AND sender_user_id = ?2 AND kind = '${HUMAN_DM_KIND}'
     ) GROUP BY other_user_id ORDER BY last_at DESC`,
    networkId, meUserId,
  ).map((r) => ({ other_user_id: r.other_user_id, last_at: r.last_at, unread: Number(r.unread ?? 0) }));
}
