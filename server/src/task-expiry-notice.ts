// #500 —— 任务过期时告诉派活的人。
//
// 以前 TTL 巡检(server.ts patrolExpiredTasks)只把任务改成 expired、写一条 task_events,
// 派活的一方什么都收不到:14 天 109 条过期,0 条被告知;agent 收不到回音就原样重发,队列越排越长。
//
// 这里在巡检提交之后,按「派活的一方是谁」走它平时收回复的那条路:
//   - agent 节点:inbox 写一行 type='reply'(requires_response='none')+ SSE new_reply。
//     与 send_reply 同形:agent-node(peer-reply-inbox.ts)和 claude-code channel(channel-inbox-wake.ts)
//     都把 new_reply 当门铃拉 inbox。agent-node 按 inbox-message-policy.ts 把 type=reply 当「终态结果」
//     交给模型、不回复(不会被当成新任务);claude-code channel 像别的回复一样注入会话。from_session = 'hub':自派(A→A)的任务不会被节点当成自己发的而跳过。
//   - 人(Dashboard / App 的用户):agent-notice.ts(user_inbox + /events/users/me 的 desktop_message),
//     from_session = 目标节点别名 —— 与 #462/#464 同一条路,出现在**与该节点的会话**里 + 未读 + 通知。
//   - scheduler:不发。scheduled_task_runs 那一行已经记了 expired(syncScheduledRunForTask)。
//   - hub / api / 认不出来的发送方:不发(没有可达的收件人)。
// 限流:同一次巡检里,同一个 (网络, 发送方, 目标) 只发**一条**,多条过期合并成一条摘要。
// 父任务:子任务过期时通知父任务的发送方一条(同样按父任务合并),**不**改父任务的状态 / result ——
//   chainReplyToParent 会把父任务改成 replied/failed,这里刻意不走它:父任务的执行者可能还在干活。
// 全部在巡检事务提交之后做,每一步各自吞异常:通知失败不能让巡检失败,也不能回滚已经过期的任务。

import { db, uuidv4 } from "./db.js";
import { parseDbTimestampMs } from "./db-timestamp.js";
import { sendAgentNotice } from "./agent-notice.js";
import { pushEvent, pushNetworkObserverEvent } from "./push.js";
import { pendingInboxCount } from "./inbox-count.js";
import { QUEUE_HORIZON_SQL, QUEUE_OPEN_STATUSES_SQL } from "./task-queue-ahead.js";

export const TASK_EXPIRED_NOTICE_KIND = "task_expired";

/** 巡检刚刚结束为 expired 的一行(巡检 SELECT 出来的列)。 */
export type ExpiredTaskRow = {
  task_id: string;
  network_id: string | null;
  from_name: string | null;
  from_node_id: string | null;
  to_name: string;
  content: string | null;
  created_at: string | null;
  expires_at: string | null;
  parent_task_id: string | null;
  meta_json: string | null;
};

export type ExpirySenderRoute =
  | { kind: "agent"; alias: string }
  | { kind: "user"; userId: string; username: string }
  | { kind: "none"; reason: "scheduler" | "system" | "unknown" };

/** 一条发出去的通知(测试 / 日志用)。 */
export type ExpiryNoticeSent = {
  route: "agent" | "user";
  recipient: string;
  target: string;
  task_ids: string[];
  message_id: string;
  about: "task" | "child";
};

const SYSTEM_SENDERS = new Set(["", "hub", "api"]);
const MAX_LISTED = 10;

function authOrigin(metaJson: string | null): string | null {
  if (!metaJson) return null;
  try {
    const m = JSON.parse(metaJson);
    return m && typeof m === "object" && typeof m.auth_origin === "string" ? m.auth_origin : null;
  } catch { return null; }
}

function isScheduledTask(taskId: string): boolean {
  return !!db.get("SELECT 1 AS hit FROM scheduled_task_runs WHERE task_id = ?1", taskId);
}

function memberUser(username: string, networkId: string | null): { userId: string } | null {
  if (!networkId) return null; // user_inbox 按网络存:没有网络就没有可达的人
  const u = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", username);
  if (!u) return null;
  const m = db.get("SELECT 1 AS hit FROM network_members WHERE network_id = ?1 AND user_id = ?2", networkId, u.user_id);
  return m ? { userId: u.user_id } : null;
}

function agentSession(alias: string, networkId: string | null): { node_id: string | null } | null {
  return networkId
    ? db.get<{ node_id: string | null }>("SELECT node_id FROM sessions WHERE alias = ?1 AND network_id = ?2 ORDER BY updated_at DESC LIMIT 1", alias, networkId)
    : db.get<{ node_id: string | null }>("SELECT node_id FROM sessions WHERE alias = ?1 AND network_id IS NULL ORDER BY updated_at DESC LIMIT 1", alias);
}

/**
 * 派活的一方是谁 → 走哪条路。
 * 节点派的(auth_origin=node 或带 from_node_id)先按节点认;否则先按人认(Dashboard 用用户令牌派活,
 * from_name 是用户名、from_node_id 为空)。两种都认不出 → 不发。
 */
export function classifyExpirySender(row: Pick<ExpiredTaskRow, "task_id" | "network_id" | "from_name" | "from_node_id" | "meta_json">): ExpirySenderRoute {
  const from = (row.from_name ?? "").trim();
  const origin = authOrigin(row.meta_json);
  if (from === "scheduler" || origin === "hub_scheduler" || isScheduledTask(row.task_id)) return { kind: "none", reason: "scheduler" };
  if (SYSTEM_SENDERS.has(from)) return { kind: "none", reason: "system" };
  const nodeFirst = origin === "node" || (!!row.from_node_id && origin !== "user");
  const asAgent = (): ExpirySenderRoute | null => (agentSession(from, row.network_id) ? { kind: "agent", alias: from } : null);
  const asUser = (): ExpirySenderRoute | null => {
    const u = memberUser(from, row.network_id);
    return u ? { kind: "user", userId: u.userId, username: from } : null;
  };
  return (nodeFirst ? (asAgent() ?? asUser()) : (asUser() ?? asAgent())) ?? { kind: "none", reason: "unknown" };
}

/**
 * 过期那一刻,目标节点上比它早、还没结束的任务数(正在跑的也算)。
 * #519 —— 与 task-queue-ahead.ts 的 queue_ahead 同一口径:只数最近 24 小时(QUEUE_HORIZON_SQL)派出的。
 * 以前没有下界,几个月前被遗弃在 acked / running 的行全算「排在前面」,通知会说前面还有几千个。
 * 走 idx_tasks_to_created(to_name, created_at)的区间 [horizon, createdAt)。
 */
export function openTasksAhead(target: string, networkId: string | null, createdAt: string | null): number | null {
  if (!createdAt) return null;
  try {
    const row = networkId
      ? db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM tasks WHERE to_name = ?1 AND network_id = ?2
            AND status IN ${QUEUE_OPEN_STATUSES_SQL} AND created_at < ?3 AND created_at >= ${QUEUE_HORIZON_SQL}`,
        target, networkId, createdAt)
      : db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM tasks WHERE to_name = ?1 AND network_id IS NULL
            AND status IN ${QUEUE_OPEN_STATUSES_SQL} AND created_at < ?2 AND created_at >= ${QUEUE_HORIZON_SQL}`,
        target, createdAt);
    return Number(row?.n ?? 0);
  } catch { return null; }
}

function minutesBetween(fromTs: string | null, toMs: number): number | null {
  if (!fromTs) return null;
  const ms = parseDbTimestampMs(fromTs);
  return Number.isFinite(ms) ? Math.max(0, Math.round((toMs - ms) / 60_000)) : null;
}

function preview(content: string | null, max = 60): string {
  const s = (content ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export const EXPIRY_GUIDANCE_ZH = "建议:换一个空闲的节点重新派(已过期的任务不能 reassign_task),或稍后用 retry_task 让它在原节点重新排队;不要原样重发一条新任务 —— 重发只会让它的队列更长。";
export const EXPIRY_GUIDANCE_EN = "Consider sending it to another node or retry_task later; do not blindly resend.";

export type ExpiryNoticeInput = {
  target: string;
  tasks: Array<{ task_id: string; content: string | null; waited_min: number | null; ttl_min: number | null }>;
  queued_ahead: number | null;
};

const fmtMin = (m: number | null) => (m === null ? "?" : String(m));

/** 给派活一方的正文。单条与多条两种形状;人和 agent 读同一份。 */
export function expiryNoticeText(n: ExpiryNoticeInput): { title: string; text: string } {
  const count = n.tasks.length;
  const ahead = n.queued_ahead === null ? "" : `过期时 ${n.target} 上还有 ${n.queued_ahead} 个比它早、没结束的任务。\n`;
  const aheadEn = n.queued_ahead === null ? "" : `, ${n.queued_ahead} open task(s) ahead`;
  if (count === 1) {
    const t = n.tasks[0];
    const ttl = t.ttl_min === null ? "" : `(期限 ${t.ttl_min} 分钟)`;
    return {
      title: "任务已过期",
      text: `[Hub] 任务已过期:你派给 ${n.target} 的任务 ${t.task_id} 等了 ${fmtMin(t.waited_min)} 分钟仍没被取走${ttl},Hub 已把它结束为 expired,${n.target} 不会再执行它。\n`
        + ahead
        + `内容:${preview(t.content)}\n`
        + `${EXPIRY_GUIDANCE_ZH}\n`
        + `Task ${t.task_id} to ${n.target} expired unconsumed after ${fmtMin(t.waited_min)} min${aheadEn}. ${EXPIRY_GUIDANCE_EN}`,
    };
  }
  const waited = n.tasks.map((t) => t.waited_min).filter((m): m is number => m !== null);
  const longest = waited.length ? Math.max(...waited) : null;
  const lines = n.tasks.slice(0, MAX_LISTED).map((t) => `- ${t.task_id} 等了 ${fmtMin(t.waited_min)} 分钟:${preview(t.content, 40)}`);
  if (count > MAX_LISTED) lines.push(`- …另外 ${count - MAX_LISTED} 个`);
  return {
    title: `${count} 个任务已过期`,
    text: `[Hub] ${count} 个任务已过期:你派给 ${n.target} 的 ${count} 个任务都没被取走(最长等了 ${fmtMin(longest)} 分钟),Hub 已把它们结束为 expired,${n.target} 不会再执行。\n`
      + ahead
      + `${lines.join("\n")}\n`
      + `${EXPIRY_GUIDANCE_ZH}\n`
      + `${count} tasks to ${n.target} expired unconsumed (longest wait ${fmtMin(longest)} min${aheadEn}). ${EXPIRY_GUIDANCE_EN}`,
  };
}

/** 父任务发送方收到的正文:子任务过期了,父任务**没有**被结束。 */
export function childExpiryNoticeText(p: { parent_task_id: string; parent_target: string; child_target: string; child_task_ids: string[] }): { title: string; text: string } {
  const n = p.child_task_ids.length;
  return {
    title: "子任务已过期",
    text: `[Hub] 子任务已过期:你派给 ${p.parent_target} 的任务 ${p.parent_task_id} 拆出的 ${n} 个子任务(派给 ${p.child_target}:${p.child_task_ids.join(", ")})没被取走,已结束为 expired。`
      + `父任务没有被结束,仍由 ${p.parent_target} 处理;它也收到了过期通知。\n`
      + `Sub-task(s) of ${p.parent_task_id} sent by ${p.parent_target} to ${p.child_target} expired unconsumed; the parent task is still open.`,
  };
}

/** 审计:task_events 记一笔「通知过谁」。不用 logTaskEvent:它按 to_status 派生 event_type,
 *  写 expired 会多出一条 task.expired,让按事件数过期的统计翻倍。 */
function noteEvent(taskId: string, status: string, detail: string): void {
  try {
    db.run(
      `INSERT INTO task_events (task_id, from_status, to_status, event_type, actor, detail, network_id)
       VALUES (?1, ?2, ?2, 'task.expiry_notice', 'patrol', ?3, (SELECT network_id FROM tasks WHERE task_id = ?1))`,
      [taskId, status, detail],
    );
  } catch {}
}

function deliverToAgent(alias: string, networkId: string | null, inReplyTo: string, text: string, meta: Record<string, unknown>): string {
  const id = `exp_${uuidv4().replace(/-/g, "").slice(0, 20)}`;
  const nodeId = agentSession(alias, networkId)?.node_id ?? null;
  db.run(
    `INSERT INTO inbox (id, session_name, node_id, type, priority, content, from_session, in_reply_to, requires_response, network_id, meta_json)
     VALUES (?1, ?2, ?3, 'reply', 'normal', ?4, 'hub', ?5, 'none', ?6, ?7)`,
    [id, alias, nodeId, text, inReplyTo, networkId, JSON.stringify(meta)],
  );
  pushEvent(alias, { type: "new_reply", inbox_count: pendingInboxCount(alias, networkId), from: "hub", message_id: id, in_reply_to: inReplyTo, status: "expired" }, networkId);
  return id;
}

function deliver(
  route: Extract<ExpirySenderRoute, { kind: "agent" | "user" }>,
  networkId: string | null,
  fromAlias: string,
  inReplyTo: string,
  notice: { title: string; text: string },
  meta: Record<string, unknown>,
): string | null {
  if (route.kind === "agent") return deliverToAgent(route.alias, networkId, inReplyTo, notice.text, meta);
  if (!networkId) return null;
  return sendAgentNotice({
    networkId, userId: route.userId, fromAlias, kind: TASK_EXPIRED_NOTICE_KIND,
    title: notice.title, text: notice.text, severity: "warning", meta, idPrefix: "dm_expired_",
  });
}

/**
 * 巡检提交之后调用。返回发出去的通知(测试用)。任何一组失败只记日志,不影响别的组。
 */
export function notifyExpiredTasks(rows: ExpiredTaskRow[], nowMs = Date.now()): ExpiryNoticeSent[] {
  const sent: ExpiryNoticeSent[] = [];
  if (rows.length === 0) return sent;

  // 网络观察者(Dashboard 任务页):与 send_reply 同一个摘要事件,只带路由元数据,让任务行刷新成 expired。
  for (const r of rows) {
    try { pushNetworkObserverEvent(r.network_id, { type: "new_reply", task_id: r.task_id, message_id: null, from: "hub", to: r.from_name ?? null, status: "expired" }); } catch {}
  }

  // 1. 给派活的一方:按 (网络, 发送方, 目标) 合并。
  const groups = new Map<string, ExpiredTaskRow[]>();
  for (const r of rows) {
    const key = JSON.stringify([r.network_id ?? null, r.from_name ?? "", r.to_name]);
    const g = groups.get(key);
    if (g) g.push(r); else groups.set(key, [r]);
  }
  for (const group of groups.values()) {
    try {
      group.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      const head = group[0];
      const route = classifyExpirySender(head);
      if (route.kind === "none") continue;
      const newest = group[group.length - 1];
      const input: ExpiryNoticeInput = {
        target: head.to_name,
        tasks: group.map((t) => ({
          task_id: t.task_id,
          content: t.content,
          waited_min: minutesBetween(t.created_at, nowMs),
          ttl_min: t.created_at && t.expires_at
            ? Math.round((parseDbTimestampMs(t.expires_at) - parseDbTimestampMs(t.created_at)) / 60_000)
            : null,
        })),
        queued_ahead: openTasksAhead(head.to_name, head.network_id, newest.created_at),
      };
      const notice = expiryNoticeText(input);
      const taskIds = group.map((t) => t.task_id);
      const meta = { task_expired: { target: head.to_name, task_ids: taskIds, queued_ahead: input.queued_ahead } };
      const id = deliver(route, head.network_id, head.to_name, newest.task_id, notice, meta);
      if (id) {
        sent.push({ route: route.kind, recipient: route.kind === "agent" ? route.alias : route.userId, target: head.to_name, task_ids: taskIds, message_id: id, about: "task" });
        for (const t of group) noteEvent(t.task_id, "expired", `notified ${route.kind} ${route.kind === "agent" ? route.alias : route.username}`);
      }
    } catch (e: any) {
      console.error(`[patrol] expiry notice failed: ${e?.message || e}`);
    }
  }

  // 2. 父任务:按父任务合并,只通知,不改父任务的状态 / result。跨网络的父任务不碰。
  const byParent = new Map<string, ExpiredTaskRow[]>();
  for (const r of rows) {
    if (!r.parent_task_id) continue;
    const g = byParent.get(r.parent_task_id);
    if (g) g.push(r); else byParent.set(r.parent_task_id, [r]);
  }
  for (const [parentId, children] of byParent) {
    try {
      const parent = db.get<{ task_id: string; from_name: string | null; from_node_id: string | null; to_name: string; status: string; network_id: string | null; meta_json: string | null }>(
        "SELECT task_id, from_name, from_node_id, to_name, status, network_id, meta_json FROM tasks WHERE task_id = ?1",
        parentId,
      );
      if (!parent) continue;
      const childNet = children[0].network_id ?? null;
      if ((parent.network_id ?? null) !== childNet) continue;
      const childIds = children.map((c) => c.task_id);
      const childTargets = [...new Set(children.map((c) => c.to_name))].join(", ");
      noteEvent(parent.task_id, parent.status, `child expired: ${childIds.join(",")} → ${childTargets}`);
      const route = classifyExpirySender(parent);
      if (route.kind === "none") continue;
      const notice = childExpiryNoticeText({ parent_task_id: parent.task_id, parent_target: parent.to_name, child_target: childTargets, child_task_ids: childIds });
      const meta = { task_expired: { parent_task_id: parent.task_id, target: childTargets, task_ids: childIds } };
      const id = deliver(route, parent.network_id, parent.to_name, parent.task_id, notice, meta);
      if (id) sent.push({ route: route.kind, recipient: route.kind === "agent" ? route.alias : route.userId, target: childTargets, task_ids: childIds, message_id: id, about: "child" });
    } catch (e: any) {
      console.error(`[patrol] child-expiry notice failed parent=${parentId}: ${e?.message || e}`);
    }
  }
  return sent;
}
