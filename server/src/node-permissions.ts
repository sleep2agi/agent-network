// RFC-041 第一阶段(board #487):节点(Agent)自己的权限 —— 先记录、后执行。
//
// 节点的权限 = 主人的权限 ∩ 节点的模式(nodes.permission_mode:normal 正常 / readonly 只读 / restricted 受限)。
//
//   • 模式是主人主动设的,**设了就立刻生效**(不看开关):只读的节点写什么都拒(mode_readonly);
//     受限的节点只碰派给它的任务、派活只给主人授权的 Agent(mode_restricted_not_assigned / agent_not_granted_to_owner)。
//   • 正常模式下的收紧(超出主人可见范围 beyond_owner_visibility、主人没被授权的 Agent agent_not_granted_to_owner、
//     只有人能做的事 human_only)由 Hub 开关 COMMHUB_NODE_PERMISSIONS 决定:
//       log(默认)—— 照常放行,只把「本来会被拒」按 (节点, 路由, 原因, 小时) 合并记进 node_permission_log;
//       enforce   —— 记录并拒绝(REST 403 / MCP 错误 node_permission_denied + reason + hint);
//       off       —— 不判也不记(显式模式仍然生效)。
//
// 判定的入口:REST(requirements.ts、/api/task、/api/broadcast、/api/nodes/:id 写)、MCP(tools.ts 按工具名包一层)、
// SSE(/events/:session、/events/network/:id)。只对节点令牌(ntok_)生效;用户令牌一条不变。
// 只增不改:nodes 多一列 permission_mode(默认 normal),新表 node_permission_log。回滚到上一版安全:旧代码不读它们。

import { db } from "./db.js";
import { canMessageAgent, type AgentRef } from "./agent-access.js";
import { resolveNodeCaller } from "./create-node.js";

export type NodePermissionMode = "normal" | "readonly" | "restricted";
export const NODE_PERMISSION_MODES: readonly NodePermissionMode[] = ["normal", "readonly", "restricted"];
export type NodePermissionsFlag = "log" | "off" | "enforce";
export type NodePermissionReason =
  | "beyond_owner_visibility"
  | "agent_not_granted_to_owner"
  | "mode_readonly"
  | "mode_restricted_not_assigned"
  | "human_only"
  | "owner_unknown";

/** 显式模式的原因:不看开关,永远拒。 */
const MODE_REASONS: ReadonlySet<NodePermissionReason> = new Set(["mode_readonly", "mode_restricted_not_assigned"]);

try { db.exec("ALTER TABLE nodes ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'normal'"); } catch (e: any) {
  if (!/duplicate column|already exists/i.test(e?.message || "")) throw e;
}
db.exec(`
  CREATE TABLE IF NOT EXISTS node_permission_log (
    network_id TEXT NOT NULL,
    node_id    TEXT NOT NULL,
    route      TEXT NOT NULL,
    reason     TEXT NOT NULL,
    hour       TEXT NOT NULL,
    hits       INTEGER NOT NULL DEFAULT 1,
    sample     TEXT,
    PRIMARY KEY (network_id, node_id, route, reason, hour)
  );
  CREATE INDEX IF NOT EXISTS idx_node_permission_log_hour ON node_permission_log(network_id, hour);
`);

/** 开关。未设 / 写错 → log(安全的默认:只记不拦)。每次现读:测试和运维改环境变量后无需重启模块。 */
export function nodePermissionsFlag(): NodePermissionsFlag {
  const raw = (process.env.COMMHUB_NODE_PERMISSIONS ?? "").trim().toLowerCase();
  return raw === "off" || raw === "enforce" ? raw : "log";
}

export type NodeIdentity = {
  networkId: string;
  /** 绑定的节点;老的未绑定令牌 = null(按「正常」判,记录时用 token:<token_id>)。 */
  nodeId: string | null;
  logKey: string;
  aliases: string[];
  ownerUserId: string | null;
  mode: NodePermissionMode;
};

function normalizeMode(raw: unknown): NodePermissionMode {
  return raw === "readonly" || raw === "restricted" ? raw : "normal";
}

/** 节点令牌 → 节点身份(一次带索引的查询)。不是节点令牌 / 查不到 → null。 */
export function nodeIdentity(tokenId: string | null | undefined, networkId: string | null | undefined): NodeIdentity | null {
  if (!tokenId || !networkId) return null;
  const row = db.get<{ user_id: string | null; name: string | null }>(
    `SELECT user_id, name FROM api_tokens WHERE token_id = ?1 AND network_id = ?2`,
    tokenId, networkId,
  );
  if (!row) return null;
  const resolved = resolveNodeCaller(tokenId);
  // Revoked or not node-shaped: this lookup is not a second revocation gate.
  if (!resolved.ok && resolved.reason === "not_a_node_token") {
    const aliases = row.name?.startsWith("node:") ? [row.name.slice(5)] : [];
    return {
      networkId,
      nodeId: null,
      logKey: `token:${tokenId}`,
      aliases,
      ownerUserId: row.user_id,
      mode: "normal",
    };
  }
  if (!resolved.ok || resolved.networkId !== networkId) {
    return {
      networkId,
      nodeId: null,
      logKey: `token:${tokenId}`,
      aliases: [],
      ownerUserId: row.user_id,
      mode: "normal",
    };
  }
  if (resolved.kind === "unregistered") {
    return {
      networkId,
      nodeId: null,
      logKey: `token:${tokenId}`,
      aliases: resolved.alias ? [resolved.alias] : [],
      ownerUserId: row.user_id,
      mode: "normal",
    };
  }
  const node = db.get<{ owner_user_id: string | null; permission_mode: string | null }>(
    `SELECT owner_user_id, permission_mode FROM nodes WHERE node_id = ?1 AND network_id = ?2`,
    resolved.nodeId, networkId,
  );
  return {
    networkId,
    nodeId: resolved.nodeId,
    logKey: resolved.nodeId,
    aliases: [resolved.alias],
    ownerUserId: node?.owner_user_id || row.user_id || null,
    mode: normalizeMode(node?.permission_mode),
  };
}

export type Verdict = { reason: NodePermissionReason; sample?: string } | null;

/**
 * 判一次:verdict=null → 放行;否则按原因和开关决定拒不拒,并记一行(off 时正常模式的原因不记)。
 * 返回 true = 拒绝。
 */
export function nodeDecide(id: NodeIdentity, route: string, verdict: Verdict): boolean {
  if (!verdict) return false;
  const explicit = MODE_REASONS.has(verdict.reason);
  const flag = nodePermissionsFlag();
  if (!explicit && flag === "off") return false;
  recordNodePermission(id, route, verdict.reason, verdict.sample);
  return explicit || flag === "enforce";
}

const HINTS: Record<NodePermissionReason, string> = {
  beyond_owner_visibility: "this node acts with its owner's permissions, and its owner cannot see or edit this; ask the owner for access, or assign the task to this node",
  agent_not_granted_to_owner: "this Agent has not been granted to this node's owner; ask a network admin to grant it",
  mode_readonly: "this node is in read-only mode; the node's owner can switch it to normal in the app",
  mode_restricted_not_assigned: "this node is in restricted mode and only touches tasks assigned to it; assign the task to this node, or have the owner switch it to normal",
  human_only: "only people can do this (members, projects, permissions, providers, secrets, other nodes); use a user token",
  owner_unknown: "this node's owner is unknown; recreate the node token from the owner's account",
};

export function nodePermissionDeniedBody(reason: NodePermissionReason, route: string): { ok: false; error: "node_permission_denied"; reason: NodePermissionReason; route: string; hint: string } {
  return { ok: false, error: "node_permission_denied", reason, route, hint: HINTS[reason] };
}

// ── 记录:按 (网络, 节点, 路由, 原因, 小时) 合并;有上限、会清理 ──
export const LOG_RETENTION_DAYS = 30;
export const LOG_MAX_ROWS = 20_000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;
let lastPrune = 0;
let logFull = false;

function hourOf(now = new Date()): string {
  return now.toISOString().slice(0, 13); // 2026-10-03T08
}

/** 清掉保留期外的行,并重新判断是否到了上限(到上限后只给已有的行加次数,不再新开行)。 */
export function pruneNodePermissionLog(now = new Date()): void {
  const cutoff = hourOf(new Date(now.getTime() - LOG_RETENTION_DAYS * 86_400_000));
  db.run("DELETE FROM node_permission_log WHERE hour < ?1", [cutoff]);
  const n = Number(db.get<{ n: number | string }>("SELECT COUNT(*) AS n FROM node_permission_log")?.n ?? 0);
  logFull = n >= LOG_MAX_ROWS;
  lastPrune = now.getTime();
}

export function recordNodePermission(id: NodeIdentity, route: string, reason: NodePermissionReason, sample?: string): void {
  try {
    const now = new Date();
    if (now.getTime() - lastPrune > PRUNE_EVERY_MS) pruneNodePermissionLog(now);
    const hour = hourOf(now);
    const s = sample ? sample.slice(0, 200) : null;
    const updated = db.run(
      "UPDATE node_permission_log SET hits = hits + 1, sample = COALESCE(?6, sample) WHERE network_id = ?1 AND node_id = ?2 AND route = ?3 AND reason = ?4 AND hour = ?5",
      [id.networkId, id.logKey, route.slice(0, 120), reason, hour, s],
    );
    if (Number(updated?.changes ?? 0) > 0 || logFull) return;
    db.run(
      `INSERT INTO node_permission_log (network_id, node_id, route, reason, hour, hits, sample) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)
       ON CONFLICT(network_id, node_id, route, reason, hour) DO UPDATE SET hits = node_permission_log.hits + 1`,
      [id.networkId, id.logKey, route.slice(0, 120), reason, hour, s],
    );
  } catch (e) {
    // 记录失败绝不影响请求本身。
    console.error(`[node-permissions] log failed: ${(e as Error).message}`);
  }
}

/** Test-only:让下一次记录先清理一遍,并可改上限判断。 */
export function __resetNodePermissionLogStateForTest(): void { lastPrune = 0; logFull = false; }

// ── 规则 ──

/** 派活 / 发消息 / 重派给 target。发给自己永远可以。 */
export function dispatchVerdict(id: NodeIdentity, target: AgentRef): Verdict {
  if ((target.alias && id.aliases.includes(target.alias)) || (target.nodeId && id.nodeId && target.nodeId === id.nodeId)) return null;
  const sample = target.alias ?? target.nodeId ?? undefined;
  if (id.mode === "readonly") return { reason: "mode_readonly", sample };
  if (!id.ownerUserId) return id.mode === "restricted" ? { reason: "mode_restricted_not_assigned", sample } : { reason: "owner_unknown" };
  if (!canMessageAgent(id.ownerUserId, id.networkId, target)) {
    // 受限是主人设的 → 必拒(模式原因);正常下是开关管的收紧。
    return { reason: id.mode === "restricted" ? "mode_restricted_not_assigned" : "agent_not_granted_to_owner", sample };
  }
  return null;
}

/** 广播:只读 / 受限都不行(会发给没派给它、也未必授权的 Agent)。 */
export function broadcastVerdict(id: NodeIdentity): Verdict {
  if (id.mode === "readonly") return { reason: "mode_readonly" };
  if (id.mode === "restricted") return { reason: "mode_restricted_not_assigned" };
  if (!id.ownerUserId) return { reason: "owner_unknown" };
  return null;
}

/** 一般的写(管节点、提交技能、探测模型…):只读 / 受限拒;正常放行(由各自的既有规则管)。 */
export function writeVerdict(id: NodeIdentity, sample?: string): Verdict {
  if (id.mode === "readonly") return { reason: "mode_readonly", sample };
  if (id.mode === "restricted") return { reason: "mode_restricted_not_assigned", sample };
  return null;
}

/** 只有人能做的事。只读 / 受限下报模式原因(那是主人设的、必拒);正常下报 human_only。 */
export function humanOnlyVerdict(id: NodeIdentity, sample?: string): Verdict {
  return writeVerdict(id, sample) ?? { reason: "human_only", sample };
}

/** 订阅别的会话 / 整个网络的推送流:受限不行;正常按主人能不能看到那个 Agent。 */
export function streamVerdict(id: NodeIdentity, target: AgentRef | "network"): Verdict {
  if (target !== "network" && ((target.alias && id.aliases.includes(target.alias)) || (target.nodeId && target.nodeId === id.nodeId))) return null;
  if (id.mode === "restricted") return { reason: "mode_restricted_not_assigned", sample: target === "network" ? "network" : target.alias ?? undefined };
  if (!id.ownerUserId) return { reason: "owner_unknown" };
  if (target !== "network" && !canMessageAgent(id.ownerUserId, id.networkId, target)) {
    return { reason: "beyond_owner_visibility", sample: target.alias ?? undefined };
  }
  return null;
}

// ── MCP:每个工具归一类(test 钉住「每个注册的工具都归了类」,新工具忘了归类会红) ──
export type ToolClass = "always" | "read" | "dispatch" | "broadcast" | "requirements" | "schedule" | "node_write" | "human_only";
export const NODE_TOOL_CLASS: Readonly<Record<string, ToolClass>> = {
  // 回复 / 上报 / 自己的收件箱 / 生命周期协议(节点自己的请求)—— 任何模式都能做
  report_status: "always", report_completion: "always", get_inbox: "always", ack_inbox: "always",
  mark_tasks_runtime_submitted: "always", mark_tasks_consumed: "always", send_reply: "always", send_peer_reply: "always", send_ack: "always",
  get_config_update: "always", ack_config_update: "always", get_rules_file_request: "always", ack_rules_file_request: "always", get_rules_file_result: "always",
  get_create_request: "always", ack_create_request: "always", get_stop_request: "always", ack_stop_request: "always",
  get_start_request: "always", ack_start_request: "always", get_probe_request: "always", ack_probe_request: "always",
  list_my_pending_create_requests: "always", list_my_pending_lifecycle_requests: "always", list_my_children: "always",
  request_adopt_node: "human_only", unadopt_node: "human_only",
  get_adopt_request: "always", ack_adopt_request: "always",
  send_desktop_message: "always", // 发给人的私信,不是派活
  // 读
  get_all_status: "read", get_session_status: "read", get_task: "read", list_tasks: "read", get_completions: "read", org_whoami: "read",
  list_skills: "read", get_skill: "read", list_host_supervisors: "read", list_network_secrets: "read", list_providers: "read",
  get_probe_results: "read", read_node_rules_file: "read", list_node_skills: "read", read_node_skill: "read", list_node_files: "read",
  read_node_file: "read", tail_node_logs: "read",
  // 派活
  send_task: "dispatch", send_message: "dispatch", retry_task: "dispatch", reassign_task: "dispatch", cancel_task: "dispatch",
  broadcast: "broadcast",
  // 任务看板:在 requirements.ts 里按卡判(REST 与 MCP 同一处)
  requirements_list: "requirements", requirements_people: "requirements", requirements_get: "requirements", requirements_create: "requirements",
  requirements_update: "requirements", requirements_checklist_toggle: "requirements", requirements_upsert_by_external_ref: "requirements",
  requirements_events: "requirements", requirements_comment: "requirements", projects_list: "requirements",
  // 定时任务(#733):在 schedule-agent.ts 里按排程判(范围 / 目标 = send_task 的 dispatchVerdict / 配额)
  schedule_list: "read", schedule_get: "read", schedule_runs: "read",
  schedule_create: "schedule", schedule_update: "schedule", schedule_cancel: "schedule", schedule_run_now: "schedule",
  // 写节点 / 技能 / 探测:只读、受限不行;正常由 RFC-036 等既有规则管
  update_node_config: "node_write", write_node_rules_file: "node_write", restart_node: "node_write", create_node: "node_write",
  stop_node: "node_write", delete_node: "node_write", start_node: "node_write", submit_skill: "node_write", probe_provider_model: "node_write",
  // 只有人能做
  upsert_network_secret: "human_only", upsert_provider: "human_only", update_provider: "human_only",
  projects_create: "human_only", projects_update: "human_only", review_skill: "human_only",
};
