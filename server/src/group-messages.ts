// 部门群(RFC-042,看板 #457)—— 第三个 PR:群消息、未读、实时推送。
//
// 只增迁移:两张新表(chat_group_messages、chat_group_reads),零改列。旧代码不读它们,回滚安全。
//
// 尽量照私信(human-dm.ts)做,App 能复用私信界面:
// - 正文上限 MAX_DM_CHARS(1 万字)、附件走同一个 validateAttachments、同样的文件可见性校验;
// - 去重按 client_request_id(同一个人在同一个群里重投同一个 id → 同一条消息,不发第二条、不推第二次),
//   不按内容哈希(hub 旧私信去重按内容吞掉用户的重复消息,那是 bug,见 reference_hub_send_dedup);
// - 消息行形状对齐 user_inbox 私信行:message_id / network_id / sender_user_id / from_session / kind / content /
//   meta_json / created_at(毫秒)+ direction,另加 group_id 和 seq(翻页游标)。
// - 推送复用 /events/users/me(pushUserEvent),新事件类型 group_message,发给发送时**当前**的每个群成员(含发信人自己:
//   多端同步;App 按 message_id 去重)。被同步移出的人自然收不到 —— 收件人在发送那一刻从 chat_group_members 现取。
//
// 一条消息一行(不按人复制);每人已读位置一行(chat_group_reads.last_read_seq,只前进不后退)。
// 未读 = 群里 seq > 已读位置、且在我入群之后发的、不是我自己发的消息条数。
// 读写只认「当前是群成员」:被移出的人(同步移出、手动移出、移出网络)立刻读不到这个群的任何历史,也打不开群里的附件;
// 重新入群后整段历史又可见(群历史属于群,不属于某个人)。

import { createHash } from "node:crypto";
import { db, uuidv4 } from "./db.js";
import { isAgentRestricted } from "./agent-access.js";
import { pushUserEvent, hasUserSubscribers } from "./push.js";
import { DM_FILE_SCOPE, FILE_ID_REGEX, validateAttachments } from "./uploads.js";
import { restrictedMemberCanUseFile } from "./restricted-files.js";
import { redactMessageRow } from "./redact-tokens.js";
import { MAX_DM_CHARS, dmParticipantSeesFile, networkFileEntry } from "./human-dm.js";
import { isGroupMember, publicDisplayName } from "./department-groups.js";

// 两张表的 DDL 在 department-groups.ts 里(和 chat_groups 一起建,删网络时一起删,不形成模块环)。

export const GROUP_MESSAGE_KIND = "group_message";
export const GROUP_MESSAGE_EVENT = "group_message";
export const GROUP_READ_EVENT = "group_read";
const CLIENT_REQUEST_ID = /^[A-Za-z0-9._-]{1,80}$/;
const MSG_COLS = "seq, message_id, group_id, network_id, sender_user_id, from_session, content, meta_json, created_at";

type Fail = { ok: false; status: number; error: string };
const fail = (status: number, error: string): Fail => ({ ok: false, status, error });
type MsgRow = { seq: number | string; message_id: string; group_id: string; network_id: string; sender_user_id: string; from_session: string; content: string; meta_json: string | null; created_at: string };

function shape(row: MsgRow, meUserId: string) {
  return {
    ...redactMessageRow(row),
    seq: Number(row.seq),
    kind: GROUP_MESSAGE_KIND,
    direction: row.sender_user_id === meUserId ? "out" : "in",
  };
}

/** 消息接口的门:群在这个网络里、我是当前成员。否则 null(调用方一律 404 group_not_found,不分「没有」和「不让看」)。 */
export function memberGroup(networkId: string, groupId: string, userId: string): { group_id: string; name: string } | null {
  const g = db.get<{ group_id: string; name: string }>("SELECT group_id, name FROM chat_groups WHERE network_id = ?1 AND group_id = ?2", networkId, groupId);
  if (!g || !isGroupMember(groupId, userId)) return null;
  return g;
}

/**
 * 这个用户是不是**当前**某个群的成员、且那个群里有一条消息带着这个文件。群里的人因此能下载群消息的附件
 * (私信文件和受限成员两条分支都认它,见 server.ts authorizeFileDownload)。被移出群 = 立刻失去。
 * LIKE 只做预筛,真正的判定按 attachments 键解析(和 dmParticipantSeesFile 同一个写法)。
 */
export function groupMemberSeesFile(userId: string, networkId: string, fileId: string): boolean {
  if (!FILE_ID_REGEX.test(fileId)) return false;
  const needle = `%"${fileId.replace(/_/g, "\\_")}"%`;
  const rows = db.all<{ meta_json: string | null }>(
    `SELECT g.meta_json FROM chat_group_messages g
       JOIN chat_group_members m ON m.group_id = g.group_id AND m.user_id = ?2
      WHERE g.network_id = ?1 AND g.meta_json LIKE ?3 ESCAPE '\\' LIMIT 50`,
    networkId, userId, needle,
  );
  return rows.some((row) => {
    try {
      const list = JSON.parse(row.meta_json ?? "null")?.attachments;
      return Array.isArray(list) && list.some((a: any) => a && typeof a === "object" && a.file_id === fileId);
    } catch { return false; }
  });
}

export type GroupSendInput = {
  networkId: string;
  groupId: string;
  sender: { userId: string; username: string };
  message?: unknown;
  attachments?: unknown;
  clientRequestId?: unknown;
};
export type GroupSendResult =
  | { ok: true; message: ReturnType<typeof shape>; duplicate: boolean; delivered_to: number }
  | Fail;

export function sendGroupMessage(input: GroupSendInput): GroupSendResult {
  const { networkId, groupId, sender } = input;
  const group = memberGroup(networkId, groupId, sender.userId);
  if (!group) return fail(404, "group_not_found");
  const text = typeof input.message === "string" ? input.message : "";
  if (text.length > MAX_DM_CHARS) return fail(400, "message_too_long");
  const attachments = validateAttachments(input.attachments);
  if (!attachments.ok) return fail(400, "bad_attachments");
  if (!text.trim() && attachments.attachments.length === 0) return fail(400, "message_required");

  // 文件校验与私信同一套:必须是本网络的文件;受限成员只能发自己能用的;私信文件只能由看得见它的人转发
  // (上传者、带着它的私信里的人、带着它的群里的当前成员)—— 否则把别人私信里的 file_id 塞进群,就给全群解锁了它。
  const restricted = isAgentRestricted(sender.userId, networkId);
  for (const a of attachments.attachments) {
    const fileId = (a as { file_id?: string }).file_id;
    if (!fileId) continue;
    const entry = networkFileEntry(networkId, fileId);
    const usable = restricted
      ? restrictedMemberCanUseFile(sender.userId, sender.username, networkId, fileId) || (!!entry && groupMemberSeesFile(sender.userId, networkId, fileId))
      : !!entry;
    if (!usable) return fail(403, "attachment_not_accessible");
    if (entry?.scope === DM_FILE_SCOPE && entry.owner_id !== sender.userId
      && !dmParticipantSeesFile(sender.userId, networkId, fileId) && !groupMemberSeesFile(sender.userId, networkId, fileId)) {
      return fail(403, "attachment_not_accessible");
    }
  }

  const clientRequestId = typeof input.clientRequestId === "string" && CLIENT_REQUEST_ID.test(input.clientRequestId) ? input.clientRequestId : null;
  // 同一个气泡重试:按 (群, 发信人, client_request_id) 定出同一个 message_id(哈希,不截断拼接,避免长 id 截出碰撞)。
  const messageId = clientRequestId
    ? `gm_${createHash("sha256").update(`${groupId}\n${sender.userId}\n${clientRequestId}`).digest("hex").slice(0, 32)}`
    : `gm_${uuidv4().replace(/-/g, "")}`;
  const metaJson = attachments.attachments.length ? JSON.stringify({ attachments: attachments.attachments }) : null;

  let inserted = false;
  db.transaction(() => {
    const r = db.run(
      `INSERT INTO chat_group_messages (message_id, group_id, network_id, sender_user_id, from_session, content, meta_json, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, strftime('%Y-%m-%d %H:%M:%f', 'now'))
       ON CONFLICT(message_id) DO NOTHING`,
      [messageId, groupId, networkId, sender.userId, sender.username, text, metaJson],
    );
    inserted = (r?.changes ?? 0) > 0;
    if (!inserted) return;
    db.run(
      `INSERT INTO audit_log (user_id, username, action, target_type, target_id, detail, network_id)
       VALUES (?1, ?2, 'chat_group_message_sent', 'chat_group', ?3, ?4, ?5)`,
      [sender.userId, sender.username, groupId, JSON.stringify({ message_id: messageId, attachments: attachments.attachments.length }), networkId],
    );
  });
  const row = db.get<MsgRow>(`SELECT ${MSG_COLS} FROM chat_group_messages WHERE message_id = ?1`, messageId)!;
  const message = shape(row, sender.userId);
  // 重投:同一条消息原样返回,不再推送(第一次已经推过)。推送在提交之后:回滚的消息不能先被看见。
  const deliveredTo = inserted ? pushGroupMessage(networkId, group, row) : 0;
  return { ok: true, message, duplicate: !inserted, delivered_to: deliveredTo };
}

/** 推 group_message 给发送这一刻的每个群成员(含发信人自己,多端同步),每人带上自己的未读数。返回推送时在线的人数。 */
function pushGroupMessage(networkId: string, group: { group_id: string; name: string }, row: MsgRow): number {
  const unread = unreadByMember(group.group_id);
  let online = 0;
  for (const [userId, count] of unread) {
    if (hasUserSubscribers(networkId, userId)) online++;
    pushUserEvent(networkId, userId, {
      type: GROUP_MESSAGE_EVENT,
      message_id: row.message_id,
      seq: Number(row.seq),
      group_id: group.group_id,
      group_name: group.name,
      kind: GROUP_MESSAGE_KIND,
      from: row.from_session,
      from_user_id: row.sender_user_id,
      message: redactMessageRow({ content: row.content }).content,
      severity: "info",
      created_at: row.created_at,
      unread: count,
      ...(row.meta_json ? { meta: JSON.parse(redactMessageRow({ meta_json: row.meta_json }).meta_json) } : {}),
    });
  }
  return online;
}

// 未读口径(一处定义,三个地方用):别人发的、在我入群之后、seq 超过我的已读位置。
// joined_at 是秒级、created_at 是毫秒级的同格式 UTC 文本(SQLite 与 PG 一致),逐字比较即时间先后;
// 入群那一秒里发的消息算未读(宁可多一条,不漏)。重新入群 joined_at 刷新,离开期间的消息不算未读。
const UNREAD_SUBQUERY = `(SELECT COUNT(*) FROM chat_group_messages g
     WHERE g.group_id = m.group_id AND g.sender_user_id <> m.user_id
       AND g.created_at > m.joined_at AND g.seq > COALESCE(r.last_read_seq, 0))`;

function unreadByMember(groupId: string): Map<string, number> {
  const rows = db.all<{ user_id: string; unread: number | string }>(
    `SELECT m.user_id, ${UNREAD_SUBQUERY} AS unread
       FROM chat_group_members m LEFT JOIN chat_group_reads r ON r.group_id = m.group_id AND r.user_id = m.user_id
      WHERE m.group_id = ?1`,
    groupId,
  );
  return new Map(rows.map((r) => [r.user_id, Number(r.unread ?? 0)]));
}

export function groupUnreadFor(groupId: string, userId: string): number {
  const r = db.get<{ unread: number | string }>(
    `SELECT ${UNREAD_SUBQUERY} AS unread
       FROM chat_group_members m LEFT JOIN chat_group_reads r ON r.group_id = m.group_id AND r.user_id = m.user_id
      WHERE m.group_id = ?1 AND m.user_id = ?2`,
    groupId, userId,
  );
  return Number(r?.unread ?? 0);
}

/**
 * 会话列表里的最后一条预览(App 补口,只增)。text = 正文(去敏后)空白折成一个空格、取前 80 个字符(按码点,不切坏 emoji);
 * 只有附件 → text 为 "",attachment_count 是附件数。sender_name = 发信人当前的 display_name(非空)否则 username
 * (账号没了回落到发送时的 from_session)。at = 这条消息的 created_at(与 last_at 同值)。
 */
export type GroupLastMessage = { text: string; attachment_count: number; sender_user_id: string; sender_name: string; at: string };
export const LAST_MESSAGE_PREVIEW_CHARS = 80;

/**
 * 我在这个网络里每个群的最后一条消息,一次查询(按群取 MAX(seq) 走 (group_id, seq) 索引,不逐群发查询)。
 * 只覆盖我**当前**在里面的群 —— 不是成员的群(管理身份看得到群资料)不给预览,和 last_message_at 同一口径。
 */
export function lastGroupMessagesFor(networkId: string, userId: string): Map<string, GroupLastMessage> {
  const rows = db.all<{ group_id: string; sender_user_id: string; from_session: string; content: string; meta_json: string | null; created_at: string; username: string | null; display_name: string | null }>(
    `SELECT g.group_id, g.sender_user_id, g.from_session, g.content, g.meta_json, g.created_at, u.username, u.display_name
       FROM chat_group_members m
       JOIN chat_group_messages g ON g.group_id = m.group_id
        AND g.seq = (SELECT MAX(g2.seq) FROM chat_group_messages g2 WHERE g2.group_id = m.group_id)
       LEFT JOIN users u ON u.user_id = g.sender_user_id
      WHERE m.network_id = ?1 AND m.user_id = ?2`,
    networkId, userId,
  );
  const out = new Map<string, GroupLastMessage>();
  for (const r of rows) {
    const content = String(redactMessageRow({ content: r.content }).content ?? "");
    let attachmentCount = 0;
    try {
      const list = JSON.parse(r.meta_json ?? "null")?.attachments;
      if (Array.isArray(list)) attachmentCount = list.length;
    } catch {}
    const name = publicDisplayName(r.username, r.display_name).trim() || r.username || r.from_session;
    out.set(r.group_id, {
      text: [...content.replace(/\s+/g, " ").trim()].slice(0, LAST_MESSAGE_PREVIEW_CHARS).join(""),
      attachment_count: attachmentCount,
      sender_user_id: r.sender_user_id,
      sender_name: name,
      at: r.created_at,
    });
  }
  return out;
}

export type GroupThread = { group_id: string; name: string; department_id: string | null; last_at: string | null; unread: number; last_read_seq: number; last_message: GroupLastMessage | null };

/** 我在这个网络里的群会话:每个群一行,最后一条时间 + 我的未读数。按最后一条时间倒序(没消息的排最后),和私信会话列表同序。 */
export function listGroupThreads(networkId: string, userId: string): GroupThread[] {
  const rows = db.all<{ group_id: string; name: string; department_id: string | null; last_at: string | null; unread: number | string; last_read_seq: number | string | null }>(
    `SELECT m.group_id, c.name, c.department_id, ${UNREAD_SUBQUERY} AS unread,
            (SELECT MAX(g2.created_at) FROM chat_group_messages g2 WHERE g2.group_id = m.group_id) AS last_at,
            r.last_read_seq
       FROM chat_group_members m
       JOIN chat_groups c ON c.group_id = m.group_id
       LEFT JOIN chat_group_reads r ON r.group_id = m.group_id AND r.user_id = m.user_id
      WHERE m.network_id = ?1 AND m.user_id = ?2`,
    networkId, userId,
  );
  const last = lastGroupMessagesFor(networkId, userId);
  // 排序放在 JS 里:SQLite 和 PG 对 DESC 里 NULL 的位置相反。
  return rows
    .map((r) => ({ group_id: r.group_id, name: r.name, department_id: r.department_id, last_at: r.last_at, unread: Number(r.unread ?? 0), last_read_seq: Number(r.last_read_seq ?? 0), last_message: last.get(r.group_id) ?? null }))
    .sort((a, b) => (b.last_at ?? "").localeCompare(a.last_at ?? "") || a.group_id.localeCompare(b.group_id));
}

/** 群消息记录,新的在前。before = 上一页最后(最老)一条的 seq;返回 next_before(没有更多 → null)。 */
export function listGroupMessages(groupId: string, meUserId: string, limit = 50, before?: string | null): { messages: ReturnType<typeof shape>[]; next_before: number | null } | Fail {
  const n = Math.max(1, Math.min(Number.isFinite(limit) ? Math.trunc(limit) : 50, 200));
  let rows: MsgRow[];
  if (before !== undefined && before !== null && before !== "") {
    if (!/^\d{1,15}$/.test(before)) return fail(400, "invalid_before");
    rows = db.all<MsgRow>(`SELECT ${MSG_COLS} FROM chat_group_messages WHERE group_id = ?1 AND seq < ?2 ORDER BY seq DESC LIMIT ?3`, groupId, Number(before), n);
  } else {
    rows = db.all<MsgRow>(`SELECT ${MSG_COLS} FROM chat_group_messages WHERE group_id = ?1 ORDER BY seq DESC LIMIT ?2`, groupId, n);
  }
  const messages = rows.map((r) => shape(r, meUserId));
  return { messages, next_before: rows.length === n ? Number(rows[rows.length - 1].seq) : null };
}

/**
 * 标已读。seq 缺省 = 群里最新一条;给了就读到那一条(超过最新按最新算)。已读位置只前进不后退
 * (两台设备先后上报,旧的那次不会把未读又顶回来)。读完推 group_read 给我自己的其他设备,让角标一起清。
 */
export function markGroupRead(networkId: string, groupId: string, userId: string, seq: unknown): { ok: true; last_read_seq: number; unread: number } | Fail {
  if (seq !== undefined && seq !== null && !(typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0)) return fail(400, "invalid_seq");
  const latest = Number(db.get<{ s: number | string | null }>("SELECT MAX(seq) AS s FROM chat_group_messages WHERE group_id = ?1", groupId)?.s ?? 0);
  const target = typeof seq === "number" ? Math.min(seq, latest) : latest;
  db.run(
    `INSERT INTO chat_group_reads (group_id, user_id, network_id, last_read_seq, updated_at)
     VALUES (?1, ?2, ?3, ?4, datetime('now'))
     ON CONFLICT(group_id, user_id) DO UPDATE SET
       last_read_seq = CASE WHEN excluded.last_read_seq > chat_group_reads.last_read_seq THEN excluded.last_read_seq ELSE chat_group_reads.last_read_seq END,
       updated_at = excluded.updated_at`,
    [groupId, userId, networkId, target],
  );
  const lastRead = Number(db.get<{ s: number | string }>("SELECT last_read_seq AS s FROM chat_group_reads WHERE group_id = ?1 AND user_id = ?2", groupId, userId)?.s ?? 0);
  const unread = groupUnreadFor(groupId, userId);
  pushUserEvent(networkId, userId, { type: GROUP_READ_EVENT, group_id: groupId, last_read_seq: lastRead, unread });
  return { ok: true, last_read_seq: lastRead, unread };
}
