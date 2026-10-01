// 参与人改了任务 → 通知相关的人(Vincent 2026-10-01「参与人可以改，但是改了之后需要有个通知」)。
//
// 谁触发:操作者是人,且是这张卡的参与人、不是负责人(权限上参与人只能改状态和检查项,见 task-access.ts
// PARTICIPANT_EDIT_FIELDS;老成员 task_access='all' 的参与人改了也一样通知)。只说状态和检查项的变化,别的字段不进正文。
// 通知谁:负责人、创建者、其他参与人 —— 只要人类、去重、不含操作者本人。
// 怎么送:复用人与人私信(human-dm.ts,user_inbox kind=human_dm + /events/users/me 的 desktop_message),
//   发信人 = 操作者。App 已有的展示:顶部提示 + 人员列表未读 + 与他的私信会话。不新增渠道。
// 合并:同一 (收件人, 操作者, 卡) 在 COALESCE_WINDOW_MS 内的连续改动并进同一条还没读的私信(改写正文,不再弹)。

import { db, uuidv4 } from "./db.js";
import { isParticipant } from "./task-access.js";
import { rewriteUnreadNoticeDm, sendNoticeDm } from "./human-dm.js";

export const COALESCE_WINDOW_MS = 60_000;
const COLUMN_LABEL: Record<string, string> = { pool: "需求池", doing: "进行中", done: "完成" };
const MAX_LINES = 20;
const MAX_ITEM_CHARS = 40;

export type NoticeCard = {
  requirement_id: string;
  network_id: string;
  seq: number | null;
  title: string;
  column_name: string;
  checklist_json: string | null;
  owner_json: string | null;
  participants_json: string | null;
  created_by: string | null;
  created_by_json: string | null;
};

type Item = { id: string; text: string; done: boolean };
const items = (raw: string | null): Item[] => {
  try {
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((x) => x && typeof x.id === "string").map((x) => ({ id: x.id, text: String(x.text ?? ""), done: x.done === true })) : [];
  } catch { return []; }
};
const clip = (s: string) => { const c = Array.from(s); return c.length > MAX_ITEM_CHARS ? c.slice(0, MAX_ITEM_CHARS).join("") + "…" : s; };
const parse = (raw: string | null) => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } };
const userIdOf = (ref: unknown): string | null => {
  const r = ref as { kind?: unknown; id?: unknown } | null;
  return r && r.kind === "user" && typeof r.id === "string" ? r.id : null;
};

/**
 * 这次改动里要说的那几件事,按「对象」做键:同一个对象后一次覆盖前一次(先勾再取消 = 只剩「取消勾选」)。
 * 键:column / ck:<id>。值:一句短话(不带主语和卡名)。
 */
export function describeChanges(before: Pick<NoticeCard, "column_name" | "checklist_json">, after: Pick<NoticeCard, "column_name" | "checklist_json">): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (before.column_name !== after.column_name) out.push(["column", `改为 ${COLUMN_LABEL[after.column_name] ?? after.column_name}`]);
  const a = items(before.checklist_json), b = items(after.checklist_json);
  const was = new Map(a.map((x) => [x.id, x]));
  const now = new Map(b.map((x) => [x.id, x]));
  for (const x of b) {
    const old = was.get(x.id);
    if (!old) { out.push([`ck:${x.id}`, `添加了检查项「${clip(x.text)}」`]); continue; }
    if (old.text !== x.text) out.push([`ck:${x.id}`, `把检查项「${clip(old.text)}」改为「${clip(x.text)}」`]);
    else if (old.done !== x.done) out.push([`ck:${x.id}`, `${x.done ? "勾选了" : "取消勾选了"}检查项「${clip(x.text)}」`]);
  }
  for (const x of a) if (!now.has(x.id)) out.push([`ck:${x.id}`, `删除了检查项「${clip(x.text)}」`]);
  return out;
}

/** 收件人:负责人、创建者、其他参与人(只要人,去重,去掉操作者)。 */
export function noticeRecipients(card: NoticeCard, actorUserId: string): string[] {
  const ids = new Set<string>();
  const owner = userIdOf(parse(card.owner_json));
  if (owner) ids.add(owner);
  const creator = userIdOf(parse(card.created_by_json)) ?? (!card.created_by_json && card.created_by ? card.created_by : null);
  if (creator) ids.add(creator);
  const participants = parse(card.participants_json);
  if (Array.isArray(participants)) for (const p of participants) { const id = userIdOf(p); if (id) ids.add(id); }
  ids.delete(actorUserId);

  return [...ids];
}

export function noticeText(actorName: string, title: string, lines: readonly string[]): string {
  if (lines.length === 1) {
    const line = lines[0];
    return line.startsWith("改为 ") ? `${actorName} 把「${title}」${line}` : `${actorName} 在「${title}」${line}`;
  }
  const shown = lines.slice(-MAX_LINES);
  const more = lines.length > shown.length ? `\n…另有 ${lines.length - shown.length} 项` : "";
  return `${actorName} 更新了「${title}」:\n${shown.map((l) => `· ${l}`).join("\n")}${more}`;
}

type Pending = { messageId: string; startedAt: number; changes: Map<string, string> };
const pending = new Map<string, Pending>();

export function __resetRequirementNoticesForTest(): void { pending.clear(); }

/**
 * 参与人(非负责人)改完一张卡之后调用(事务提交之后)。before / after = 改前改后的行。
 * 不是参与人、或者状态和检查项都没变 → 什么都不发。返回这次通知到的收件人(测试用)。
 */
export function notifyParticipantChange(input: { before: NoticeCard; after: NoticeCard; actorUserId: string; now?: number }): string[] {
  const { before, after, actorUserId } = input;
  if (!isParticipant(before, actorUserId)) return [];
  if (userIdOf(parse(before.owner_json)) === actorUserId) return [];

  const changes = describeChanges(before, after);
  if (!changes.length) return [];
  const now = input.now ?? Date.now();
  // 用户名从库里取:MCP 入口的 auth.username 是空串。
  const user = db.get<{ username: string; display_name: string | null }>("SELECT username, display_name FROM users WHERE user_id = ?1", actorUserId);
  if (!user) return [];
  const actorName = user.display_name?.trim() || user.username;
  const sender = { userId: actorUserId, username: user.username };
  const sent: string[] = [];
  for (const target of noticeRecipients(after, actorUserId)) {
    const key = `${target}\u0000${actorUserId}\u0000${after.requirement_id}`;
    const prev = pending.get(key);
    const live = prev && now - prev.startedAt < COALESCE_WINDOW_MS ? prev : null;
    const merged = new Map(live?.changes ?? []);
    for (const [k, line] of changes) { merged.delete(k); merged.set(k, line); }
    const meta = JSON.stringify({ task_notice: { requirement_id: after.requirement_id, seq: after.seq ?? null, network_id: after.network_id } });
    const base = { networkId: after.network_id, targetUserId: target, sender, title: "任务更新", metaJson: meta };
    if (live && rewriteUnreadNoticeDm({ ...base, messageId: live.messageId, text: noticeText(actorName, after.title, [...merged.values()]) })) {
      live.changes = merged;
      sent.push(target);
      continue;
    }
    const messageId = `dm_task_${uuidv4()}`;
    const fresh = new Map(changes);
    if (!sendNoticeDm({ ...base, messageId, text: noticeText(actorName, after.title, [...fresh.values()]) })) continue;
    pending.set(key, { messageId, startedAt: now, changes: fresh });
    sent.push(target);
  }
  if (pending.size > 5_000) for (const [k, p] of pending) if (now - p.startedAt >= COALESCE_WINDOW_MS) pending.delete(k);
  return sent;
}
