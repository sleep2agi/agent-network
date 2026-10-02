import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseDbTimestampMs } from "./db-timestamp.js";
import { z } from "zod/v4";
import { nodeHealthSchema, recordNodeHealth } from "./node-health-store.js";
import { assertNodeHealthy } from "./node-health-guard.js";
import { noteModelAuthHealth } from "./model-auth-notify.js";
import { parseAliasFilter } from "./alias-filter.js";
import { createHash } from "node:crypto";
import { db, uuidv4, logTaskEvent, chainReplyToParent, hashToken, generateId, generateNetworkToken, syncScheduledRunForTask } from "./db.js";
import { getSSEStats, hasSubscribers, hasUserSubscribers, pushEvent, pushNetworkObserverEvent, pushUserEvent } from "./push.js";
import { assertNodeActive } from "./lifecycle-guard.js";
import { pendingInboxCount } from "./inbox-count.js";
import { getUserNetworkRole, createNetworkTokenForNode } from "./auth.js";
import { addAgentNetworkScope, addNetworkScope, addOwnTrafficScope, canRestWriteNetwork, canRestWriteNetworkAsHuman, getUserNetworkIds, resolveRestNetworkScope, singleNetworkId, type RestNetworkScope } from "./network-scope.js";
import { canMessageAgent, restrictedNetworkIds, RESTRICTED_MEMBER_TOOLS, type AgentRef } from "./agent-access.js";
import { listedToolFilter, scopeToolsList, type ToolCaller } from "./tool-audience.js";
import { broadcastVerdict, dispatchVerdict, humanOnlyVerdict, NODE_TOOL_CLASS, nodeDecide, nodeIdentity, nodePermissionDeniedBody, writeVerdict, type NodeIdentity, type Verdict } from "./node-permissions.js";
import { restrictedMemberAttachmentsDenied } from "./restricted-files.js";
import { errorBody } from "./requirements-errors.js";
import { handleRequirementsRequest } from "./requirements.js";
import {
  buildAnetArgs as _unused_buildAnetArgs,           // ensure module is loaded
  validateName as validateChildName,
  validateRuntime,
  validateModel,
  validateChannelsP1,
  validateWorkdir,
  daemonDefaultWorkdirRoot,
  validateEnvRefs,
  FLAG_KEYS,
  validateFlagValue,
  ValidationError,
} from "./create-node-validate.js";
import {
  putPendingEnvBlob,
  takePendingEnvBlob,
  newRequestId,
  finalizeCreateOnFirstRegister,
  startPendingEnvGcTimer,
  startSweeperTimer,
  auditCreateNode,
  auditCreateNodeStrict,
  resolveCallerDaemonTokenBound as _resolveCallerDaemonTokenBound,
} from "./create-node.js";
import {
  vaultUpsert, vaultGet, vaultListKeys, vaultDelete,
  VaultError,
} from "./vault.js";
import { stripHostLocalPathsForCrossHostSafe, validateAttachments } from "./uploads.js";
import {
  validateBaseUrl as _validateBaseUrl,
  SUPPORTED_VENDORS,
  ProbeValidationError,
} from "./probe-validate.js";
import {
  putPendingProbeSecret,
  newProbeId,
  finalizeProbeAck,
  startPendingProbeGcTimer,
  startProbeSweeperTimer,
} from "./probe.js";
import { canonicalAliasExists, cleanupRenamedAliasSession, resolveCanonicalAlias } from "./rename.js";
import {
  ALLOWED_FLAGS,
  SECURITY_SENSITIVE_FLAGS,
  EDITABLE_CHANNELS,
  computeApplyMode,
  validatePatch,
  narrowChannelsPatch,
  isAllowedToChangeFlag,
} from "./config-apply-validate.js";
import { sharedSendDedup, buildDuplicateSendPayload } from "./send_dedup.js";
import { clientRequestIdFromMeta, idempotentTaskId, idempotentTaskMatches, type StoredIdempotentTask } from "./task-idempotency.js";
import { stampTaskAuthOrigin, type TaskAuthOrigin } from "./task-auth-origin.js";
import { parseHubTimestamp } from "./hub-timestamp";
import { noteTerminalResultRead, purgeLogsResultNow, sweepNodeRequestContent } from "./node-request-retention.js";

function ts(): string {
  return new Date().toTimeString().slice(0, 8);
}

function parseMetaJson(value: unknown): unknown | null {
  if (!value || typeof value !== "string") return null;
  try { return JSON.parse(value); } catch { return null; }
}

function normalizeMetaJson(meta: unknown): string | null {
  if (!meta || typeof meta !== "object") return null;
  // #222 cross-host safety — strip `path` from meta.attachments[] when
  // `file_id` is also present. Shared helper lives in uploads.ts so the
  // REST handler in index.ts can apply the identical sanitization
  // (otherwise REST and MCP transports would have different meta_json
  // shapes for the same send).
  try { return JSON.stringify(stripHostLocalPathsForCrossHostSafe(meta)); } catch { return null; }
}

/**
 * 定时任务的回复收件人。scheduler 派的任务 from_name='scheduler',回复按 from_name 落进
 * inbox(session_name='scheduler')—— 没有任何人读那一行,于是建排程的人在 app 里看得到回复
 * (会话取自 tasks 表)却永远没有未读红点(unread_by_agent 只数 session_name=用户名 的行)。
 * 排程是「建它的人」的委托(见 scheduled-tasks.ts canMessageAgent),回复送到他的用户名下。
 *
 * 退回 null(= 照旧送 'scheduler')的情形:任务不是 scheduler 派的 / meta 没有排程 id /
 * 排程没有 created_by(外部或旧排程)/ 用户已不存在 / 用户名与本网络某个节点 alias 撞名
 * (那一行会变成那个节点的待办,不是用户的未读 —— 与 server.ts userInboxAliasCollides 同一条规则)。
 * 只改投递地址;任务归属、reply_target_mismatch 等校验仍按原始发送方 'scheduler' 判。
 */
function scheduledReplyRecipient(taskId: string, networkId: string | null | undefined): string | null {
  const params: any[] = [taskId];
  let sql = "SELECT from_name, meta_json, network_id FROM tasks WHERE task_id = ?1";
  if (networkId) { params.push(networkId); sql += " AND network_id = ?2"; }
  const task = db.get<{ from_name: string; meta_json: string | null; network_id: string | null }>(sql, ...params);
  if (!task || task.from_name !== "scheduler") return null;
  const meta = parseMetaJson(task.meta_json) as { scheduled_task_id?: unknown } | null;
  const scheduleId = meta && typeof meta.scheduled_task_id === "string" ? meta.scheduled_task_id : "";
  if (!scheduleId) return null;
  const owner = db.get<{ username: string | null }>(
    `SELECT u.username AS username FROM scheduled_tasks s JOIN users u ON u.user_id = s.created_by
     WHERE s.schedule_id = ?1 AND s.network_id = ?2`,
    scheduleId, task.network_id,
  );
  const username = owner?.username?.trim();
  if (!username) return null;
  const collides = db.get<{ hit: number }>(
    "SELECT 1 AS hit FROM nodes WHERE alias = ?1 AND network_id = ?2 LIMIT 1",
    username, task.network_id,
  );
  return collides ? null : username;
}

// ── #1281 — 子节点生命周期工具的参数名统一 ────────────────────────────
//
// stop_node / start_node / delete_node 历史上用 `child_node_id`（RFC-027），
// restart_node / update_node_config 用 `node_id`。同一个对象（子节点）两个名字，
// 调用方按一个工具的习惯给另一个传就吃 -32602。两侧都已是**已发布契约**
// （start_node 随 #1273 合入），且 hub API 在 RFC-030 混版滚动期老客户端还在
// 发老名——所以不能硬改名，改为**两个名字都接受**：
//   · canonical = `node_id`（= DB 列 nodes.node_id、= create_node 的输出、
//     restart/update 历史用名；「建完节点→再操作它」用同一个名才是傻瓜式）。
//   · `child_node_id` 作为**兼容 alias 保留** + deprecation 注释；不加运行时
//     warning（老客户端是设计内兼容，不是错误，别刷屏）。
// create_node 的 `daemon_node_id` 指宿主 daemon，是另一层语义，不在本次统一内。
//
// server.tool 收的是 ZodRawShape（裸对象），挂不了 .refine()，所以「至少一个
// 必填」+「两个都传须相等」在 handler 侧用 resolveNodeIdArg 兜——返回结构化
// ok:false 反而比 schema 层的 -32602 更友好。两个名字在 schema 层都做成
// optional + 宽松 .min(1).max(200)（不带 regex），使命名与校验强度同时统一：
// 对 restart/update 不变（本就宽松），对 stop/start/delete 是放宽（原 regex 会
// 在 schema 层挡掉 alias/杂串，放宽后落到查表返回 node_not_found，对合法调用
// 方无影响，只是错误形态更一致）。
const NODE_ID_ALIAS_FIELDS = {
  node_id: z.string().min(1).max(200).optional()
    .describe("Child node id (as returned by create_node), in your network."),
  child_node_id: z.string().min(1).max(200).optional()
    .describe("Deprecated alias of node_id."),
} as const;

/** #1281 — 把 node_id / child_node_id 收敛成单一内部 id。两个都传且不等 ⇒
 *  node_id_conflict（挡「node_id 填 A、child_node_id 填 B」的手滑，比单纯二选一强）；
 *  都不传 ⇒ node_id_required。纯函数，模块级导出以便单测直接验解析逻辑。 */
export function resolveNodeIdArg(a: { node_id?: string; child_node_id?: string }):
  { ok: true; node_id: string } | { ok: false; error: string; message: string } {
  const n = a.node_id, c = a.child_node_id;
  if (n && c && n !== c) {
    return { ok: false, error: "node_id_conflict", message: "node_id and child_node_id both provided but differ; send only one (they are aliases for the same child node)" };
  }
  const id = n ?? c;
  if (!id) {
    return { ok: false, error: "node_id_required", message: "one of node_id / child_node_id is required (child_node_id is a deprecated alias; prefer node_id)" };
  }
  return { ok: true, node_id: id };
}

function guardRestrictedMemberTools(server: McpServer, restrictedNets: string[], _userId: string): void {
  const denied = (tool: string) => ({
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        ok: false,
        error: "agent_access_restricted",
        message: `${tool} is not available to restricted members in this network; pass network_id of a network where you are not restricted, or ask a network admin for access`,
      }),
    }],
  });
  const wrap = (name: string, handler: (...callArgs: any[]) => any) => async (...callArgs: any[]) => {
    if (!RESTRICTED_MEMBER_TOOLS.has(name)) {
      const args = callArgs[0];
      const raw = args && typeof args === "object" ? (args as Record<string, unknown>).network_id : undefined;
      const net = typeof raw === "string" && raw.trim() ? raw.trim() : null;
      if (!net || restrictedNets.includes(net)) return denied(name);
    }
    return handler(...callArgs);
  };
  const anyServer = server as any;
  for (const method of ["tool", "registerTool"] as const) {
    const original = anyServer[method].bind(server);
    anyServer[method] = (...regArgs: any[]) => {
      const last = regArgs.length - 1;
      if (typeof regArgs[0] === "string" && typeof regArgs[last] === "function") regArgs[last] = wrap(regArgs[0], regArgs[last]);
      return original(...regArgs);
    };
  }
}

// RFC-041 第一阶段(#487):节点令牌的每个 MCP 工具先按 NODE_TOOL_CLASS 判一次(node-permissions.ts)。
// log 模式下正常节点照常放行、只记录;显式的只读 / 受限模式立刻生效。requirements_* 在 requirements.ts 里按卡判。
function guardNodePermissionTools(server: McpServer, tokenId: string, networkId: string): void {
  const denied = (reason: Parameters<typeof nodePermissionDeniedBody>[0], route: string) => ({
    content: [{ type: "text" as const, text: JSON.stringify(nodePermissionDeniedBody(reason, route)) }],
  });
  const taskTarget = (taskId: unknown): { to: AgentRef; from: string | null } | null => {
    if (typeof taskId !== "string" || !taskId) return null;
    const t = db.get<{ to_name: string | null; to_node_id: string | null; from_name: string | null }>(
      "SELECT to_name, to_node_id, from_name FROM tasks WHERE task_id = ?1 AND network_id = ?2", taskId, networkId);
    return t ? { to: { alias: t.to_name, nodeId: t.to_node_id }, from: t.from_name } : null;
  };
  const aliasTarget = (alias: unknown): AgentRef | null => {
    if (typeof alias !== "string" || !alias.trim()) return null;
    const canonical = resolveCanonicalAlias(networkId, alias.trim()).alias;
    const session = db.get<{ node_id: string | null }>("SELECT node_id FROM sessions WHERE alias = ?1 AND network_id = ?2", canonical, networkId);
    return { alias: canonical, nodeId: session?.node_id ?? null };
  };
  const verdictFor = (id: NodeIdentity, name: string, args: Record<string, unknown>): Verdict => {
    switch (NODE_TOOL_CLASS[name]) {
      case "dispatch": {
        if (name === "retry_task" || name === "cancel_task") {
          const t = taskTarget(args.task_id);
          if (!t) return null; // 没这个任务:交给工具自己回 not found
          if (name === "cancel_task" && t.from && id.aliases.includes(t.from)) return null; // 撤回自己派的
          return dispatchVerdict(id, t.to);
        }
        const target = aliasTarget(name === "reassign_task" ? args.new_alias : args.alias);
        return target ? dispatchVerdict(id, target) : null;
      }
      case "broadcast": return broadcastVerdict(id);
      case "node_write": return writeVerdict(id, name);
      case "human_only": return humanOnlyVerdict(id, name);
      default: return null; // always / read / requirements(按卡判)/ 没归类的(test 保证没有)
    }
  };
  const wrap = (name: string, handler: (...callArgs: any[]) => any) => async (...callArgs: any[]) => {
    const cls = NODE_TOOL_CLASS[name];
    if (cls && cls !== "always" && cls !== "read" && cls !== "requirements") {
      const id = nodeIdentity(tokenId, networkId);
      const args = callArgs[0] && typeof callArgs[0] === "object" ? callArgs[0] as Record<string, unknown> : {};
      const verdict = id ? verdictFor(id, name, args) : null;
      if (id && nodeDecide(id, `mcp:${name}`, verdict)) return denied(verdict!.reason, `mcp:${name}`);
    }
    return handler(...callArgs);
  };
  const anyServer = server as any;
  for (const method of ["tool", "registerTool"] as const) {
    const original = anyServer[method].bind(server);
    anyServer[method] = (...regArgs: any[]) => {
      const last = regArgs.length - 1;
      if (typeof regArgs[0] === "string" && typeof regArgs[last] === "function") regArgs[last] = wrap(regArgs[0], regArgs[last]);
      return original(...regArgs);
    };
  }
}

export function registerTools(server: McpServer, clientIP?: string, enforceNetworkId?: string | null, enforceUserId?: string | null, callerAlias?: string | null, callerTokenIsNetwork = false, callerTokenId?: string | null, listing: { includeProtocol?: boolean } = {}) {
  // 多用户 Agent 权限:用户令牌调用者在哪些网络里是受限成员(只看授权 Agent)。
  // 网络令牌不会走到这里 —— 受限成员的网络令牌在 resolveToken 就被拒了。
  const restrictedNets = enforceUserId && !callerTokenIsNetwork && !enforceNetworkId ? restrictedNetworkIds(enforceUserId) : [];
  if (restrictedNets.length) guardRestrictedMemberTools(server, restrictedNets, enforceUserId!);
  if (callerTokenIsNetwork && callerTokenId && enforceNetworkId) guardNodePermissionTools(server, callerTokenId, enforceNetworkId);
  // Default from_session for outbound tools — extracted from the calling
  // token's binding (ntok_ → node alias, utok_ → username). Without this,
  // an agent's send_task call always claimed from='hub' and peer agents
  // couldn't tell who actually asked them. Network-bound node tokens are an
  // identity boundary: they must not spoof another node via from_session.
  const defaultFrom = (clientFrom?: string) => (callerTokenIsNetwork && callerAlias) ? callerAlias : (clientFrom || callerAlias || "hub");
  const fromIdentityMismatchReply = (clientFrom?: string) => {
    const requestedFrom = clientFrom?.trim();
    if (!callerTokenIsNetwork || !callerAlias || !requestedFrom || requestedFrom === callerAlias) return null;
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          ok: false,
          error: "from_session_identity_mismatch",
          message: "network token from_session does not match token-bound node alias",
          token_alias: callerAlias,
          requested_from_session: requestedFrom,
        }),
      }],
    };
  };
  // MCP-side auth context in the shape network-scope.ts helpers take.
  // null = legacy global-token / open-dev mode (unscoped, allow-all).
  const mcpAuthCtx = enforceUserId ? { userId: enforceUserId, networkId: enforceNetworkId ?? null } : null;

  // If enforceNetworkId is set (ntok_), override any client-supplied
  // network_id. #517: for utok_ with no explicit network_id, fall back to
  // the user's single membership via the SAME singleNetworkId used by REST
  // POST /api/task (network-scope.ts) — utok_ rows carry network_id=null by
  // design, so without this fallback single-network nodes could read
  // everything but write nothing. Multi-network stays null (ambiguous) and
  // canWrite rejects with network_id_required.
  const getNetworkId = (clientNetId?: string | null) => {
    const explicit = enforceNetworkId ?? clientNetId ?? null;
    if (explicit !== null || !enforceUserId) return explicit;
    return singleNetworkId({ networkId: null, networkIds: getUserNetworkIds(enforceUserId) });
  };

  // Check write access — delegates to the shared canRestWriteNetwork so MCP
  // and REST cannot drift again (#517). isAdmin=false: MCP has no admin
  // bypass today; keep behavior identical to before the extraction.
  const canWrite = (effectiveNetworkId?: string | null): boolean => {
    const netId = enforceNetworkId ?? effectiveNetworkId ?? null;
    return canRestWriteNetwork(mcpAuthCtx, netId, false);
  };
  // 人类侧写入(私信):不看 Agent 授权,受限成员也可以。
  const canWriteHuman = (effectiveNetworkId?: string | null): boolean =>
    canRestWriteNetworkAsHuman(mcpAuthCtx, enforceNetworkId ?? effectiveNetworkId ?? null, false);
  // 给 Agent 发任务 / 消息的准入。不受限:原判据。受限网络里:目标必须是授权且 can_message 的 Agent,
  // 发件人固定为自己的用户名;目标不存在与没授权返回同一个错误,不留 alias 探测差异。
  const agentSendDenied = (effectiveNetworkId: string | null, alias: string, clientFrom: string | undefined, action: "send_task" | "write", meta?: unknown) => {
    if (!effectiveNetworkId || !restrictedNets.includes(effectiveNetworkId)) {
      return canWrite(effectiveNetworkId) ? null : writeDeniedReply(effectiveNetworkId, action);
    }
    if (!canWriteHuman(effectiveNetworkId)) return writeDeniedReply(effectiveNetworkId, action);
    const requestedFrom = clientFrom?.trim();
    if (requestedFrom && requestedFrom !== callerAlias) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "from_session_identity_mismatch", message: "restricted members always send as their own username" }) }] };
    }
    const targetAlias = resolveCanonicalAlias(effectiveNetworkId, alias).alias;
    const session = db.get<{ node_id: string | null }>("SELECT node_id FROM sessions WHERE alias = ?1 AND network_id = ?2", targetAlias, effectiveNetworkId);
    if (!session || !canMessageAgent(enforceUserId!, effectiveNetworkId, { alias: targetAlias, nodeId: session.node_id })) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "agent_not_granted", message: "this agent has not been granted to you; ask a network admin" }) }] };
    }
    const rawAttachments = meta && typeof meta === "object" ? (meta as { attachments?: unknown }).attachments : undefined;
    if (restrictedMemberAttachmentsDenied(enforceUserId!, callerAlias ?? "", effectiveNetworkId, rawAttachments)) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "attachment_not_accessible" }) }] };
    }
    return null;
  };

  // #517: name the REAL cause. The old catch-all blamed permissions for
  // what was actually an unresolvable network, sending operators down the
  // wrong debugging path (roles/membership) for hours.
  const writeDeniedReply = (effectiveNetworkId?: string | null, action = "write") => {
    const netId = enforceNetworkId ?? effectiveNetworkId ?? null;
    let error: string;
    let message: string;
    if (!netId) {
      const memberships = enforceUserId ? getUserNetworkIds(enforceUserId) : [];
      error = "network_id_required";
      message = memberships.length === 0
        ? "user token has no network memberships; join or create a network first"
        : `user token spans ${memberships.length} networks; pass network_id explicitly (see /api/auth/me networks[].network_id)`;
    } else if (enforceUserId && !getUserNetworkRole(enforceUserId, netId)) {
      error = "access_denied";
      message = "access denied to requested network (not a member)";
    } else {
      error = "permission_denied";
      message = action === "send_task"
        ? "Viewer role cannot send tasks"
        : "Viewer role cannot write to this network";
    }
    return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error, message }) }] };
  };

  const skillHubReply = (value: Record<string, unknown>) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  });

  // SkillHub is a network registry, not a public filesystem. Content is an
  // immutable SKILL.md snapshot; identity comes only from the authenticated
  // MCP principal (never from request fields).
  server.tool(
    "submit_skill",
    "Submit an immutable SKILL.md version to the caller's network SkillHub. Node identity is token-bound. New submissions require review.",
    {
      slug: z.string().min(2).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
      name: z.string().min(1).max(120),
      description: z.string().max(1000).optional(),
      version: z.string().min(1).max(40).regex(/^[0-9A-Za-z]+(?:[._-][0-9A-Za-z]+)*$/),
      content: z.string().min(1).max(128 * 1024).refine(value => !value.includes("\0"), "content must not contain NUL bytes"),
      network_id: z.string().max(200).optional(),
    },
    async ({ slug, name, description, version, content, network_id: clientNetId }) => {
      const effectiveNetId = getNetworkId(clientNetId);
      if (!canWrite(effectiveNetId)) return writeDeniedReply(effectiveNetId, "write");
      if (!effectiveNetId) return writeDeniedReply(effectiveNetId, "write");
      const sourceType = callerTokenIsNetwork ? "node" : "user";
      if (sourceType === "node" && !callerAlias) return skillHubReply({ ok: false, error: "node_identity_unbound" });
      const contentHash = createHash("sha256").update(content, "utf8").digest("hex");
      const existing = db.get<any>(
        `SELECT skill_id, content_hash, status FROM skillhub_skills
         WHERE network_id = ?1 AND slug = ?2 AND version = ?3`,
        effectiveNetId, slug, version,
      );
      if (existing) {
        if (existing.content_hash === contentHash) {
          return skillHubReply({ ok: true, idempotent: true, skill_id: existing.skill_id, status: existing.status });
        }
        return skillHubReply({ ok: false, error: "skill_version_conflict", hint: "publish changed content under a new version" });
      }
      const skillId = `skill_${uuidv4()}`;
      try {
        db.run(
          `INSERT INTO skillhub_skills
           (skill_id, network_id, slug, name, description, version, content, content_hash, status, source_type, source_alias, created_by_user)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', ?9, ?10, ?11)`,
          [skillId, effectiveNetId, slug, name.trim(), description?.trim() || "", version, content, contentHash, sourceType, callerAlias, enforceUserId || null],
        );
      } catch (error: any) {
        // Two submitters may pass the preflight SELECT together. Resolve the
        // UNIQUE race into the same deterministic idempotent/conflict contract
        // instead of leaking a storage exception as HTTP/MCP 500.
        if (!/unique|duplicate key/i.test(error?.message || "")) throw error;
        const winner = db.get<any>(
          `SELECT skill_id, content_hash, status FROM skillhub_skills
           WHERE network_id = ?1 AND slug = ?2 AND version = ?3`,
          effectiveNetId, slug, version,
        );
        if (!winner) throw error;
        if (winner.content_hash === contentHash) {
          return skillHubReply({ ok: true, idempotent: true, skill_id: winner.skill_id, status: winner.status });
        }
        return skillHubReply({ ok: false, error: "skill_version_conflict", hint: "publish changed content under a new version" });
      }
      db.run(
        `INSERT INTO audit_log (user_id, username, action, target_type, target_id, detail, network_id)
         VALUES (?1, ?2, 'skill_submit', 'skill', ?3, ?4, ?5)`,
        [enforceUserId || null, callerAlias || null, skillId, JSON.stringify({ slug, version, source_type: sourceType }), effectiveNetId],
      );
      return skillHubReply({ ok: true, skill_id: skillId, status: "pending", source_type: sourceType, source_alias: callerAlias });
    },
  );

  server.tool(
    "list_skills",
    "List published skills in a network. Owners/admins may include pending review items.",
    {
      network_id: z.string().max(200).optional(),
      include_pending: z.boolean().optional(),
      query: z.string().max(120).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async ({ network_id: clientNetId, include_pending, query, limit }) => {
      const effectiveNetId = getNetworkId(clientNetId);
      if (!effectiveNetId) return writeDeniedReply(effectiveNetId, "read");
      const role = enforceUserId ? getUserNetworkRole(enforceUserId, effectiveNetId) : null;
      if (enforceUserId && !role) return writeDeniedReply(effectiveNetId, "read");
      // An ntok_ belongs to a node even when it was minted by the network
      // owner. Never inherit the owner's review power through that token.
      const reviewer = !callerTokenIsNetwork && (role === "owner" || role === "admin");
      const showPending = !!include_pending && reviewer;
      const params: unknown[] = [effectiveNetId];
      let sql = `SELECT skill_id, slug, name, description, version, status, source_type, source_alias,
                        created_at, updated_at, reviewed_at, review_note
                   FROM skillhub_skills WHERE network_id = ?1`;
      if (!showPending) sql += ` AND status = 'published'`;
      if (query?.trim()) {
        params.push(`%${query.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`); // #2141: the query is text, not a pattern
        const like = db.dialect === "postgres" ? "ILIKE" : "LIKE"; // RFC-039 F6: SQLite LIKE ignores ASCII case; keep that on PG
        sql += ` AND (slug ${like} ?${params.length} ESCAPE '\\' OR name ${like} ?${params.length} ESCAPE '\\' OR description ${like} ?${params.length} ESCAPE '\\')`;
      }
      sql += ` ORDER BY updated_at DESC LIMIT ${limit ?? 100}`;
      return skillHubReply({ ok: true, reviewer, skills: db.all(sql, ...params) });
    },
  );

  server.tool(
    "get_skill",
    "Read one SkillHub SKILL.md. Pending content is visible only to owners/admins.",
    { skill_id: z.string().regex(/^skill_[A-Za-z0-9_-]+$/).max(200), network_id: z.string().max(200).optional() },
    async ({ skill_id, network_id: clientNetId }) => {
      const effectiveNetId = getNetworkId(clientNetId);
      if (!effectiveNetId) return writeDeniedReply(effectiveNetId, "read");
      const role = enforceUserId ? getUserNetworkRole(enforceUserId, effectiveNetId) : null;
      if (enforceUserId && !role) return writeDeniedReply(effectiveNetId, "read");
      const row = db.get<any>(
        `SELECT skill_id, slug, name, description, version, content, status,
                source_type, source_alias, created_at, updated_at, reviewed_at, review_note
           FROM skillhub_skills WHERE skill_id = ?1 AND network_id = ?2`,
        skill_id, effectiveNetId,
      );
      if (!row) return skillHubReply({ ok: false, error: "skill_not_found" });
      const reviewer = !callerTokenIsNetwork && (role === "owner" || role === "admin");
      if (row.status !== "published" && !reviewer) {
        return skillHubReply({ ok: false, error: "skill_not_found" });
      }
      return skillHubReply({ ok: true, skill: row });
    },
  );

  server.tool(
    "review_skill",
    "Publish or reject a pending SkillHub submission. Network owner/admin only.",
    {
      skill_id: z.string().regex(/^skill_[A-Za-z0-9_-]+$/).max(200),
      decision: z.enum(["published", "rejected"]),
      note: z.string().max(1000).optional(),
      network_id: z.string().max(200).optional(),
    },
    async ({ skill_id, decision, note, network_id: clientNetId }) => {
      const effectiveNetId = getNetworkId(clientNetId);
      if (!effectiveNetId) return writeDeniedReply(effectiveNetId, "write");
      const role = enforceUserId ? getUserNetworkRole(enforceUserId, effectiveNetId) : null;
      if (callerTokenIsNetwork || (role !== "owner" && role !== "admin")) return skillHubReply({ ok: false, error: "skill_review_admin_required" });
      const row = db.get<any>(`SELECT status FROM skillhub_skills WHERE skill_id = ?1 AND network_id = ?2`, skill_id, effectiveNetId);
      if (!row) return skillHubReply({ ok: false, error: "skill_not_found" });
      if (row.status !== "pending") return skillHubReply({ ok: false, error: "skill_not_pending", status: row.status });
      const updated = db.run(
        `UPDATE skillhub_skills SET status = ?1, review_note = ?2, reviewed_by_user = ?3,
         reviewed_at = datetime('now'), updated_at = datetime('now') WHERE skill_id = ?4 AND network_id = ?5 AND status = 'pending'`,
        [decision, note?.trim() || null, enforceUserId || null, skill_id, effectiveNetId],
      );
      if (updated.changes !== 1) return skillHubReply({ ok: false, error: "skill_not_pending" });
      db.run(
        `INSERT INTO audit_log (user_id, username, action, target_type, target_id, detail, network_id)
         VALUES (?1, ?2, 'skill_review', 'skill', ?3, ?4, ?5)`,
        [enforceUserId || null, callerAlias || null, skill_id, JSON.stringify({ decision }), effectiveNetId],
      );
      return skillHubReply({ ok: true, skill_id, status: decision });
    },
  );

  const addScope = (sql: string, params: any[], networkId?: string | null, column = "network_id"): string => {
    if (!networkId) return sql;
    sql += ` AND ${column} = ?${params.length + 1}`;
    params.push(networkId);
    return sql;
  };

  /** #1548 —— 把一个还标着 blocked 的会话拉回 idle。只在「它刚发出终态回复 / 刚派了任务」这两个活性证据处调用。 */
  const releaseBlockedSession = (alias: string | null | undefined, networkId: string | null | undefined): void => {
    if (!alias) return;
    const params: any[] = [alias];
    let sql = "UPDATE sessions SET status = 'idle', updated_at = datetime('now') WHERE alias = ?1 AND status = 'blocked'";
    sql = addScope(sql, params, networkId ?? null);
    try {
      db.run(sql, params);
    } catch {
      // 展示层的一次修正失败不能影响主路径。
    }
  };

  type ReadScope = RestNetworkScope;

  // Delegates to the shared membership query (network-scope.ts) — was a
  // byte-for-byte duplicate of getUserNetworkIds before #517.
  const getReadableNetworkIds = (): string[] =>
    enforceUserId ? getUserNetworkIds(enforceUserId) : [];

  // 受限网络挂在 scope.agentRestriction 上:addReadScope(= addNetworkScope)对它们 fail-closed,
  // 逐条审过的工具改用 addAgentNetworkScope / addOwnTrafficScope 按授权放行。
  const withRestriction = (scope: ReadScope): ReadScope => {
    if (!restrictedNets.length || !enforceUserId) return scope;
    const inScope = scope.networkId ? [scope.networkId] : (scope.networkIds ?? []);
    const restricted = restrictedNets.filter((id) => inScope.includes(id));
    return restricted.length ? { ...scope, agentRestriction: { userId: enforceUserId, username: callerAlias ?? "", networkIds: restricted } } : scope;
  };
  const resolveReadScope = (clientNetId?: string | null): ReadScope => {
    if (!enforceUserId) return { networkId: clientNetId ?? null, networkIds: null };
    if (enforceNetworkId) {
      const role = getUserNetworkRole(enforceUserId, enforceNetworkId);
      return role ? { networkId: enforceNetworkId, networkIds: null } : { networkId: null, networkIds: [], denied: "not a member of token network" };
    }
    if (clientNetId) {
      const role = getUserNetworkRole(enforceUserId, clientNetId);
      return role ? withRestriction({ networkId: clientNetId, networkIds: null }) : { networkId: null, networkIds: [], denied: "access denied to requested network" };
    }
    return withRestriction({ networkId: null, networkIds: getReadableNetworkIds() });
  };

  // RFC-027 §2.3 race-free invariant — assertNodeActive lives in
  // server/src/lifecycle-guard.ts so REST handlers in server/src/index.ts
  // can use the SAME code path. PR1.1 had it inline here; PR1.2a
  // (#346 review catch) extracted because the closure scope made it
  // unreachable from REST and left the §2.3 race open on dashboard
  // Dispatch (POST /api/task + /api/broadcast). Per
  // per team rule: grep every write site (MCP tools.ts AND REST index.ts) before adding a guard, and extract the helper into a shared module so both transports import it.

  // 默认读作用域:对受限网络 fail-closed(见 network-scope.ts addNetworkScope)。
  const addReadScope = (sql: string, params: any[], scope: ReadScope, column = "network_id"): string =>
    addNetworkScope(sql, params, scope, column);

  type DeliveryTarget =
    | { state: "online"; alias: string; session: any }
    | { state: "offline"; alias: string; session: any; message: string }
    | { state: "not_found"; alias: string; message: string };

  // Only call after the authenticated, network-scoped lookup resolved a
  // concrete target. Error paths intentionally omit this identity object.
  const actualTo = (target: Exclude<DeliveryTarget, { state: "not_found" }>, networkId?: string | null) => ({
    alias: target.alias,
    to_node_id: target.session?.node_id ?? null,
    network_id: networkId ?? null,
  });

  const scopedSessionStatus = (alias: string, networkId?: string | null) => {
    const params: any[] = [alias];
    let sql = "SELECT status, updated_at, last_seen_at, node_id FROM sessions WHERE alias = ?1";
    sql = addScope(sql, params, networkId);
    return db.get<any>(sql, ...params);
  };

  const resolveNodeIdForAlias = (alias: string, networkId?: string | null): string | null => {
    if (!alias || alias === "hub" || alias === "api") return null;
    const canonical = resolveCanonicalAlias(networkId, alias);
    const session = scopedSessionStatus(canonical.alias, networkId);
    return session?.node_id ?? null;
  };

  const resolveDeliveryTarget = (alias: string, networkId?: string | null): DeliveryTarget => {
    const session = scopedSessionStatus(alias, networkId);
    if (!session) {
      return {
        state: "not_found",
        alias,
        message: `alias not found: ${alias}`,
      };
    }
    const lastSeen = session.last_seen_at || session.updated_at;
    const lastSeenAt = lastSeen ? new Date(String(lastSeen).replace(" ", "T") + "Z").getTime() : 0;
    const stale = !lastSeenAt || Date.now() - lastSeenAt > 5 * 60 * 1000;
    if (String(session.status || "").toLowerCase() === "offline" || stale) {
      return {
        state: "offline",
        alias,
        session,
        message: `alias is offline; message queued in inbox: ${alias}`,
      };
    }
    return { state: "online", alias, session };
  };

  const deliveryTargetReply = (target: DeliveryTarget, ids: Record<string, string> = {}) => {
    if (target.state === "not_found") {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            ok: false,
            error: "alias_not_found",
            message: target.message,
            alias: target.alias,
            queued: false,
            ...ids,
          }),
        }],
      };
    }
    if (target.state === "offline") {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            ok: false,
            error: "alias_offline",
            message: target.message,
            alias: target.alias,
            queued: true,
            session_status: target.session.status ?? "offline",
            ...ids,
          }),
        }],
      };
    }
    return null;
  };
  // ═══════════════════════════════════════════
  //  Child Agent Tools (4)
  // ═══════════════════════════════════════════

  server.tool(
    "report_status",
    "Report agent status. Returns inbox_count so you know if there are pending tasks.",
    {
      resume_id: z.string().min(1).max(200).describe("Claude Code session UUID (unique per session)"),
      alias: z.string().min(1).max(200).describe("Human-readable session name for dispatching (e.g. 指挥室/知识哥)"),
      status: z.enum(["working", "idle", "blocked", "error", "waiting_input", "offline"]),
      task: z.string().max(10000).optional().describe("Current task description"),
      output: z.string().max(50000).optional().describe("Recent output (max 4000 chars stored)"),
      score: z.number().min(0).max(10).optional().describe("Self-score 1-10"),
      progress: z.number().min(0).max(100).optional().describe("Progress 0-100"),
      server: z.string().max(200).optional().describe("Server identifier"),
      hostname: z.string().max(200).optional().describe("Agent hostname"),
      agent: z.string().max(100).optional().describe("Agent type (claude-code / codex / opencode)"),
      project_dir: z.string().max(1000).optional().describe("Agent working directory"),
      version: z.string().max(100).optional().describe("Agent version"),
      tmux_name: z.string().max(200).optional().describe("tmux session name"),
      // V2 fields
      node_id: z.string().max(200).optional().describe("Stable node identifier"),
      session_id: z.string().max(200).optional().describe("Runtime session/thread ID"),
      config_path: z.string().max(1000).optional().describe("Config file path"),
      channels: z.string().max(2000).optional().describe("JSON array of channels"),
      model: z.string().max(200).optional().describe("AI model name"),
      node_name: z.string().max(200).optional().describe("Stable node display name (may differ from alias)"),
      network_id: z.string().max(200).optional().describe("Network this agent belongs to"),
      // ╭─ 🔴 往 report_status 里加字段之前先读这一段(#1545 实测,zod 4.3.6)─────────╮
      // │ **这份 schema 的子对象一半严一半松,而后果完全不同。**
      // │
      // │   非 strict:host / process_telemetry / config_snapshot / daemon_capabilities
      // │   `.strict()`:external_schedules(含其 schedules[] 元素)
      // │              side_thread_capability(含其 exactBoundary)
      // │
      // │ 往**非 strict** 的对象里加一个 hub 还不认识的键 ⇒ zod **静默丢弃**。
      // │   节点不会掉线,但字段人间蒸发 —— 现场表现为「daemon 明明发了、hub 上没有」,
      // │   排查起来和 daemon 侧 bug 一模一样。
      // │ 往**strict** 的对象里加同一个键 ⇒ `unrecognized_keys`,**整份 report_status 被拒**。
      // │   而 agent-node 的 register() 是 `await` 且无人 catch ⇒ **节点进程当场死掉**
      // │   (#1225 就是这么全网躺倒的,见下面 host.ip 那段)。
      // │
      // │ 所以「新字段能不能 daemon 先发」**没有统一答案,取决于你往哪个子对象里加**:
      // │   非 strict → 可以先发(会丢,不会死);strict → hub 必须先合,否则升级即失联。
      // │
      // │ 🔴 别把这条读成「strict 更危险、都改成非 strict」。两者各有其位:
      // │   external_schedules / side_thread_capability 是**有界快照**,strict 挡的是
      // │   「节点往里塞任意键」;daemon_capabilities 是**能力自述**,天然要向前兼容
      // │   (旧 hub 见到新能力应当忽略而不是拒绝整份上报)。**加字段前先看清你在哪一边。**
      // ╰──────────────────────────────────────────────────────────────────────────────╯
      host: z.object({
        // 🔴 `.nullable()` 不是防御性冗余,是**发送方声明的类型**:agent-node 的
        //    HostTelemetry 是 `ip: string | null`,`firstNonInternalIPv4()` 在没有
        //    非回环 IPv4 的机器上返回 null(--network none 的容器、断网的笔记本、
        //    部分 CI runner)。此前这里只有 `.optional()`,于是那台机器上的
        //    agent-node 一启动就收到 MCP -32602,而 register() 是 await 且无人 catch
        //    —— **整个节点进程当场死掉**,和 runtime 无关。
        //    同一个对象里四个数值字段本来就写着 `.nullable().optional()`,
        //    两个字符串字段是唯一的例外;正确写法一直在隔壁那一行。
        hostname: z.string().max(200).nullable().optional(),
        ip: z.string().max(200).nullable().optional(),
        cpu_load_1min: z.number().nullable().optional(),
        cpu_cores: z.number().nullable().optional(),
        mem_total_gb: z.number().nullable().optional(),
        mem_used_gb: z.number().nullable().optional(),
        mem_avail_gb: z.number().nullable().optional(),
        disk_total_gb: z.number().nullable().optional(),
        disk_used_gb: z.number().nullable().optional(),
        disk_avail_gb: z.number().nullable().optional(),
      }).optional().describe("Host telemetry reported by agent-node"),
      process_telemetry: z.object({
        rss_bytes: z.number().nullable().optional(),
        rss_mb: z.number().nullable().optional(),
        rss: z.number().nullable().optional(),
        cpu_pct: z.number().nullable().optional(),
        uptime_seconds: z.number().nullable().optional(),
        in_flight_count: z.number().nullable().optional(),
      }).optional().describe("Per-agent process telemetry reported by agent-node"),
      external_schedules: z.object({
        observed_at: z.string().datetime({ offset: true }).max(64),
        schedules: z.array(z.object({
          id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
          name: z.string().min(1).max(200),
          kind: z.enum(["cron", "systemd", "tmux", "playwright", "custom"]),
          frequency: z.string().min(1).max(120),
          last_run_at: z.string().datetime({ offset: true }).max(64).nullable(),
          last_status: z.enum(["success", "failed", "running", "unknown"]),
          last_error: z.string().max(500).nullable(),
          next_run_at: z.string().datetime({ offset: true }).max(64).nullable(),
          log_ref: z.string().min(1).max(255).nullable(),
          enabled: z.boolean(),
          // RFC-036 — only agent-node managed cron markers advertise write
          // capability. Legacy/other kinds omit these fields and stay read-only.
          editable: z.boolean().optional(),
          revision: z.number().int().min(0).optional(),
        }).strict()).max(64),
        error: z.enum(["invalid_manifest", "unsafe_manifest", "read_failed"]).optional(),
      }).strict().optional().describe("Bounded node-reported external schedule snapshot; never includes host paths or commands"),
      // RFC-024 B6 — masked snapshot of the node's effective config
      // (model + 6 dashboard-editable flags). Secrets ARE NOT in this
      // shape (env._envRef stays on host); the dashboard reads this
      // verbatim for the snapshot path without touching node files.
      // config_update_capable signals whether the node runs under a
      // supervisor wrapper that honours the sentinel-75 restart path
      // (W1) — bare-spawned agent-nodes set this to false so dashboard
      // can grey out remote-restart for them.
      config_snapshot: z.object({
        model: z.string().max(200).optional().nullable(),
        flags: z.record(z.string(), z.unknown()).optional(),
        config_revision: z.number().int().min(0).optional(),
        config_update_capable: z.boolean().optional(),
        peer_reply_inbox_capable: z.literal(true).optional(),
        side_thread_capability: z.object({
          supported: z.boolean(),
          runtime: z.string().max(64),
          runtimeVersion: z.string().max(64),
          topology: z.string().max(64),
          evidenceRevision: z.string().max(100),
          mode: z.literal("native-exact-fork").optional(),
          exactBoundary: z.object({ through: z.boolean(), before: z.boolean() }).strict().optional(),
          reason: z.enum(["runtime", "version", "topology", "experimental-api", "exact-boundary"]).optional(),
        }).strict().optional(),
        // RFC-026 P2 / #338 — daemon role surfaced for hub /api/nodes
        // discovery (#337 extracts this field). "host_supervisor" =
        // anet daemon. Default-stripping zod would drop this otherwise.
        role: z.string().max(64).optional().nullable(),
        // RFC-026 §9.3 / #338 PR3 — daemon self-declare nested under
        // `daemon_capabilities` (canonical shape per existing hub reads
        // at tools.ts:2010/2075 — PR1/PR2 placed these top-level, hub
        // never saw them, max_concurrent_children stayed default + the
        // allowlists stayed unenforced. PR3 nit ① per 通信龙).
        // Soft caps avoid abuse via attacker daemon.
        // 🔴 这个对象**故意不是 `.strict()`** —— 能力自述必须向前兼容:
        //    旧 hub 见到新 daemon 报的新能力,应当忽略那一格,而不是拒掉整份 report
        //    把节点踢下线。代价是新键在 hub 升级前会被**静默丢弃**(所以新字段仍然
        //    应当 hub 先合)。同一份 schema 里 side_thread_capability / external_schedules
        //    是 `.strict()` 的,后果不同 —— 见 `host:` 上方那段方框注释。
        daemon_capabilities: z.object({
          runtimes_supported: z.array(z.string().max(64)).max(16).optional(),
          allowed_secret_keys: z.array(z.string().max(64)).max(64).optional(),
          max_concurrent_children: z.number().int().min(1).max(1000).optional(),
          // #1353 —— daemon **当下**能不能创建节点。与 runtimes_supported 不是一回事:
          // 后者是声明(我支持哪些 runtime),这个是实际能力。一个 daemon 可以声明支持
          // 三种 runtime,同时因为 ANET_BIN pin 解析不出来而一种也创建不了。
          //
          // 🔴 为什么 hub 需要看见它:pin 只存在于 /etc/anet-daemon/path.conf 或
          //    显式开启的环境变量里,**重启不带环境就会丢**。丢了之后 daemon 照常注册、
          //    在线、收 doorbell,hub 返回 ok:true + request_id —— 而节点永远不出现。
          //    在此之前 hub 完全看不出区别,Dashboard 的「选服务器」还会把它列为可选。
          can_create_nodes: z.boolean().optional(),
          // 只收**代码**,不收原始报错文本 —— 上游 unsafePathHelp() 的消息里带完整机器路径,
          // 而这个字段会走到 Dashboard。enum 而不是 string:一个自由文本字段等于给
          // 「把路径塞进来」留了口子。
          // #1353 —— 四类失败,修法完全不同:
          //   identity   重装 anet / unset ANET_BIN_ABS
          //   source     写 /etc/anet-daemon/path.conf（**要 sudo**）
          //   shape      换成 realpath
          //   permission **一行 chmod go-w**
          // 混成一条会让人修错方向 —— 2026-08-28 我一天里撞到其中两类,看到的是同一条错误。
          //
          // 🔴 `anet_bin_pin_unresolved` **必须留着**:已经在跑的 agent-node@2.5.0-preview.40
          //    发的就是这个值。zod 对象里任何一个字段验证失败会让**整个 report_status 被拒**,
          //    不只是丢掉这一格 —— 那会让所有 .40 daemon 在 hub 上变成失联。
          //    删一个 enum 值的代价,远大于多留一个。
          // 🔴 仍然是 enum 不是 string:自由文本字段就是给机器路径留的口子,
          //    而上游 e.message 里带的正是完整路径。
          create_nodes_blocked_reason: z.enum([
            "anet_bin_pin_unresolved",   // 兼容:.40 及更早
            "anet_bin_identity",
            "anet_bin_source",
            "anet_bin_shape",
            "anet_bin_permission",
            "anet_bin_unknown",
          ]).optional(),
          // #1545 —— 上面那一格**是什么时候测出来的**。
          //
          // 🔴 版本号一律带包名 + 完整版本:仓里三个包各自独立编号,裸的 `preview.NN`
          //    同时是三个不同的时间点。此处曾写成「preview.67」——
          //    那是 agent-network 的号,agent-node 根本没有 .67(npm 404,最高 .56)。
          // 🔴 为什么必须有:**agent-node ≤ 2.5.0-preview.54** 的 `daemonCreateCapability()`
          //    用一个进程级缓存(`_createCapCache`)只算一次。开机时 pin 坏 ⇒ 之后
          //    永远上报 blocked(哪怕运维已经写好 path.conf);开机时好 ⇒ 之后把二进制
          //    chmod 掉也**永远上报 ready**。后者是朝「没问题」方向说谎。
          //    而 hub 这边,一个 3 秒前测的 blocked 和一个三周前测的 blocked,
          //    在 `last_seen_at` 上长得一模一样 —— 心跳是新的,那一格不是。
          //
          // 🔴 为什么是「多久以前」(时长)而不是绝对时间戳:这个值来自**节点自己的钟**。
          //    时钟偏移下,绝对时间戳会算出一个既可能"永远新鲜"也可能"来自 1970"的年龄,
          //    而且错的方向不可预测。时长对偏移免疫 —— hub 用自己的钟在收到时换算。
          //
          // 🔴 为什么不加 `.min()/.max()/.int()`:**这几个约束都会让整条 report_status 被拒**
          //    (zod 对象里任何一个已知字段验证失败 = 整份被拒,不是丢掉这一格),
          //    而这一格是纯诊断信息,不值得拿一台节点的在线状态去换。
          //    收得宽,**在读取处消毒**(见 /api/host-supervisors)。
          //    这条不是我新立的:同一个 schema 上方 `anet_bin_pin_unresolved` 那条注释
          //    记的就是同一次教训 —— 删一个 enum 值会让所有 .40 daemon 失联。
          //
          // 🔴 `.catch(null)` 不是装饰:光写 `z.number()` **仍然会拒 NaN**
          //    (实测:`z.number().nullable().optional()` 对 NaN 抛),而那意味着
          //    一次算错的时长能让整台节点在 hub 上失联 —— 正是 #1225 里 host.ip
          //    那个形状。`.catch(null)` 让这一格**在任何输入下都不可能拒掉整份 report**:
          //    合法数字透传,其余一律变 null(读取侧当作「没报」)。
          //    类型仍然是 number 而不是 unknown —— 别给一个 attacker daemon
          //    留下"往快照里塞任意大对象"的口子(同 schema 上方 soft cap 的立场)。
          //
          // 不上报这一格 ≠ 0。旧 daemon 压根不发,读的人必须能把
          // 「刚测的」「很久以前测的」「不知道」分成三件事说。
          create_capability_observed_ms_ago: z.number().nullable().catch(null).optional(),
          // app「新建节点」工作目录:daemon 的默认根。出现即表示该 daemon 认 node_spec.workdir。
          // `.catch(undefined)`:同上一格的立场 —— 一个诊断/展示字段不许拒掉整份 report。
          // 读取侧再按形状消毒(create-node-validate.ts daemonDefaultWorkdirRoot)。
          default_workdir_root: z.string().max(1024).optional().catch(undefined),
        }).optional(),
      }).optional().describe("RFC-024 — masked node config snapshot"),
      // app#225 follow-up — the reporting process answers the `rules_file`
      // doorbell (agent-node, and the claude-code channel server node-server).
      // Top-level instead of config_snapshot: claude-code sessions usually have
      // no `nodes` row, and config_snapshot is persisted per node_id. Only a
      // node token bound to this same alias can set it; see the UPDATE below.
      rules_file_capable: z.literal(true).optional(),
      // Node skills view — same doorbell, ops skills_list / skill_read.
      skills_capable: z.literal(true).optional(),
      // Project folder view — same doorbell, ops files_list / file_read.
      files_capable: z.literal(true).optional(),
      // Node run-log view — same doorbell, op logs_tail.
      logs_capable: z.literal(true).optional(),
      // #448 — layered node health (bridge / app_server / tui / model_auth).
      // Report-only, memory-only; any malformed shape degrades to "not reported"
      // instead of rejecting the whole report (see node-health-store.ts).
      health: nodeHealthSchema,
    },
    async ({ resume_id, alias, status, task, output, score, progress, server: srv, hostname: hn, agent: ag, project_dir: pd, version: ver, tmux_name: tmux, node_id, session_id, config_path, channels, model: mdl, node_name: nn, network_id: netId, host, process_telemetry: proc, external_schedules: externalSchedules, config_snapshot: cfgSnap, rules_file_capable: rulesFileCapable, skills_capable: skillsCapable, files_capable: filesCapable, logs_capable: logsCapable, health: nodeHealth }) => {
      const effectiveNetId = getNetworkId(netId);
      const sessionNetId = effectiveNetId ?? "default";
      if (!callerTokenIsNetwork || !enforceNetworkId) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "network_token_required" }) }] };
      }
      if (!canWrite(effectiveNetId)) {
        return writeDeniedReply(effectiveNetId);
      }
      const canonical = resolveCanonicalAlias(sessionNetId, alias);
      let effectiveAlias = canonical.alias;
      if (canonical.renamed) {
        // A stale process may keep heartbeating with the old alias after a
        // committed rename. If the new alias is already active, ignore the
        // stale report and clean the old row instead of letting it recreate
        // a red/orphan dashboard node (#146/#172). If not active yet, rewrite
        // the incoming report to the canonical alias so startup can converge.
        if (canonicalAliasExists(sessionNetId, effectiveAlias, resume_id)) {
          cleanupRenamedAliasSession(sessionNetId, alias, effectiveAlias);
          const pendingParams: any[] = [effectiveAlias];
          let pendingSql = "SELECT COUNT(*) as cnt FROM inbox WHERE session_name = ?1 AND acked = 0";
          pendingSql = addScope(pendingSql, pendingParams, effectiveNetId);
          const pending = db.get<{ cnt: number }>(pendingSql, ...pendingParams);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                resume_id,
                alias: effectiveAlias,
                renamed_from: alias,
                ignored_stale_alias: true,
                inbox_count: pending?.cnt ?? 0,
              }),
            }],
          };
        }
      }
      // #203 identity guard — network tokens must not silently rebind their
      // own name via report_status. Without this, a runtime whose ALIAS
      // drifted (env leak / wrong --alias / CurrentAliasResolver seeded from
      // the wrong node_id) could rewrite api_tokens.name and cause every
      // subsequent send_task from this token to be attributed to the drifted
      // alias — the observed #203 symptom (grokB's send arriving as
      // from=grokA). Only the legit rename path (rename.ts) may cross the
      // token→alias binding. Symmetric to fromIdentityMismatchReply on the
      // send side (test198).
      if (callerTokenIsNetwork && callerAlias && !canonical.renamed && effectiveAlias !== callerAlias) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              ok: false,
              error: "alias_identity_mismatch",
              message: "report_status alias does not match the token-bound node alias; use anet node rename to change identity",
              token_alias: callerAlias,
              reported_alias: effectiveAlias,
            }),
          }],
        };
      }
      console.log(`[${ts()}] ${effectiveAlias} (${resume_id.slice(0, 8)}) → report_status: ${status}${task ? " | " + task.slice(0, 60) : ""}${effectiveNetId ? " [net]" : ""}${canonical.renamed ? ` [renamed from ${alias}]` : ""}`);
      if (callerTokenIsNetwork && callerTokenId) {
        try {
          db.run("UPDATE api_tokens SET name = ?1 WHERE token_id = ?2", [`node:${effectiveAlias}`, callerTokenId]);
        } catch {}
      }
      const trimmedOutput = output?.slice(0, 4000);
      const hostHostname = host?.hostname || hn || null;
      const hostIp = host?.ip || clientIP || null;
      const cpuLoad1m = typeof host?.cpu_load_1min === "number" ? host.cpu_load_1min : null;
      const cpuCores = typeof host?.cpu_cores === "number" ? host.cpu_cores : null;
      const memTotalGb = typeof host?.mem_total_gb === "number" ? host.mem_total_gb : null;
      const memUsedGb = typeof host?.mem_used_gb === "number" ? host.mem_used_gb : null;
      const memAvailGb = typeof host?.mem_avail_gb === "number" ? host.mem_avail_gb : null;
      const diskTotalGb = typeof host?.disk_total_gb === "number" ? host.disk_total_gb : null;
      const diskUsedGb = typeof host?.disk_used_gb === "number" ? host.disk_used_gb : null;
      const diskAvailGb = typeof host?.disk_avail_gb === "number" ? host.disk_avail_gb : null;
      const processRssBytes = typeof proc?.rss_bytes === "number" ? proc.rss_bytes : (typeof proc?.rss === "number" ? proc.rss : null);
      const processRssMb = typeof proc?.rss_mb === "number"
        ? proc.rss_mb
        : (typeof processRssBytes === "number" ? Math.round((processRssBytes / 1024 / 1024) * 10) / 10 : null);
      const processCpuPct = typeof proc?.cpu_pct === "number" ? proc.cpu_pct : null;
      const processUptimeSeconds = typeof proc?.uptime_seconds === "number" ? proc.uptime_seconds : null;
      const processInFlightCount = typeof proc?.in_flight_count === "number" ? proc.in_flight_count : null;
      const externalSchedulesJson = externalSchedules === undefined ? null : JSON.stringify(externalSchedules);
      const trustedCurrentSnapshot = node_id
        ? trustedConfigSnapshotForNode(cfgSnap ?? null, callerTokenId ?? null, node_id)
        : null;
      const peerReplyInboxCapable = !!(
        trustedCurrentSnapshot
        && typeof trustedCurrentSnapshot === "object"
        && (trustedCurrentSnapshot as Record<string, unknown>).peer_reply_inbox_capable === true
      );
      const statusHostTelemetry = host ? {
        hostname: hostHostname,
        ip: hostIp,
        cpu_load_1min: cpuLoad1m,
        cpu_cores: cpuCores,
        mem_total_gb: memTotalGb,
        mem_used_gb: memUsedGb,
        mem_avail_gb: memAvailGb,
        disk_total_gb: diskTotalGb,
        disk_used_gb: diskUsedGb,
        disk_avail_gb: diskAvailGb,
      } : null;
      const statusProcessTelemetry = proc ? {
        rss_bytes: processRssBytes,
        rss_mb: processRssMb,
        cpu_pct: processCpuPct,
        uptime_seconds: processUptimeSeconds,
        in_flight_count: processInFlightCount,
      } : null;

      db.transaction(() => {
        // Only delete same-alias sessions within the same network
        // 同一 alias 可以有两个上报者轮流说话(agent-node 自己 `sdk-<node>` +
        // grok 共存里 TUI 的 MCP `grok-cli-<node>`)。下面这条 DELETE 会把「另一个
        // resume_id」的那行整行删掉,再 INSERT 一行新的 —— ON CONFLICT 里那一串
        // COALESCE 在这条路径上一次都不会触发,于是上报里没带的列(version / agent /
        // hostname / 六个遥测字段 / registered_at …)全部变 NULL。2026-09-04 DEV 真机:
        // grok-v1 working 时 version=.64,7 秒后 idle 就成了 NULL,registered_at 被改成
        // 那一秒。先把要被删的那行读出来,INSERT 之后把仍为 NULL 的列从它接手 —— 让「换 resume_id」
        // 和「同 resume_id 更新」对描述性列的语义一致:上报了就覆盖,没上报就保留。
        // 状态类列(status / task / output / progress / score)不接手,那是本次上报的事实。
        const handover = db.get<Record<string, unknown>>(
          `SELECT tmux_name, server, ip, hostname, agent, project_dir, version, node_id, session_id, config_path,
                  channels, model, cpu_load_1min, cpu_cores, mem_total_gb, mem_used_gb, mem_avail_gb, disk_total_gb,
                  disk_used_gb, disk_avail_gb, process_rss_bytes, process_rss_mb, process_cpu_pct,
                  process_uptime_seconds, process_in_flight_count, external_schedules, registered_at
             FROM sessions WHERE alias = ?1 AND resume_id != ?2 AND network_id = ?3
             ORDER BY updated_at DESC LIMIT 1`,
          effectiveAlias, resume_id, sessionNetId,
        ) ?? null;
        const keep = <T,>(fresh: T | null | undefined, column: string): T | null =>
          (fresh ?? (handover?.[column] as T | null | undefined) ?? null);
        db.run("DELETE FROM sessions WHERE alias = ?1 AND resume_id != ?2 AND network_id = ?3", [effectiveAlias, resume_id, sessionNetId]);
        db.run(
          `INSERT INTO sessions (resume_id, alias, tmux_name, server, ip, hostname, agent, project_dir, version, status, task, output, progress, score, node_id, session_id, config_path, channels, network_id, model, cpu_load_1min, cpu_cores, mem_total_gb, mem_used_gb, mem_avail_gb, disk_total_gb, disk_used_gb, disk_avail_gb, process_rss_bytes, process_rss_mb, process_cpu_pct, process_uptime_seconds, process_in_flight_count, external_schedules, peer_reply_inbox_capable, last_seen_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32, ?33, ?34, ?35, datetime('now'), datetime('now'))
           ON CONFLICT(resume_id) DO UPDATE SET
             alias = COALESCE(?2, sessions.alias), tmux_name = COALESCE(?3, sessions.tmux_name),
             server = COALESCE(?4, sessions.server), ip = COALESCE(?5, sessions.ip),
             hostname = COALESCE(?6, sessions.hostname), agent = COALESCE(?7, sessions.agent),
             project_dir = COALESCE(?8, sessions.project_dir), version = COALESCE(?9, sessions.version),
             status = ?10, task = COALESCE(?11, sessions.task),
             output = COALESCE(?12, sessions.output), progress = COALESCE(?13, sessions.progress),
             score = COALESCE(?14, sessions.score), node_id = COALESCE(?15, sessions.node_id),
             session_id = COALESCE(?16, sessions.session_id), config_path = COALESCE(?17, sessions.config_path),
             channels = COALESCE(?18, sessions.channels), network_id = COALESCE(?19, sessions.network_id),
             model = COALESCE(?20, sessions.model),
             cpu_load_1min = COALESCE(?21, sessions.cpu_load_1min),
             cpu_cores = COALESCE(?22, sessions.cpu_cores),
             mem_total_gb = COALESCE(?23, sessions.mem_total_gb),
             mem_used_gb = COALESCE(?24, sessions.mem_used_gb),
             mem_avail_gb = COALESCE(?25, sessions.mem_avail_gb),
             disk_total_gb = COALESCE(?26, sessions.disk_total_gb),
             disk_used_gb = COALESCE(?27, sessions.disk_used_gb),
             disk_avail_gb = COALESCE(?28, sessions.disk_avail_gb),
             process_rss_bytes = COALESCE(?29, sessions.process_rss_bytes),
             process_rss_mb = COALESCE(?30, sessions.process_rss_mb),
             process_cpu_pct = COALESCE(?31, sessions.process_cpu_pct),
             process_uptime_seconds = COALESCE(?32, sessions.process_uptime_seconds),
             process_in_flight_count = COALESCE(?33, sessions.process_in_flight_count),
             external_schedules = COALESCE(?34, sessions.external_schedules),
             peer_reply_inbox_capable = ?35,
             last_seen_at = datetime('now'), updated_at = datetime('now')`,
          [resume_id, effectiveAlias, tmux ?? null, srv ?? null, hostIp, hostHostname, ag ?? null, pd ?? null, ver ?? null, status, task ?? null, trimmedOutput ?? null, progress ?? null, score ?? null, node_id ?? null, session_id ?? null, config_path ?? null, channels ?? null, sessionNetId, mdl ?? null, cpuLoad1m, cpuCores, memTotalGb, memUsedGb, memAvailGb, diskTotalGb, diskUsedGb, diskAvailGb, processRssBytes, processRssMb, processCpuPct, processUptimeSeconds, processInFlightCount, externalSchedulesJson, peerReplyInboxCapable ? 1 : 0]
        );
        if (handover) {
          // 换 resume_id 那条路径上 ON CONFLICT 不会触发;INSERT 完再把没上报(仍为 NULL)的
          // 描述性列从被替换的那行接手。INSERT 语句与参数列表保持原样 —— test698 的变异
          // 用 sed 钉着它的字节形状。
          db.run(
            `UPDATE sessions SET
               tmux_name = COALESCE(tmux_name, ?2), server = COALESCE(server, ?3), ip = COALESCE(ip, ?4),
               hostname = COALESCE(hostname, ?5), agent = COALESCE(agent, ?6), project_dir = COALESCE(project_dir, ?7),
               version = COALESCE(version, ?8), node_id = COALESCE(node_id, ?9), session_id = COALESCE(session_id, ?10),
               config_path = COALESCE(config_path, ?11), channels = COALESCE(channels, ?12), model = COALESCE(model, ?13),
               cpu_load_1min = COALESCE(cpu_load_1min, ?14), cpu_cores = COALESCE(cpu_cores, ?15),
               mem_total_gb = COALESCE(mem_total_gb, ?16), mem_used_gb = COALESCE(mem_used_gb, ?17),
               mem_avail_gb = COALESCE(mem_avail_gb, ?18), disk_total_gb = COALESCE(disk_total_gb, ?19),
               disk_used_gb = COALESCE(disk_used_gb, ?20), disk_avail_gb = COALESCE(disk_avail_gb, ?21),
               process_rss_bytes = COALESCE(process_rss_bytes, ?22), process_rss_mb = COALESCE(process_rss_mb, ?23),
               process_cpu_pct = COALESCE(process_cpu_pct, ?24), process_uptime_seconds = COALESCE(process_uptime_seconds, ?25),
               process_in_flight_count = COALESCE(process_in_flight_count, ?26),
               external_schedules = COALESCE(external_schedules, ?27),
               registered_at = COALESCE(?28, registered_at)
             WHERE resume_id = ?1`,
            [resume_id, handover.tmux_name ?? null, handover.server ?? null, handover.ip ?? null, handover.hostname ?? null,
             handover.agent ?? null, handover.project_dir ?? null, handover.version ?? null, handover.node_id ?? null,
             handover.session_id ?? null, handover.config_path ?? null, handover.channels ?? null, handover.model ?? null,
             handover.cpu_load_1min ?? null, handover.cpu_cores ?? null, handover.mem_total_gb ?? null, handover.mem_used_gb ?? null,
             handover.mem_avail_gb ?? null, handover.disk_total_gb ?? null, handover.disk_used_gb ?? null, handover.disk_avail_gb ?? null,
             handover.process_rss_bytes ?? null, handover.process_rss_mb ?? null, handover.process_cpu_pct ?? null,
             handover.process_uptime_seconds ?? null, handover.process_in_flight_count ?? null, handover.external_schedules ?? null,
             handover.registered_at ?? null],
          );
        }
        // app#225 follow-up — separate statement on purpose: the INSERT above is
        // byte-pinned by test698's mutation harness. Sticky: only ever set to 1,
        // and only by a node token bound to this alias (a user token or another
        // node cannot mark someone else's session as able to serve its files).
        if (rulesFileCapable === true && callerTokenIsNetwork && callerAlias && callerAlias === effectiveAlias) {
          db.run("UPDATE sessions SET rules_file_capable = 1 WHERE resume_id = ?1", [resume_id]);
        }
        if (skillsCapable === true && callerTokenIsNetwork && callerAlias && callerAlias === effectiveAlias) {
          db.run("UPDATE sessions SET skills_capable = 1 WHERE resume_id = ?1", [resume_id]);
        }
        if (filesCapable === true && callerTokenIsNetwork && callerAlias && callerAlias === effectiveAlias) {
          db.run("UPDATE sessions SET files_capable = 1 WHERE resume_id = ?1", [resume_id]);
        }
        if (logsCapable === true && callerTokenIsNetwork && callerAlias && callerAlias === effectiveAlias) {
          db.run("UPDATE sessions SET logs_capable = 1 WHERE resume_id = ?1", [resume_id]);
        }
        if (host || proc) {
          db.run(
            `INSERT INTO agent_telemetry (id, network_id, resume_id, alias, hostname, ip, cpu_load_1min, cpu_cores, mem_total_gb, mem_used_gb, mem_avail_gb, disk_total_gb, disk_used_gb, disk_avail_gb, process_rss_bytes, process_rss_mb, process_cpu_pct, process_uptime_seconds, process_in_flight_count, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, datetime('now'))`,
            [uuidv4(), sessionNetId, resume_id, effectiveAlias, hostHostname, hostIp, cpuLoad1m, cpuCores, memTotalGb, memUsedGb, memAvailGb, diskTotalGb, diskUsedGb, diskAvailGb, processRssBytes, processRssMb, processCpuPct, processUptimeSeconds, processInFlightCount]
          );
        }
      });
      // #448 — only the node token bound to this alias may speak for its health
      // (same rule as the *_capable flags above).
      const acceptedHealth = nodeHealth && callerTokenIsNetwork && callerAlias && callerAlias === effectiveAlias
        ? nodeHealth
        : undefined;
      if (acceptedHealth) {
        recordNodeHealth(sessionNetId, effectiveAlias, acceptedHealth);
        // #462 — model login went bad → tell the node's owner once (detect + notify only).
        if (callerTokenId) noteModelAuthHealth({ networkId: sessionNetId, alias: effectiveAlias, tokenId: callerTokenId, health: acceptedHealth });
      }
      pushEvent(effectiveAlias, {
        type: "status_update",
        alias: effectiveAlias,
        ...(canonical.renamed ? { renamed_from: alias } : {}),
        status,
        progress: progress ?? null,
        host: statusHostTelemetry,
        process_telemetry: statusProcessTelemetry,
        ...(acceptedHealth ? { health: acceptedHealth } : {}),
      }, sessionNetId);

      // V2: sync tasks table — report_status(working) → tasks.running
      if (status === "working" && task) {
        try {
          const runParams: any[] = [effectiveAlias, task];
          let runSql = `UPDATE tasks SET status = 'running', started_at = datetime('now')
             WHERE to_name = ?1 AND status IN ('delivered', 'acked') AND content = ?2`;
          runSql = addScope(runSql, runParams, effectiveNetId);
          const runResult = db.run(runSql, runParams);
          if (runResult.changes > 0) {
            // Find task_id for logging
            const findParams: any[] = [effectiveAlias, task];
            let findSql = "SELECT task_id FROM tasks WHERE to_name = ?1 AND content = ?2 AND status = 'running'";
            findSql = addScope(findSql, findParams, effectiveNetId);
            findSql += " ORDER BY started_at DESC LIMIT 1";
            const t = db.get<{ task_id: string }>(findSql, ...findParams);
            if (t) logTaskEvent(t.task_id, null, "running", effectiveAlias);
          }
        } catch {}
      }

      // V2: upsert nodes table for persistent node identity. SEC-1
      // gate (PR A #287 follow-up, 通信牛 catch 2026-06-28): delegate
      // to upsertNodeWithSec1Guard so production + test exercise the
      // exact same code path. See helper below registerTools.
      if (node_id) {
        try {
          const nodeRuntime = ag?.includes(":") ? ag.split(":")[1] + "-sdk" : ag ?? null;
          upsertNodeWithSec1Guard({
            node_id,
            callerNetworkId: effectiveNetId ?? null,
            callerUserId: enforceUserId ?? null,
            callerTokenId: callerTokenId ?? null,
            node_name: nn || effectiveAlias,
            alias: effectiveAlias,
            runtime: nodeRuntime,
            model: mdl ?? null,
            config_path: config_path ?? null,
            channels: channels ?? null,
            server: srv ?? null,
            hostname: hn ?? null,
            config_snapshot: cfgSnap ?? null,
          });
        } catch {}
      }

      // inbox uses alias for routing
      const inboxParams: any[] = [effectiveAlias];
      let inboxSql = "SELECT COUNT(*) as cnt FROM inbox WHERE session_name = ?1 AND acked = 0";
      inboxSql = addScope(inboxSql, inboxParams, effectiveNetId);
      const row = db.get<{ cnt: number }>(inboxSql, ...inboxParams);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              resume_id,
              alias: effectiveAlias,
              ...(canonical.renamed ? { renamed_from: alias } : {}),
              inbox_count: row?.cnt ?? 0,
            }),
          },
        ],
      };
    }
  );

  server.tool(
    "report_completion",
    "Report task completion with results and optional artifacts.",
    {
      alias: z.string().min(1).max(200).describe("Session alias"),
      task: z.string().min(1).max(10000).describe("Completed task description"),
      result: z.string().min(1).max(50000).describe("Result summary"),
      artifacts: z.array(z.string().max(2000)).max(50).optional().describe("Output URLs or file paths"),
      score: z.number().min(0).max(10).optional(),
      duration_minutes: z.number().min(0).optional(),
      network_id: z.string().max(200).optional().describe("Network scope"),
    },
    async ({ alias, task, result, artifacts, score, duration_minutes, network_id: netId }) => {
      const effectiveNetId = getNetworkId(netId);
      if (!canWrite(effectiveNetId)) {
        return writeDeniedReply(effectiveNetId);
      }
      console.log(`[${ts()}] ${alias} → report_completion: ${task.slice(0, 60)}${effectiveNetId ? " [net]" : ""}`);
      const id = uuidv4();
      let updatedTaskId: string | null = null;
      db.transaction(() => {
        db.run(
          `INSERT INTO completions (id, session_name, task, result, artifacts, score, duration_minutes, network_id)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
          [id, alias, task, result, artifacts ? JSON.stringify(artifacts) : null, score ?? null, duration_minutes ?? null, effectiveNetId ?? null]
        );
        const sessionParams: any[] = [alias];
        let sessionSql = `UPDATE sessions SET status = 'idle', task = NULL, progress = 0, updated_at = datetime('now')
           WHERE alias = ?1`;
        sessionSql = addScope(sessionSql, sessionParams, effectiveNetId);
        db.run(sessionSql, sessionParams);

        // V2: sync tasks table — try by task_id first, then by content
        const taskParams: any[] = [result.slice(0, 4000), task];
        let taskSql = `UPDATE tasks SET status = 'replied', result = ?1, completed_at = datetime('now')
           WHERE task_id = ?2 AND status IN ('delivered', 'acked', 'running')`;
        taskSql = addScope(taskSql, taskParams, effectiveNetId);
        const tu = db.run(taskSql, taskParams);
        if (tu.changes === 0) {
          const matchParams: any[] = [alias, task];
          let matchSql = `SELECT task_id FROM tasks WHERE to_name = ?1 AND content = ?2
             AND status IN ('delivered', 'acked', 'running')`;
          matchSql = addScope(matchSql, matchParams, effectiveNetId);
          matchSql += " ORDER BY created_at DESC LIMIT 1";
          const match = db.get<{ task_id: string }>(matchSql, ...matchParams);
          if (match) {
            const matchUpdateParams: any[] = [result.slice(0, 4000), match.task_id];
            let matchUpdateSql = "UPDATE tasks SET status = 'replied', result = ?1, completed_at = datetime('now') WHERE task_id = ?2";
            matchUpdateSql = addScope(matchUpdateSql, matchUpdateParams, effectiveNetId);
            db.run(matchUpdateSql, matchUpdateParams);
            updatedTaskId = match.task_id;
          }
        } else {
          updatedTaskId = task;
        }
        if (updatedTaskId) syncScheduledRunForTask(updatedTaskId, effectiveNetId);
      });
      // Log event after transaction
      if (updatedTaskId) logTaskEvent(updatedTaskId, null, "replied", alias, "report_completion");

      // Auto-chain to parent lineage (mirror of send_reply path).
      // round5 F2: pass caller's effectiveNetId so the chain refuses
      // to write across tenants if some upstream parent links to a
      // foreign network.
      //
      // round5 follow-up (通信牛 SSE leak catch): gate the SSE push on
      // `result.chained` — if the chain refused (cross-network), the
      // subsequent SELECT of `parent.from_name` + `pushEvent(...,
      // parent.task_id)` would leak the foreign parent's task_id into
      // the caller's network via the SSE payload. Skip the push when
      // the chain didn't actually write.
      if (updatedTaskId) {
        try {
          const chainResult = chainReplyToParent(updatedTaskId, result, "replied", 5, effectiveNetId);
          if (chainResult.chained) {
            const parentChain = db.get<{ parent_task_id: string | null }>(
              "SELECT parent_task_id FROM tasks WHERE task_id = ?1",
              [updatedTaskId]
            );
            if (parentChain?.parent_task_id) {
              const parent = db.get<{ from_name: string; task_id: string }>(
                "SELECT from_name, task_id FROM tasks WHERE task_id = ?1",
                [parentChain.parent_task_id]
              );
              if (parent?.from_name && parent.from_name !== "hub" && parent.from_name !== "api") {
                pushEvent(parent.from_name, { type: "chained_reply", parent_task_id: parent.task_id, child_task_id: updatedTaskId, child_alias: alias }, effectiveNetId);
              }
            }
          }
        } catch (e: any) {
          console.log(`[${ts()}] ⚠ chainReplyToParent (completion) failed: ${e.message}`);
        }
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: true, completion_id: id }) }],
      };
    }
  );

  server.tool(
    "get_inbox",
    "Get pending commands for your session.",
    {
      alias: z.string().min(1).max(200).describe("Session alias"),
      limit: z.number().min(1).max(100).optional().default(10),
    },
    async ({ alias, limit }) => {
      const readScope = resolveReadScope(null);
      if (readScope.denied) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: readScope.denied }) }] };
      const countParams: any[] = [alias];
      let countSql = "SELECT COUNT(*) as cnt FROM inbox WHERE session_name = ?1 AND acked = 0";
      countSql = addReadScope(countSql, countParams, readScope);
      const rows0 = db.get<{ cnt: number }>(countSql, ...countParams);
      console.log(`[${ts()}] ${alias} → get_inbox: ${rows0?.cnt ?? 0} pending messages`);
      const rowsParams: any[] = [alias];
      let rowsSql = `SELECT id, type, priority, content, context, from_session, created_at, network_id, meta_json,
         CASE WHEN type = 'task' THEN COALESCE(task_id, id) ELSE task_id END AS task_id
         FROM inbox WHERE session_name = ?1 AND acked = 0`;
      rowsSql = addReadScope(rowsSql, rowsParams, readScope);
      rowsSql += ` ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, created_at
         LIMIT ?${rowsParams.length + 1}`;
      rowsParams.push(limit);
      const rows = db.all(rowsSql, ...rowsParams).map((row: any) => ({
        ...row,
        meta: parseMetaJson(row.meta_json),
      }));

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: true, messages: rows }) }],
      };
    }
  );

  server.tool(
    "ack_inbox",
    "Acknowledge receipt of a command.",
    {
      alias: z.string().min(1).max(200).describe("Session alias"),
      message_id: z.string().min(1).max(200),
      response: z.string().max(10000).optional(),
      network_id: z.string().max(200).optional().describe("Network scope (auto-resolved for single-network user tokens)"),
    },
    async ({ alias, message_id, response, network_id: netId }) => {
      const effectiveNetId = getNetworkId(netId);
      if (!canWrite(effectiveNetId)) return writeDeniedReply(effectiveNetId);
      console.log(`[${ts()}] ${alias} → ack_inbox: ${message_id.slice(0, 8)}`);
      // New task consumers ACK by the logical tasks.task_id exposed by
      // get_inbox. Keep exact inbox.id support for legacy consumers and for
      // non-task messages. Restrict the lookup to pending rows: after a retry
      // the original row can have id == task_id but is already ACKed, while
      // the current row has a fresh transport id and the same logical task_id.
      const inboxTaskParams: any[] = [message_id, alias];
      let inboxTaskSql = `SELECT id, type, COALESCE(task_id, id) AS task_id
         FROM inbox
         WHERE session_name = ?2 AND acked = 0
           AND (id = ?1 OR (type = 'task' AND task_id = ?1))`;
      inboxTaskSql = addScope(inboxTaskSql, inboxTaskParams, effectiveNetId);
      inboxTaskSql += " ORDER BY created_at DESC LIMIT 1";
      const inboxTask = db.get<{ id: string; type: string; task_id: string }>(inboxTaskSql, ...inboxTaskParams);
      if (!inboxTask) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "message not found or already acknowledged" }) }],
        };
      }
      const ackParams: any[] = [inboxTask.id, alias];
      let ackSql = "UPDATE inbox SET acked = 1 WHERE id = ?1 AND session_name = ?2 AND acked = 0";
      ackSql = addScope(ackSql, ackParams, effectiveNetId);
      const result = db.run(ackSql, ackParams);
      if (result.changes === 0) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "message not found or not yours" }) }],
        };
      }
      // V2: sync tasks table — ack_inbox means delivered→acked
      try {
        if (inboxTask?.type !== "task") {
          return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }] };
        }
        const taskParams: any[] = [inboxTask.task_id];
        let taskSql = "UPDATE tasks SET status = 'acked' WHERE task_id = ?1 AND status = 'delivered'";
        taskSql = addScope(taskSql, taskParams, effectiveNetId);
        const ackResult = db.run(taskSql, taskParams);
        if (ackResult.changes > 0) logTaskEvent(inboxTask.task_id, "delivered", "acked", alias);
      } catch {}
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }],
      };
    }
  );

  // #520 — two monotonic runtime-evidence levels for exact tasks.
  //
  // runtime_submitted_at means agent-node handed the body to the vendor
  // runtime. consumed_at is stronger: an attributable turn-start or first
  // activity event came back. Merely fetching/acking an inbox row sets neither.
  // Node identity comes exclusively from the ntok; callers cannot self-report
  // an alias or node_id. A consumed mark also fills runtime_submitted_at because
  // that stronger fact logically implies submission.
  const markTaskRuntimeEvidence = (
    taskIds: string[],
    level: "submitted" | "consumed",
    taskContexts: Array<{ task_id: string; thread_id: string; turn_id: string }> = [],
  ) => {
    const task_ids = taskIds;
    if (!callerTokenIsNetwork || !callerAlias || !enforceNetworkId) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "node_token_required" }) }],
      };
    }
    // The all-or-nothing batch promise needs a transaction() that really is
    // one transaction; refuse evidence on any adapter that cannot give that
    // rather than publish a partially stamped batch.
    if (db.transactionalFeaturesRefusal !== null) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({
          ok: false,
          error: "task_runtime_evidence_backend_unsupported", message: db.transactionalFeaturesRefusal || undefined,
        }) }],
      };
    }

      const uniqueTaskIds = [...new Set(task_ids)];
      if (uniqueTaskIds.length !== task_ids.length) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "duplicate_task_id" }) }],
        };
      }

      if (level !== "consumed" && taskContexts.length > 0) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "runtime_context_requires_consumed" }) }],
        };
      }
      const contextByTaskId = new Map(taskContexts.map((context) => [context.task_id, context]));
      if (contextByTaskId.size !== taskContexts.length) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "duplicate_task_context" }) }],
        };
      }
      const foreignContext = taskContexts.find((context) => !uniqueTaskIds.includes(context.task_id));
      if (foreignContext) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "task_context_not_requested", task_id: foreignContext.task_id }) }],
        };
      }

      const placeholders = uniqueTaskIds.map((_, i) => `?${i + 2}`).join(", ");

      // Keep ownership preflight and every stamp in one SQLite transaction.
      // This closes the cross-process preflight→UPDATE race: no other writer
      // can reassign a task between the identity decision and the write.
      const outcome = db.transaction(() => {
        const canonicalCaller = resolveCanonicalAlias(enforceNetworkId, callerAlias).alias;
        const callerSession = db.get<{ node_id: string | null }>(
          `SELECT node_id FROM sessions
           WHERE network_id = ?1 AND alias = ?2
           ORDER BY updated_at DESC LIMIT 1`,
          enforceNetworkId,
          canonicalCaller,
        );
        const rows = db.all<{ task_id: string; to_node_id: string | null; to_name: string; thread_id: string | null; turn_id: string | null }>(
          `SELECT task_id, to_node_id, to_name, thread_id, turn_id FROM tasks
           WHERE network_id = ?1 AND task_id IN (${placeholders})`,
          enforceNetworkId,
          ...uniqueTaskIds,
        );
        const owned = new Map(rows.map((row) => [row.task_id, row]));
        const rejectedTaskId = uniqueTaskIds.find((taskId) => {
          const row = owned.get(taskId);
          if (!row) return true;
          // Prefer immutable node identity whenever the task has one.  Direct
          // and legacy token-bound sessions legitimately have NULL node_id;
          // only that shape may fall back to the canonical token alias.
          if (row.to_node_id) return row.to_node_id !== callerSession?.node_id;
          return resolveCanonicalAlias(enforceNetworkId, row.to_name).alias !== canonicalCaller;
        });
        if (rejectedTaskId) {
          return { ok: false as const, error: "task_not_owned", task_id: rejectedTaskId };
        }
        const conflictingContext = uniqueTaskIds.find((taskId) => {
          const context = contextByTaskId.get(taskId);
          if (!context) return false;
          const row = owned.get(taskId)!;
          return (row.thread_id !== null && row.thread_id !== context.thread_id)
            || (row.turn_id !== null && row.turn_id !== context.turn_id);
        });
        if (conflictingContext) {
          return { ok: false as const, error: "task_runtime_context_conflict", task_id: conflictingContext };
        }

        for (const taskId of uniqueTaskIds) {
          const row = owned.get(taskId)!;
          const ownershipSql = row.to_node_id
            ? "to_node_id = ?3"
            : "to_node_id IS NULL AND to_name = ?3";
          const ownerValue = row.to_node_id ?? row.to_name;
          let updateResult;
          if (level === "consumed") {
            const context = contextByTaskId.get(taskId);
            updateResult = db.run(
              `UPDATE tasks SET
                 runtime_submitted_at = COALESCE(runtime_submitted_at, datetime('now')),
                 consumed_at = COALESCE(consumed_at, datetime('now')),
                 thread_id = COALESCE(thread_id, ?4),
                 turn_id = COALESCE(turn_id, ?5)
               WHERE network_id = ?1 AND task_id = ?2 AND ${ownershipSql}`,
              [enforceNetworkId, taskId, ownerValue, context?.thread_id ?? null, context?.turn_id ?? null],
            );
          } else {
            updateResult = db.run(
              `UPDATE tasks SET runtime_submitted_at = COALESCE(runtime_submitted_at, datetime('now'))
               WHERE network_id = ?1 AND task_id = ?2 AND ${ownershipSql}`,
              [enforceNetworkId, taskId, ownerValue],
            );
          }
          if (updateResult.changes !== 1) {
            // A zero-row write after a successful preflight is an invariant
            // failure, never a successful evidence report.
            throw new Error(`task_runtime_evidence_write_race:${taskId}`);
          }
        }
        const evidenceRows = db.all<{
          task_id: string;
          runtime_submitted_at: string;
          consumed_at: string | null;
          thread_id: string | null;
          turn_id: string | null;
        }>(
          `SELECT task_id, runtime_submitted_at, consumed_at, thread_id, turn_id FROM tasks
           WHERE network_id = ?1 AND task_id IN (${placeholders})`,
          enforceNetworkId,
          ...uniqueTaskIds,
        );
        return { ok: true as const, tasks: evidenceRows };
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(outcome),
        }],
      };
  };

  const taskRuntimeEvidenceSchema = {
    task_ids: z.array(z.string().min(1).max(200)).min(1).max(100),
    task_contexts: z.array(z.object({
      task_id: z.string().min(1).max(200),
      thread_id: z.string().min(1).max(500),
      turn_id: z.string().min(1).max(500),
    }).strict()).max(100).optional(),
  };

  server.tool(
    "mark_tasks_runtime_submitted",
    "Internal agent-node signal: exact task bodies were submitted to this token-bound node's vendor runtime.",
    taskRuntimeEvidenceSchema,
    async ({ task_ids, task_contexts }) => markTaskRuntimeEvidence(task_ids, "submitted", task_contexts),
  );

  server.tool(
    "mark_tasks_consumed",
    "Internal agent-node signal: exact tasks produced attributable turn-start/activity evidence in this token-bound node's runtime.",
    taskRuntimeEvidenceSchema,
    async ({ task_ids, task_contexts }) => markTaskRuntimeEvidence(task_ids, "consumed", task_contexts),
  );

  // ═══════════════════════════════════════════
  //  Hub Tools (5)
  // ═══════════════════════════════════════════

  server.tool(
    "get_all_status",
    "Get status of all sessions. Hub uses this for the patrol loop. " +
      "Pass filter_alias (comma-separated) when you only care about specific " +
      "nodes — the unfiltered result is one row per session with 31 columns and " +
      "is large enough on a real fleet that callers cannot read it.",
    {
      filter_status: z.string().max(50).optional(),
      filter_server: z.string().max(200).optional(),
      // 2026-08-17: on a 222-session hub the unfiltered response is ~259 KB, past
      // what an MCP client can take in one result — so the caller that wanted the
      // status of THREE nodes could not get it from this tool at all. The patrol
      // loop still wants everything, hence optional rather than required.
      filter_alias: z.string().max(2000).optional()
        .describe("One alias, or several separated by commas. Exact matches only."),
      network_id: z.string().max(200).optional().describe("Filter by network"),
    },
    async ({ filter_status, filter_server, filter_alias, network_id: netId }) => {
      const readScope = resolveReadScope(netId);
      if (readScope.denied) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: readScope.denied }) }] };
      console.log(`[${ts()}] hub → get_all_status${filter_status ? ": filter=" + filter_status : ""}${filter_alias ? " alias=" + filter_alias.slice(0, 80) : ""}${readScope.networkId ? " net=" + readScope.networkId.slice(0, 12) : ""}`);

      // Round-2/4 review ③: stale-marking moved to startStaleSessionSweeper()
      // (background timer, ~60s cadence). Read path no longer fires UPDATE.
      let sql = "SELECT * FROM sessions WHERE 1=1";
      const params: any[] = [];
      sql = addAgentNetworkScope(sql, params, readScope, { alias: "alias", nodeId: "node_id" });
      if (filter_status) { sql += " AND status = ?"; params.push(filter_status); }
      if (filter_server) { sql += " AND server = ?"; params.push(filter_server); }
      const aliasFilter = parseAliasFilter(filter_alias);
      const aliases = aliasFilter.aliases;
      if (aliasFilter.sql) {
        sql += aliasFilter.sql;
        params.push(...aliases);
      }
      sql += " ORDER BY updated_at DESC";
      const sessions = db.all(sql, ...params);

      // `summary` has always counted every session in the read scope, ignoring
      // filter_status / filter_server — and now filter_alias. That is fine for
      // the patrol loop, but a caller who asked about three aliases and gets
      // back three rows plus "idle: 96" can easily read the 96 as being about
      // their three. A count that does not say what it counted invites exactly
      // that. So the response now says so, rather than the semantics changing
      // under existing callers.
      const summaryParams: any[] = [];
      let summarySql = "SELECT status, COUNT(*) as count FROM sessions WHERE 1=1";
      summarySql = addAgentNetworkScope(summarySql, summaryParams, readScope, { alias: "alias", nodeId: "node_id" });
      summarySql += " GROUP BY status";
      const summary = db.all(summarySql, ...summaryParams);

      const filtered = !!(filter_status || filter_server || aliases.length > 0);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              sessions,
              summary,
              summary_scope: filtered
                ? "every session in the read scope — NOT narrowed by the filters applied to `sessions`"
                : "every session in the read scope",
              sessions_returned: sessions.length,
            }),
          },
        ],
      };
    }
  );

  server.tool(
    "get_session_status",
    "Get detailed status of a specific session by alias.",
    { alias: z.string().min(1).max(200).describe("Session alias") },
    async ({ alias }) => {
      const readScope = resolveReadScope(null);
      if (readScope.denied) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: readScope.denied }) }] };
      console.log(`[${ts()}] hub → get_session_status: ${alias}`);
      const sessionParams: any[] = [alias];
      let sessionSql = "SELECT * FROM sessions WHERE alias = ?1";
      sessionSql = addAgentNetworkScope(sessionSql, sessionParams, readScope, { alias: "alias", nodeId: "node_id" });
      const session = db.get(sessionSql, ...sessionParams);

      const pendingParams: any[] = [alias];
      let pendingSql = "SELECT COUNT(*) as cnt FROM inbox WHERE session_name = ?1 AND acked = 0";
      pendingSql = addReadScope(pendingSql, pendingParams, readScope);
      const pending = db.get<{ cnt: number }>(pendingSql, ...pendingParams);

      const recentParams: any[] = [alias];
      let recentSql = "SELECT * FROM completions WHERE session_name = ?1";
      recentSql = addReadScope(recentSql, recentParams, readScope);
      recentSql += " ORDER BY completed_at DESC LIMIT 5";
      const recent = db.all(recentSql, ...recentParams);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: true, session, inbox_pending: pending?.cnt ?? 0, recent_completions: recent }),
          },
        ],
      };
    }
  );

  server.tool(
    "send_task",
    "Dispatch a task to a session's inbox (by alias).",
    {
      alias: z.string().min(1).max(200).describe("Target session alias"),
      task: z.string().min(1).max(10000).describe("Task content"),
      priority: z.enum(["high", "normal", "low"]).optional().default("normal"),
      context: z.string().max(10000).optional(),
      from_session: z.string().max(200).optional(),
      ttl_seconds: z.number().min(1).max(86400).optional().describe("Task TTL in seconds (default: 3600)"),
      network_id: z.string().max(200).optional().describe("Network scope"),
      parent_task_id: z.string().max(200).optional().describe("Parent task this dispatch is on behalf of. When the child task replies the hub will auto-chain the answer to the parent task's originator, so the user sees the final result even if the intermediate session ends."),
      meta: z.any().optional().describe("Optional structured task metadata, e.g. { attachments: [{ type, path, url, mime, name, size }] }."),
      force: z.boolean().optional().describe("dispatch even if the target is degraded (user tokens only)"),
    },
    async ({ alias, task, priority, context, from_session: _fromIn, ttl_seconds, network_id: netId, parent_task_id: parentIn, meta, force }) => { const fromMismatch = fromIdentityMismatchReply(_fromIn); if (fromMismatch) return fromMismatch; const from_session = defaultFrom(_fromIn);
      const effectiveNetId = getNetworkId(netId);
      const authOrigin: TaskAuthOrigin = callerTokenIsNetwork
        ? "node"
        : enforceUserId
          ? "user"
          : "legacy";
      const metaJson = normalizeMetaJson(stampTaskAuthOrigin(meta, authOrigin));

      // Role check FIRST — round5 follow-up (通信牛 oracle catch):
      // the explicit-parent verification below distinguishes
      // `cross_network_parent` from `permission_denied`. If we ran the
      // parent lookup before canWrite, a viewer role could probe parent
      // existence + ownership of foreign parents via the difference in
      // error codes. Run canWrite first so a viewer ALWAYS gets the
      // same `permission_denied` regardless of parent state.
      {
        const sendDenied = agentSendDenied(effectiveNetId, alias, _fromIn, "send_task", meta);
        if (sendDenied) return sendDenied;
      }

      // Resolve parent_task_id: EXPLICIT ONLY.
      //
      // round5 F1 used to network-scope an inference here that adopted the
      // caller's "most recent delivered/started inbox task that's still
      // open" as the parent. Node-TMAI#4: that inference is blind to *who
      // the child is answering*. On a session holding two concurrent open
      // tasks, whichever was dispatched last becomes the parent, and
      // chainReplyToParent (db.ts) then writes the child's answer into that
      // unrelated task's `result`. An unparented dispatch is now simply
      // unparented. Callers must pass parent_task_id explicitly; the
      // explicit id is still network-verified immediately below in F2.
      let parentTaskId: string | null = parentIn ?? null;

      // round5 F2 fix: an explicit parent_task_id must belong to the
      // caller's network. Otherwise a malicious caller in network B can
      // hand us a parent id from network A and have chainReplyToParent
      // (db.ts) write back into A's task result + inbox — cross-tenant
      // write. Verify ownership, reject on mismatch.
      if (parentIn) {
        const parentRow = db.get<{ network_id: string | null; from_name: string; to_name: string }>(
          "SELECT network_id, from_name, to_name FROM tasks WHERE task_id = ?1",
          [parentIn]
        );
        if (!parentRow) {
          // Parent doesn't exist (LLM hallucination, race with retention
          // sweep, etc.). Drop the link silently so the dispatch can
          // still proceed; the LLM may have meant to dispatch fresh.
          console.log(`[${ts()}] ⚠ send_task: parent_task_id=${parentIn.slice(0, 8)} not found, dropping parent link`);
          parentTaskId = null;
        } else if ((parentRow.network_id ?? null) !== (effectiveNetId ?? null)) {
          console.log(`[${ts()}] 🚫 send_task: cross-network parent rejected, parent=${parentIn.slice(0, 8)} parent-net=${parentRow.network_id ?? "null"} caller-net=${effectiveNetId ?? "null"}`);
          return { content: [{ type: "text" as const, text: JSON.stringify({
            ok: false, error: "cross_network_parent",
            message: "parent_task_id belongs to a different network",
          }) }] };
        } else {
          // Node-TMAI#4 (E): same-network is NOT sufficient. The dispatcher
          // must be a party to the task it claims as parent — either its
          // originator or its assignee. Without this, a same-network caller
          // could attach its dispatch to any third party's task and the
          // chain would later surface that child's result to the third
          // party's originator. Compare canonical aliases so a committed
          // rename on either side cannot defeat the check.
          const canonicalParentFrom = resolveCanonicalAlias(effectiveNetId, parentRow.from_name).alias;
          const canonicalParentTo = resolveCanonicalAlias(effectiveNetId, parentRow.to_name).alias;
          const canonicalChildFrom = resolveCanonicalAlias(effectiveNetId, from_session).alias;
          if (canonicalChildFrom !== canonicalParentFrom && canonicalChildFrom !== canonicalParentTo) {
            console.log(`[${ts()}] 🚫 send_task: non-participant parent rejected, parent=${parentIn.slice(0, 8)} caller=${canonicalChildFrom}`);
            return { content: [{ type: "text" as const, text: JSON.stringify({
              ok: false, error: "parent_not_participant",
              message: "parent_task_id is not a task this sender took part in",
            }) }] };
          }
        }
      }

      // License check
      const license = db.get<any>("SELECT type, expires_at FROM licenses ORDER BY created_at LIMIT 1");
      if (license?.expires_at) {
        const now = new Date().toISOString().replace("T", " ").slice(0, 19);
        if (license.expires_at < now) {
          return { content: [{ type: "text" as const, text: JSON.stringify({
            ok: false, error: "license_expired",
            message: "Trial expired. Activate a license: anet activate <key>",
          }) }] };
        }
      }

      const canonical = resolveCanonicalAlias(effectiveNetId, alias);
      const targetAlias = canonical.alias;
      const target = resolveDeliveryTarget(targetAlias, effectiveNetId);
      if (target.state === "not_found") return deliveryTargetReply(target)!;

      // Dashboard sends carry a random client_request_id inside meta. Derive
      // the task primary key from authenticated scope + that request id so a
      // lost HTTP response can be retried safely, even after a hub restart.
      // The existing row must match the full request; key reuse with changed
      // content/target fails closed instead of silently returning another task.
      const clientRequestId = clientRequestIdFromMeta(meta);
      const id = clientRequestId
        ? idempotentTaskId(effectiveNetId ?? null, from_session, clientRequestId)
        : uuidv4();
      if (clientRequestId) {
        const existing = db.get<StoredIdempotentTask & { to_node_id: string | null }>(
          "SELECT task_id, from_name, to_node_id, to_name, priority, content, network_id, meta_json, status FROM tasks WHERE task_id = ?1",
          [id],
        );
        if (existing) {
          if (!idempotentTaskMatches(existing, {
            fromName: from_session, toName: targetAlias, priority, content: task,
            networkId: effectiveNetId ?? null, metaJson,
          })) {
            return { content: [{ type: "text" as const, text: JSON.stringify({
              ok: false, error: "idempotency_conflict",
              message: "client_request_id was already used with a different task payload",
            }) }] };
          }
          console.log(`[${ts()}] ${from_session} → send_task → ${targetAlias}: REPLAY (key=request_id, task=${existing.task_id.slice(0, 13)})`);
          return { content: [{ type: "text" as const, text: JSON.stringify({
            ok: true, message_id: existing.task_id, task_id: existing.task_id,
            task_status: existing.status, idempotent_replay: true,
            // A replay acknowledges the already-persisted dispatch. Use that
            // row rather than today's session record so alias reuse or a
            // restarted process cannot rewrite historical recipient identity.
            actual_to: {
              alias: existing.to_name,
              to_node_id: existing.to_node_id ?? null,
              network_id: existing.network_id ?? null,
            },
          }) }] };
        }
      }

      // #212 dedup guardrail. If this exact (from, to, content) has already
      // been delivered within COMMHUB_SEND_DEDUP_WINDOW_MS (default 5 min)
      // we refuse the call and surface a structured `duplicate_send`
      // error. The LLM receives the Chinese hint inside details.message
      // and can act on it (rewrite the task or wait). See A站Grok #212
      // incident: 50+ identical dispatches across 5 LLM turns ignored
      // three STOP replies — the LLM cannot be trusted to debounce
      // itself, so the runtime layer must.
      //
      // A send carrying a validated client_request_id is keyed on that id
      // instead of the content hash (send_dedup.ts header): a human typing
      // the same short text twice sent two messages. Same-id retries were
      // already answered from the durable row above.
      const dedupScope = { requestId: clientRequestId, networkId: effectiveNetId ?? null };
      const dedup = sharedSendDedup.check(from_session, targetAlias, task, undefined, dedupScope);
      if (dedup.duplicate) {
        const payload = buildDuplicateSendPayload({
          from: from_session,
          to: targetAlias,
          ageMs: dedup.ageMs,
          windowMs: sharedSendDedup.windowMs,
        });
        console.log(`[${ts()}] ${from_session} → send_task → ${targetAlias}: DROPPED duplicate (key=${dedup.kind}, age=${dedup.ageMs}ms, window=${sharedSendDedup.windowMs}ms)`);
        return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
      }

      // RFC-027 §2.3 inbox-enqueue lifecycle guard (PR1.1 site 1/6).
      {
        const lc = assertNodeActive(targetAlias, effectiveNetId ?? null);
        if (!lc.ok) return { content: [{ type: "text" as const, text: JSON.stringify(lc) }] };
      }
      // #460 — a node whose fresh health says a layer is down will not run the task: refuse instead of queueing silently.
      {
        const hg = assertNodeHealthy(targetAlias, effectiveNetId ?? null, { force, forceAllowed: !callerTokenIsNetwork });
        if (!hg.ok) return { content: [{ type: "text" as const, text: JSON.stringify(hg) }] };
      }

      console.log(`[${ts()}] ${from_session} → send_task → ${targetAlias}: ${task.slice(0, 60)}${priority === "high" ? " [HIGH]" : ""}${canonical.renamed ? ` [renamed from ${alias}]` : ""}`);
      const fromNodeId = resolveNodeIdForAlias(from_session, effectiveNetId);
      const targetNodeId = target.session?.node_id ?? null;
      const resolvedActualTo = actualTo(target, effectiveNetId);
      // 事务：inbox + tasks 双写 + 触碰目标 session 的 task/updated_at（让
      // dashboard 在派任务一刻就反映出"任务已下发"，不再等 agent 的
      // report_status 心跳；status 字段交给 agent，避免与 working/idle
      // 报告冲突）。
      db.transaction(() => {
        db.run(
          `INSERT INTO inbox (id, task_id, session_name, node_id, type, priority, content, context, from_session, requires_response, network_id, meta_json)
           VALUES (?1, ?1, ?2, ?3, 'task', ?4, ?5, ?6, ?7, 'reply', ?8, ?9)`,
          [id, targetAlias, targetNodeId, priority, task, context ?? null, from_session, effectiveNetId ?? null, metaJson]
        );
        db.run(
          `INSERT INTO tasks (task_id, from_node_id, from_name, to_node_id, to_name, priority, status, content, requires_response, created_at, delivered_at, expires_at, network_id, parent_task_id, meta_json)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'delivered', ?7, 'reply', datetime('now'), datetime('now'), datetime('now', ?8), ?9, ?10, ?11)`,
          [id, fromNodeId, from_session, targetNodeId, targetAlias, priority, task, `+${ttl_seconds || 3600} seconds`, effectiveNetId ?? null, parentTaskId, metaJson]
        );
        const touchParams: any[] = [task.slice(0, 200), targetAlias];
        let touchSql = "UPDATE sessions SET task = ?1, updated_at = datetime('now') WHERE alias = ?2";
        touchSql = addScope(touchSql, touchParams, effectiveNetId);
        db.run(touchSql, touchParams);
        // #1548 —— 能派活的发送方不可能真的 blocked;此处出 blocked → idle。
        releaseBlockedSession(from_session, effectiveNetId);
      });
      logTaskEvent(id, null, "delivered", from_session, parentTaskId ? `→ ${targetAlias} (parent=${parentTaskId.slice(0,8)})` : `→ ${targetAlias}`);
      // Only stamp the dedup index after the inbox/tasks transaction
      // succeeds, so a failed insert never silently shadows a legitimate
      // retry.
      sharedSendDedup.record(from_session, targetAlias, task, undefined, dedupScope);

      // SSE push by alias.
      // The SSE channel is keyed by alias (subscribers connected to /events/<alias>),
      // not by network_id. Earlier we gated the push on a network-scoped session
      // lookup, which silently dropped pushes whenever an agent registered with
      // network_id=null but the sender supplied an explicit network_id (the
      // exact mismatch hit by Dashboard tasks). Push unconditionally; the
      // subscriber's own auth (ntok_) constrains who can listen.
      const pendingParams: any[] = [targetAlias];
      let pendingSql = "SELECT COUNT(*) as cnt FROM inbox WHERE session_name = ?1 AND acked = 0";
      pendingSql = addScope(pendingSql, pendingParams, effectiveNetId);
      const pending = db.get<{ cnt: number }>(pendingSql, ...pendingParams);
      // 🔴 不要用 last_seen_at 的时间戳去猜「有没有人在听」——SSE 订阅者注册表
      // 就是那件事本身。pushEvent 在没有订阅者时已经是 no-op，所以这道闸不提供
      // 任何保护，只会把**连着但最近没心跳**的会话排除掉；而全网「停发心跳/状态类
      // 消息」的省额度规则让安静恰恰是常态。上面那段注释早就写着 "Push
      // unconditionally"，同一类缺陷上次也是打在 Dashboard 任务上（f015d9d6：
      // 任务标了 delivered，会话却从未收到推送）。
      pushEvent(targetAlias, { type: "new_task", inbox_count: pending?.cnt ?? 1, priority, from: from_session, ...(canonical.renamed ? { renamed_from: alias } : {}) }, effectiveNetId);
      const actuallyDelivered = hasSubscribers(targetAlias, effectiveNetId);
      // #461 network observer summary — unconditional (task row exists
      // even when the target is offline/queued), metadata only.
      pushNetworkObserverEvent(effectiveNetId, { type: "new_task", task_id: id, from: from_session, to: targetAlias, status: actuallyDelivered ? "delivered" : "queued", priority });

      if (target.state === "offline") {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              ok: false,
              error: "alias_offline",
              message: target.message,
              alias: targetAlias,
              queued: true,
              task_id: id,
              message_id: id,
              session_status: target.session.status ?? "offline",
              actual_to: resolvedActualTo,
              ...(canonical.renamed ? { renamed_from: alias, renamed_to: targetAlias } : {}),
            }),
          }],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              message_id: id,
              actual_to: resolvedActualTo,
              ...(canonical.renamed ? { renamed_from: alias, renamed_to: targetAlias } : {}),
              session_status: target.session?.status ?? "unknown",
            }),
          },
        ],
      };
    }
  );

  server.tool(
    "send_message",
    "Send a message to a session (no task lifecycle, just chat). Use for replies, status updates, or casual communication.",
    {
      alias: z.string().min(1).max(200).describe("Target session alias"),
      message: z.string().min(1).max(10000).describe("Message content"),
      from_session: z.string().max(200).optional(),
      network_id: z.string().max(200).optional().describe("Network scope (auto-resolved for single-network user tokens)"),
    },
    async ({ alias, message, from_session: _fromIn, network_id: netId }) => { const fromMismatch = fromIdentityMismatchReply(_fromIn); if (fromMismatch) return fromMismatch; const from_session = defaultFrom(_fromIn);
      const effectiveNetId = getNetworkId(netId);
      { const sendDenied = agentSendDenied(effectiveNetId, alias, _fromIn, "write"); if (sendDenied) return sendDenied; }
      const canonical = resolveCanonicalAlias(effectiveNetId, alias);
      const targetAlias = canonical.alias;
      const target = resolveDeliveryTarget(targetAlias, effectiveNetId);
      if (target.state === "not_found") return deliveryTargetReply(target)!;
      // RFC-027 §2.3 inbox-enqueue lifecycle guard (PR1.1 site 2/6).
      {
        const lc = assertNodeActive(targetAlias, effectiveNetId ?? null);
        if (!lc.ok) return { content: [{ type: "text" as const, text: JSON.stringify(lc) }] };
      }
      console.log(`[${ts()}] ${from_session} → send_message → ${targetAlias}: ${message.slice(0, 60)}${canonical.renamed ? ` [renamed from ${alias}]` : ""}`);
      const id = uuidv4();
      db.run(
        `INSERT INTO inbox (id, session_name, node_id, type, priority, content, from_session, network_id)
         VALUES (?1, ?2, ?3, 'message', 'normal', ?4, ?5, ?6)`,
        [id, targetAlias, target.session?.node_id ?? null, message, from_session, effectiveNetId ?? null]
      );

      // 同 send_task：可达性用订阅者注册表判，不用心跳时间戳猜。
      pushEvent(targetAlias, { type: "new_message", inbox_count: pendingInboxCount(targetAlias, effectiveNetId), from: from_session, message_id: id, ...(canonical.renamed ? { renamed_from: alias } : {}) }, effectiveNetId);

      const offlineReply = deliveryTargetReply(target, { message_id: id });
      if (offlineReply) {
        const payload = JSON.parse(offlineReply.content[0].text);
        offlineReply.content[0].text = JSON.stringify({
          ...payload,
          ...(canonical.renamed ? { renamed_from: alias, renamed_to: targetAlias } : {}),
        });
        return offlineReply;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              message_id: id,
              ...(canonical.renamed ? { renamed_from: alias, renamed_to: targetAlias } : {}),
              session_status: target.session?.status ?? "unknown",
            }),
          },
        ],
      };
    }
  );

  // ── V2/V3 reply primitives ──
  const replyToolSchema = {
      // #1085 — alias is OPTIONAL: when omitted (or empty) and `in_reply_to`
      // is set, the hub derives the target from the original task's
      // `from_name` (it already SELECTs that task by in_reply_to below).
      // The SDK-runtime bridge (agent-node/src/commhub-mcp.ts) exposes
      // send_reply as (task_id, text, status) with NO alias, so before this
      // it always sent alias=undefined → -32602 "expected string, received
      // undefined at alias". The target was already knowable from the task,
      // so requiring the caller to pass it was a redundant-param trap.
      alias: z.string().min(1).max(200).optional().describe("Target session alias — optional; derived from in_reply_to's task sender when omitted"),
      text: z.string().min(1).max(10000).describe("Reply content"),
      in_reply_to: z.string().max(200).optional().describe("Original task/message ID"),
      status: z.enum(["replied", "failed", "cancelled"]).optional().default("replied").describe("Task outcome"),
      from_session: z.string().max(200).optional(),
      network_id: z.string().max(200).optional().describe("Network scope (auto-resolved for single-network user tokens)"),
      // #507 — top-level attachments (parity with REST /api/task L506). MCP Zod
      // otherwise silently strips unknown fields, so a caller passing
      // `attachments` before this schema entry existed would see `ok:true`
      // and never learn the attachments were dropped. Validated by
      // validateAttachments (uploads.ts) — the same helper the REST path uses.
      attachments: z.any().optional().describe("Attachments, like send_task's meta.attachments: [{type:'file', file_id, name?, mime?, size?}]."),
      // #507 — optional structured metadata (parity with send_task L837). If
      // both `attachments` (top-level) and `meta.attachments` are supplied,
      // top-level wins (same rule as REST /api/task L2101).
      meta: z.any().optional().describe("Optional structured reply metadata, e.g. { attachments: [...] }."),
    };
  const handleReply = async (args: any, peerCapabilityRequired: boolean) => {
      const { alias, text, in_reply_to, status: replyStatus = "replied", from_session: _fromIn, network_id: netId, attachments, meta } = args;
      const fromMismatch = fromIdentityMismatchReply(_fromIn); if (fromMismatch) return fromMismatch; const from_session = defaultFrom(_fromIn);
      const effectiveNetId = getNetworkId(netId);
      if (!canWrite(effectiveNetId)) return writeDeniedReply(effectiveNetId);
      if (peerCapabilityRequired && !in_reply_to) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "peer_reply_task_required" }) }] };
      }

      // #507 — validate attachments BEFORE any DB write. Rejects malformed
      // input (bad file_id, >20 items, size > cap, non-object item, wrong
      // type field) with an explicit error the caller can act on. Empty /
      // absent attachments return { ok: true, attachments: [] } — the
      // reverse-(e) invariant (no attachments → behavior unchanged) is
      // pinned by tests that assert byte-identical response shape
      // before/after this validation runs.
      const attachmentsResult = validateAttachments(attachments ?? (meta && typeof meta === "object" ? (meta as any).attachments : undefined));
      if (!attachmentsResult.ok) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              ok: false,
              error: "bad_attachments",
              message: attachmentsResult.error,
            }),
          }],
        };
      }
      const mergedMeta = attachmentsResult.attachments.length
        ? { ...(meta && typeof meta === "object" ? meta : {}), attachments: attachmentsResult.attachments }
        : meta;
      const metaJson = normalizeMetaJson(mergedMeta);

      // #1085 — derive the reply target when the caller omitted `alias`.
      // The original task's `from_name` IS the reply target; the hub knows
      // it from `in_reply_to`. Without this, an SDK-runtime send_reply
      // (schema has no alias) died with -32602 before reaching this handler.
      let effectiveAlias: string | undefined =
        (typeof alias === "string" && alias.trim()) ? alias : undefined;
      if (!effectiveAlias) {
        if (!in_reply_to) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "reply_target_required", message: "alias omitted and no in_reply_to to derive it from" }) }] };
        }
        const derivParams: any[] = [in_reply_to];
        let derivSql = "SELECT from_name FROM tasks WHERE task_id = ?1";
        derivSql = addScope(derivSql, derivParams, effectiveNetId);
        const derived = db.get<{ from_name: string }>(derivSql, ...derivParams);
        if (!derived?.from_name) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "reply_target_unresolved", message: `alias omitted and could not derive target from in_reply_to (${in_reply_to})` }) }] };
        }
        effectiveAlias = derived.from_name;
      }

      const canonicalReplyTarget = resolveCanonicalAlias(effectiveNetId, effectiveAlias);
      const replyTargetAlias = canonicalReplyTarget.alias;
      // 回复定时任务:收件人换成建排程的用户(见 scheduledReplyRecipient)。replyTargetAlias 仍是
      // 'scheduler',下面的归属/目标校验照旧对它判;只有 inbox 行与推送走 replyDeliveryAlias。
      const scheduledRecipient = in_reply_to && replyTargetAlias === "scheduler"
        ? scheduledReplyRecipient(in_reply_to, effectiveNetId)
        : null;
      const replyDeliveryAlias = scheduledRecipient ?? replyTargetAlias;
      console.log(`[${ts()}] ${from_session} → send_reply (${replyStatus}) → ${replyDeliveryAlias}: ${text.slice(0, 60)}${attachmentsResult.attachments.length ? ` [+${attachmentsResult.attachments.length} attachments]` : ""}${canonicalReplyTarget.renamed ? ` [renamed from ${effectiveAlias}]` : ""}${scheduledRecipient ? " [scheduled task → creator]" : ""}`);
      const id = uuidv4();
      const replyTargetNodeId = resolveNodeIdForAlias(replyDeliveryAlias, effectiveNetId);
      // RFC-027 §2.3 inbox-enqueue lifecycle guard (PR1.1 site 3/6).
      {
        const lc = assertNodeActive(replyDeliveryAlias, effectiveNetId ?? null);
        if (!lc.ok) return { content: [{ type: "text" as const, text: JSON.stringify(lc) }] };
      }
      const replyOutcome = db.transaction(() => {
        type ReplyTask = {
          status: string;
          from_node_id: string | null;
          from_name: string;
          to_name: string;
          to_node_id: string | null;
        };
        let taskBefore: ReplyTask | null = null;
        let callerNodeId: string | null = null;
        if (in_reply_to) {
          const taskParams: any[] = [in_reply_to];
          let taskSql = "SELECT status, from_node_id, from_name, to_name, to_node_id FROM tasks WHERE task_id = ?1";
          taskSql = addScope(taskSql, taskParams, effectiveNetId);
          taskBefore = db.get<ReplyTask>(taskSql, ...taskParams) ?? null;
          if (!taskBefore) return { ok: false as const, error: "reply_task_not_found" as const };
          if (!["created", "delivered", "acked", "running"].includes(taskBefore.status)) {
            return { ok: false as const, error: "reply_task_terminal" as const, taskStatus: taskBefore.status };
          }

          // V3 atomic peer replies are capability-negotiated. Both identity
          // bindings and the recipient capability are re-read inside this
          // transaction before any inbox/task/run write. Legacy/unbound rows
          // fail toward compatibility send_reply, which terminalizes the
          // original task instead of creating a second response-requiring row.
          if (peerCapabilityRequired) {
            if (!taskBefore.from_node_id) {
              // Origin type is an intrinsic property of the task and must be
              // decided before caller capability. A Dashboard/human task still
              // needs the established send_reply terminalization path when the
              // replying node uses a legacy/unbound token.
              return { ok: false as const, error: "peer_reply_origin_not_node" as const };
            }
            if (!callerTokenIsNetwork || !callerTokenId || !enforceNetworkId) {
              return { ok: false as const, error: "peer_reply_node_token_required" as const };
            }
            const token = db.get<{ bound_node_id: string | null }>(
              "SELECT bound_node_id FROM api_tokens WHERE token_id = ?1 AND network_id = ?2",
              callerTokenId,
              enforceNetworkId,
            );
            if (!token?.bound_node_id || !taskBefore.to_node_id) {
              return { ok: false as const, error: "peer_reply_unsupported" as const };
            }
            if (token.bound_node_id !== taskBefore.to_node_id) {
              return { ok: false as const, error: "reply_task_not_owned" as const };
            }
            callerNodeId = token.bound_node_id;
            const canonicalTarget = replyTargetAlias;
            const canonicalOrigin = resolveCanonicalAlias(enforceNetworkId, taskBefore.from_name).alias;
            if (canonicalTarget !== canonicalOrigin) {
              return { ok: false as const, error: "reply_target_mismatch" as const };
            }
            const recipient = db.get<{ peer_reply_inbox_capable: number }>(
              `SELECT peer_reply_inbox_capable FROM sessions
               WHERE node_id = ?1 AND network_id = ?2 AND alias = ?3
               ORDER BY updated_at DESC LIMIT 1`,
              taskBefore.from_node_id,
              enforceNetworkId,
              canonicalOrigin,
            );
            if (recipient?.peer_reply_inbox_capable !== 1) {
              return { ok: false as const, error: "peer_reply_unsupported" as const };
            }
          } else if (callerTokenIsNetwork && enforceNetworkId) {
            // Compatibility send_reply is still an exact task transition for
            // node callers. Bind it to the token-authenticated assignee alias
            // and immutable original sender. Alias binding survives a
            // legitimate node-id rotation without letting another node close
            // the task.
            const canonicalCaller = resolveCanonicalAlias(enforceNetworkId, from_session).alias;
            const canonicalAssignee = resolveCanonicalAlias(enforceNetworkId, taskBefore.to_name).alias;
            if (canonicalCaller !== canonicalAssignee) {
              return { ok: false as const, error: "reply_task_not_owned" as const };
            }
            const canonicalOrigin = resolveCanonicalAlias(enforceNetworkId, taskBefore.from_name).alias;
            if (replyTargetAlias !== canonicalOrigin) {
              return { ok: false as const, error: "reply_target_mismatch" as const };
            }
          }

        }

        // #507 — write meta_json on inbox insert (parity with send_task L952).
        // Prior to this the attachments field on a send_reply call was
        // silently stripped by MCP Zod, leaving `ok:true` with no persisted
        // meta.
        db.run(
          `INSERT INTO inbox (id, session_name, node_id, type, priority, content, from_session, in_reply_to, requires_response, network_id, meta_json)
           VALUES (?1, ?2, ?3, 'reply', 'normal', ?4, ?5, ?6, 'none', ?7, ?8)`,
          [id, replyDeliveryAlias, replyTargetNodeId, text, from_session, in_reply_to ?? null, effectiveNetId ?? null, metaJson]
        );

        // 更新 tasks 表
        if (in_reply_to) {
          // #507 — persist meta_json onto the tasks row too, so
          // dashboard's task view sees the reply's attachments alongside
          // the reply text (parity with send_task L957/959 which writes
          // meta_json into both inbox and tasks). The COALESCE guards
          // against clobbering pre-existing meta_json when this reply
          // brings no attachments (metaJson === null → keep the existing
          // task meta_json unchanged). Reverse-(e) invariant.
          // #1823 —— 回复的附件写到 tasks.meta_json.reply_attachments,**不碰** meta_json.attachments:
          // 那个键是提问者随任务带的附件,客户端把它画在提问者的气泡里。以前这里用回复的 metaJson
          // 整体 COALESCE 替换,于是 agent 回的图出现在提问者气泡下面、提问者自己带的附件被覆盖
          // (Vincent 2026-09-06 实测「好像没成功发送给我」)。inbox 行(收件方视角)照旧写 metaJson。
          const replyTaskMetaJson = (() => {
            if (!attachmentsResult.attachments.length) return null;
            const rowParams: any[] = [in_reply_to];
            let rowSql = "SELECT meta_json FROM tasks WHERE task_id = ?1";
            rowSql = addScope(rowSql, rowParams, effectiveNetId);
            const existing = db.get<{ meta_json: string | null }>(rowSql, ...rowParams)?.meta_json ?? null;
            let base: Record<string, unknown> = {};
            if (existing) { try { const parsed = JSON.parse(existing); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) base = parsed; } catch {} }
            return JSON.stringify({ ...base, reply_attachments: attachmentsResult.attachments });
          })();
          const updateParams: any[] = [replyStatus, text, replyTaskMetaJson, in_reply_to];
          let updateSql = `UPDATE tasks
             SET status = ?1,
                 result = ?2,
                 completed_at = datetime('now'),
                 meta_json = COALESCE(?3, meta_json)
             WHERE task_id = ?4 AND status IN ('created', 'delivered', 'acked', 'running')`;
          if (peerCapabilityRequired && callerTokenIsNetwork && taskBefore) {
            if (taskBefore.to_node_id) {
              updateParams.push(callerNodeId);
              updateSql += ` AND to_node_id = ?${updateParams.length}`;
            } else {
              updateParams.push(taskBefore.to_name);
              updateSql += ` AND to_node_id IS NULL AND to_name = ?${updateParams.length}`;
            }
          }
          updateSql = addScope(updateSql, updateParams, effectiveNetId);
          const result = db.run(updateSql, updateParams);
          if (result.changes === 0) {
            throw new Error(`reply_atomic_cas_failed:${in_reply_to}`);
          }
          syncScheduledRunForTask(in_reply_to, effectiveNetId);
          // #1548 —— 终态回复是最强的活性证据:一个还标着 blocked 的发送方在此回到 idle。
          //   只出 blocked;working 可能真在忙别的任务,不碰。
          releaseBlockedSession(from_session, effectiveNetId);
          return { ok: true as const, replyLogged: true };
        }
        return { ok: true as const, replyLogged: false };
      });

      if (!replyOutcome.ok) {
        const taskStatus = "taskStatus" in replyOutcome ? replyOutcome.taskStatus : undefined;
        const messages: Record<string, string> = {
          reply_task_not_found: `cannot apply reply: task not found (${in_reply_to})`,
          reply_task_terminal: `cannot apply reply: task is already terminal (${taskStatus})`,
          peer_reply_node_token_required: "atomic peer reply requires a node token",
          peer_reply_unsupported: "recipient or caller does not support atomic peer replies",
          peer_reply_origin_not_node: "original task sender is not a node; use send_reply",
          reply_node_identity_unbound: "cannot apply reply: node identity is not token-bound",
          reply_task_not_owned: "cannot apply reply: task is not owned by this node",
          reply_target_mismatch: "cannot apply reply: target is not the original task sender",
        };
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              ok: false,
              error: replyOutcome.error,
              message: messages[replyOutcome.error],
              in_reply_to,
              ...(taskStatus ? { task_status: taskStatus } : {}),
              reply_queued: false,
            }),
          }],
        };
      }
      const replyLogged = replyOutcome.replyLogged;

      // Log event after commit (outside transaction)
      if (replyLogged && in_reply_to) logTaskEvent(in_reply_to, null, replyStatus, from_session, text.slice(0, 200));

      // Auto-chain reply up to parent task lineage so admin sees the final
      // answer even if the intermediate session has died.
      // round5 F2: pass caller's effectiveNetId so the chain refuses
      // to write across tenants if some upstream parent links to a
      // foreign network.
      //
      // round5 follow-up (通信牛 SSE leak catch): gate the SSE push on
      // `result.chained`. See report_completion path above for the
      // full reasoning — same leak, same gate.
      if (replyLogged && in_reply_to) {
        try {
          const chainResult = chainReplyToParent(in_reply_to, text, replyStatus, 5, effectiveNetId);
          if (chainResult.chained) {
            const parentChain = db.get<{ parent_task_id: string | null; from_name: string }>(
              "SELECT parent_task_id, from_name FROM tasks WHERE task_id = ?1",
              [in_reply_to]
            );
            if (parentChain?.parent_task_id) {
              const parent = db.get<{ from_name: string; task_id: string }>(
                "SELECT from_name, task_id FROM tasks WHERE task_id = ?1",
                [parentChain.parent_task_id]
              );
              if (parent?.from_name && parent.from_name !== "hub" && parent.from_name !== "api") {
                pushEvent(parent.from_name, { type: "chained_reply", parent_task_id: parent.task_id, child_task_id: in_reply_to, child_alias: alias }, effectiveNetId);
              }
            }
          }
        } catch (e: any) {
          console.log(`[${ts()}] ⚠ chainReplyToParent failed: ${e.message}`);
        }
      }

      const session = scopedSessionStatus(replyDeliveryAlias, effectiveNetId);
      pushEvent(replyDeliveryAlias, { type: "new_reply", inbox_count: pendingInboxCount(replyDeliveryAlias, effectiveNetId), from: from_session, message_id: id, in_reply_to, status: replyStatus }, effectiveNetId);
      // #461 network observer summary — ids + routing only, no reply text.
      pushNetworkObserverEvent(effectiveNetId, { type: "new_reply", task_id: in_reply_to ?? null, message_id: id, from: from_session, to: replyDeliveryAlias, status: replyStatus });

      // #498 compatibility tripwire. Legacy send_reply is intentionally kept
      // for old agents and Dashboard callers during rollout, but it is not the
      // capability-negotiated atomic peer primitive. Warn only for an actual
      // agent target; Dashboard hub/api replies remain quiet. New agents call
      // send_peer_reply and never see this warning.
      const targetIsAgent = replyTargetNodeId !== null
        && replyTargetAlias !== "hub"
        && replyTargetAlias !== "api";
      const warning = !peerCapabilityRequired && targetIsAgent
        ? `Target "${replyTargetAlias}" is an agent node. Legacy commhub_reply/send_reply terminalized the original task; upgraded peers should prefer commhub_send_peer_reply for capability-negotiated delivery. (RFC-030 mixed-version rollout.)`
        : undefined;

      // #507 — echo attachments READ BACK FROM DB (lead 2b5f6634): the point
      // of the echo is to prove attachments actually landed in storage, not
      // to reflect the in-memory variable we tried to write. Reading
      // `attachmentsResult.attachments` here would still show `ok:true` +
      // full echo if the UPDATE failed with `changes=0` (e.g. task moved to
      // terminal between the pre-check and the transaction). SELECT from
      // inbox.meta_json (always written, uses the id we just generated) so
      // the echo means "these attachments are on disk now". Absent field
      // when the caller sent no attachments — reverse-(e) invariant: a
      // no-attachment call returns the exact same response shape as before
      // this PR. Persisted-attachments field is only added when the caller
      // actually asked for attachments.
      let attachmentsSaved: unknown[] | null = null;
      if (attachmentsResult.attachments.length > 0) {
        const persistedRow = db.get<{ meta_json: string | null }>(
          "SELECT meta_json FROM inbox WHERE id = ?1", [id]
        );
        const persistedMeta = parseMetaJson(persistedRow?.meta_json ?? null);
        attachmentsSaved = persistedMeta && typeof persistedMeta === "object" && Array.isArray((persistedMeta as any).attachments)
          ? (persistedMeta as any).attachments
          : [];
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            ok: true,
            message_id: id,
            session_status: session?.status ?? "unknown",
            ...(warning ? { warning } : {}),
            ...(attachmentsSaved !== null ? { attachments_saved: attachmentsSaved } : {}),
          }),
        }],
      };
    };

  server.tool(
    "send_reply",
    "Reply to a Dashboard/UI-originated task. Also serves as the terminal legacy fallback when atomic peer reply capability is unavailable.",
    replyToolSchema,
    (args) => handleReply(args, false),
  );
  server.tool(
    "send_peer_reply",
    "Atomically finalize one node-owned task and enqueue one no-response result when the exact recipient advertises peer_reply_inbox_capable. Stored capability survives transient SSE disconnects; legacy peers return peer_reply_unsupported with zero writes.",
    replyToolSchema,
    (args) => handleReply(args, true),
  );

  // ── V2: send_ack (不入 inbox，仅更新状态) ──
  server.tool(
    "send_ack",
    "Acknowledge receipt of a task. Does NOT enter inbox. Updates task status only.",
    {
      task_id: z.string().min(1).max(200).describe("Task ID to acknowledge"),
      from_session: z.string().max(200).optional(),
      network_id: z.string().max(200).optional().describe("Network scope (auto-resolved for single-network user tokens)"),
    },
    async ({ task_id, from_session: _fromIn, network_id: netId }) => { const fromMismatch = fromIdentityMismatchReply(_fromIn); if (fromMismatch) return fromMismatch; const from_session = defaultFrom(_fromIn);
      const effectiveNetId = getNetworkId(netId);
      if (!canWrite(effectiveNetId)) return writeDeniedReply(effectiveNetId);
      console.log(`[${ts()}] ${from_session} → send_ack → task ${task_id.slice(0, 8)}`);
      const updateParams: any[] = [task_id];
      let updateSql = "UPDATE tasks SET status = 'acked' WHERE task_id = ?1 AND status IN ('created', 'delivered')";
      updateSql = addScope(updateSql, updateParams, effectiveNetId);
      const result = db.run(updateSql, updateParams);
      if (result.changes > 0) logTaskEvent(task_id, "delivered", "acked", from_session);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ ok: result.changes > 0, task_id, updated: result.changes }),
        }],
      };
    }
  );

  // ── V2: retry_task (重新投递失败/过期任务) ──
  server.tool(
    "retry_task",
    "Retry a failed, expired, or cancelled task. Resets status to delivered and re-queues in inbox.",
    {
      task_id: z.string().min(1).max(200).describe("Task ID to retry"),
      from_session: z.string().max(200).optional(),
      network_id: z.string().max(200).optional().describe("Network scope (auto-resolved for single-network user tokens)"),
      force: z.boolean().optional().describe("dispatch even if the target is degraded (user tokens only)"),
    },
    async ({ task_id, from_session: _fromIn, network_id: netId, force }) => { const fromMismatch = fromIdentityMismatchReply(_fromIn); if (fromMismatch) return fromMismatch; const from_session = defaultFrom(_fromIn);
      const effectiveNetId = getNetworkId(netId);
      if (!canWrite(effectiveNetId)) return writeDeniedReply(effectiveNetId);
      console.log(`[${ts()}] ${from_session} → retry_task → ${task_id.slice(0, 8)}`);
      // Find the original task
      const taskParams: any[] = [task_id];
      let taskSql = "SELECT * FROM tasks WHERE task_id = ?1";
      taskSql = addScope(taskSql, taskParams, effectiveNetId);
      const task = db.get<any>(taskSql, ...taskParams);
      if (!task) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "task not found" }) }] };
      }
      if (!["failed", "expired", "cancelled"].includes(task.status)) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: `task status is ${task.status}, not retryable` }) }] };
      }
      // RFC-027 §2.3 inbox-enqueue lifecycle guard (PR1.1 site 4/6).
      {
        const lc = assertNodeActive(task.to_name, effectiveNetId ?? task.network_id ?? null);
        if (!lc.ok) return { content: [{ type: "text" as const, text: JSON.stringify(lc) }] };
      }
      // #460 — a node whose fresh health says a layer is down will not run the task: refuse instead of queueing silently.
      {
        const hg = assertNodeHealthy(task.to_name, effectiveNetId ?? task.network_id ?? null, { force, forceAllowed: !callerTokenIsNetwork });
        if (!hg.ok) return { content: [{ type: "text" as const, text: JSON.stringify(hg) }] };
      }
      db.transaction(() => {
        // Reset task status
        const updateParams: any[] = [task_id];
        let updateSql = `UPDATE tasks SET status = 'delivered', result = NULL, completed_at = NULL, started_at = NULL, delivered_at = datetime('now'), expires_at = datetime('now', '+1 hour')
           WHERE task_id = ?1`;
        updateSql = addScope(updateSql, updateParams, effectiveNetId);
        db.run(updateSql, updateParams);
        syncScheduledRunForTask(task_id, effectiveNetId ?? task.network_id ?? null);
        // Re-queue in inbox with new ID (original ID may already exist)
        const retryInboxId = uuidv4();
        db.run(
          `INSERT INTO inbox (id, task_id, session_name, node_id, type, priority, content, from_session, requires_response, network_id)
           VALUES (?1, ?2, ?3, ?4, 'task', ?5, ?6, ?7, 'reply', ?8)`,
          [retryInboxId, task_id, task.to_name, task.to_node_id ?? resolveNodeIdForAlias(task.to_name, effectiveNetId ?? task.network_id ?? null), task.priority, task.content, from_session, effectiveNetId ?? task.network_id ?? null]
        );
      });
      logTaskEvent(task_id, task.status, "delivered", from_session, "retry");
      // SSE push (unconditional — channel is keyed by alias, not network)
      pushEvent(task.to_name, { type: "new_task", inbox_count: pendingInboxCount(task.to_name, effectiveNetId ?? task.network_id ?? null), priority: task.priority, from: from_session }, effectiveNetId ?? task.network_id ?? null);
      pushNetworkObserverEvent(effectiveNetId ?? task.network_id ?? null, { type: "new_task", task_id, from: from_session, to: task.to_name, status: "delivered", priority: task.priority });
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: true, task_id, retried_to: task.to_name }) }],
      };
    }
  );

  // ── V2: get_task (查询任务状态) ──
  server.tool(
    "get_task",
    "Get task details by task_id. Returns status, result, timestamps.",
    {
      task_id: z.string().min(1).max(200).describe("Task ID to query"),
    },
    async ({ task_id }) => {
      const readScope = resolveReadScope(null);
      if (readScope.denied) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: readScope.denied }) }] };
      const params: any[] = [task_id];
      let sql = "SELECT * FROM tasks WHERE task_id = ?1";
      sql = addOwnTrafficScope(sql, params, readScope, { from: "from_name", to: "to_name", fromNodeId: "from_node_id", toNodeId: "to_node_id" });
      const task = db.get<any>(sql, ...params);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(task ? { ok: true, task } : { ok: false, error: "task not found" }),
        }],
      };
    }
  );

  // ── V2: list_tasks (查询任务列表) ──
  server.tool(
    "list_tasks",
    "List tasks with filters. Agents can query their own pending/running tasks.",
    {
      alias: z.string().max(200).optional().describe("Filter by to_name (target agent)"),
      status: z.string().max(50).optional().describe("Filter by status"),
      from_name: z.string().max(200).optional().describe("Filter by sender"),
      from_node_id: z.string().max(200).optional().describe("Filter by immutable sender node_id"),
      network_id: z.string().max(200).optional().describe("Filter by network"),
      before_created_at: z.string().max(64).optional().describe("Pagination cursor timestamp"),
      before_task_id: z.string().max(200).optional().describe("Pagination cursor task id"),
      durable_cursor: z.boolean().optional().describe("Require immutable node-scoped cursor protocol"),
      durable_terminal_cursor: z.boolean().optional().describe("Read terminal outbound journal in monotonic order"),
      after_terminal_seq: z.number().int().min(0).optional().describe("Exclusive terminal journal watermark"),
      limit: z.number().min(1).max(100).optional().default(20),
    },
    async ({ alias, status, from_name, from_node_id, network_id: netId, before_created_at, before_task_id, durable_cursor, durable_terminal_cursor, after_terminal_seq, limit }) => {
      const readScope = resolveReadScope(netId);
      if (readScope.denied) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: readScope.denied }) }] };
      if (durable_cursor) {
        if (!callerTokenIsNetwork) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "node_token_required" }) }] };
        const boundNodeId = callerTokenId && enforceNetworkId
          ? db.get<{ bound_node_id: string | null }>(
              "SELECT bound_node_id FROM api_tokens WHERE token_id = ?1 AND network_id = ?2",
              callerTokenId,
              enforceNetworkId,
            )?.bound_node_id ?? null
          : null;
        if (!boundNodeId || from_node_id !== boundNodeId) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "from_node_id_identity_mismatch" }) }] };
        }
      }
      if (durable_terminal_cursor) {
        if (!durable_cursor) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "durable_cursor_required" }) }] };
        const params: any[] = [enforceNetworkId, from_node_id, after_terminal_seq ?? 0, limit];
        const tasks = db.all(
          `SELECT t.task_id, t.from_node_id, t.from_name, t.to_node_id, t.to_name, t.priority,
                  t.status, t.content, t.result, t.created_at, t.runtime_submitted_at,
                  t.consumed_at, t.thread_id, t.turn_id, t.completed_at, e.terminal_seq
             FROM task_terminal_events e
             JOIN tasks t ON t.task_id = e.task_id
            WHERE COALESCE(e.network_id, 'default') = COALESCE(?1, 'default')
              AND e.from_node_id = ?2 AND e.terminal_seq > ?3
            ORDER BY e.terminal_seq ASC LIMIT ?4`,
          ...params,
        );
        return { content: [{ type: "text" as const, text: JSON.stringify({
          ok: true,
          capability: "list_tasks.immutable-terminal-sequence.v2",
          tasks,
          count: tasks.length,
          next_terminal_seq: tasks.length ? tasks[tasks.length - 1]?.terminal_seq : (after_terminal_seq ?? 0),
          has_more: tasks.length === limit,
        }) }] };
      }
      let sql = "SELECT task_id, from_node_id, from_name, to_node_id, to_name, priority, status, content, result, created_at, runtime_submitted_at, consumed_at, thread_id, turn_id, completed_at FROM tasks WHERE 1=1";
      const params: any[] = [];
      sql = addOwnTrafficScope(sql, params, readScope, { from: "from_name", to: "to_name", fromNodeId: "from_node_id", toNodeId: "to_node_id" });
      if (alias) { sql += ` AND to_name = ?${params.length + 1}`; params.push(alias); }
      if (status) { sql += ` AND status = ?${params.length + 1}`; params.push(status); }
      if (from_name) { sql += ` AND from_name = ?${params.length + 1}`; params.push(from_name); }
      if (from_node_id) { sql += ` AND from_node_id = ?${params.length + 1}`; params.push(from_node_id); }
      if (before_created_at && before_task_id) {
        sql += ` AND (created_at < ?${params.length + 1} OR (created_at = ?${params.length + 1} AND task_id < ?${params.length + 2}))`;
        params.push(before_created_at, before_task_id);
      }
      sql += ` ORDER BY created_at DESC, task_id DESC LIMIT ?${params.length + 1}`;
      params.push(limit);
      const tasks = db.all(sql, ...params);

      // Stats
      const statsParams: any[] = [];
      let statsSql = "SELECT status, COUNT(*) as count FROM tasks WHERE 1=1";
      statsSql = addOwnTrafficScope(statsSql, statsParams, readScope, { from: "from_name", to: "to_name", fromNodeId: "from_node_id", toNodeId: "to_node_id" });
      statsSql += " GROUP BY status";
      const stats = db.all(statsSql, ...statsParams);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            ok: true,
            ...(durable_cursor ? { capability: "list_tasks.immutable-node-cursor.v1" } : {}),
            tasks,
            count: tasks.length,
            next_cursor: tasks.length === limit ? {
              before_created_at: tasks[tasks.length - 1]?.created_at,
              before_task_id: tasks[tasks.length - 1]?.task_id,
            } : null,
            stats,
          }),
        }],
      };
    }
  );

  // ── V2: cancel_task (取消任务) ──
  server.tool(
    "cancel_task",
    "Cancel a pending task. Works on delivered/acked/running tasks.",
    {
      task_id: z.string().min(1).max(200).describe("Task ID to cancel"),
      reason: z.string().max(1000).optional().describe("Cancellation reason"),
      from_session: z.string().max(200).optional(),
      network_id: z.string().max(200).optional().describe("Network scope (auto-resolved for single-network user tokens)"),
    },
    async ({ task_id, reason, from_session: _fromIn, network_id: netId }) => { const fromMismatch = fromIdentityMismatchReply(_fromIn); if (fromMismatch) return fromMismatch; const from_session = defaultFrom(_fromIn);
      const effectiveNetId = getNetworkId(netId);
      if (!canWrite(effectiveNetId)) return writeDeniedReply(effectiveNetId);
      console.log(`[${ts()}] ${from_session} → cancel_task → ${task_id.slice(0, 8)}`);
      const updateParams: any[] = [reason || "cancelled by " + from_session, task_id];
      let updateSql = `UPDATE tasks SET status = 'cancelled', result = ?1, completed_at = datetime('now')
         WHERE task_id = ?2 AND status IN ('created', 'delivered', 'acked', 'running')`;
      updateSql = addScope(updateSql, updateParams, effectiveNetId);
      const result = db.transaction(() => {
        const updated = db.run(updateSql, updateParams);
        // Also ack the inbox entry to prevent agent from picking it up.
        if (updated.changes > 0) {
          const inboxParams: any[] = [task_id];
          let inboxSql = "UPDATE inbox SET acked = 1 WHERE COALESCE(task_id, id) = ?1 AND acked = 0";
          inboxSql = addScope(inboxSql, inboxParams, effectiveNetId);
          db.run(inboxSql, inboxParams);
          syncScheduledRunForTask(task_id, effectiveNetId);
        }
        return updated;
      });
      if (result.changes > 0) logTaskEvent(task_id, null, "cancelled", from_session, reason || undefined);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: result.changes > 0, task_id, cancelled: result.changes > 0 }) }],
      };
    }
  );

  // ── V2: reassign_task (转移任务到另一个 agent) ──
  server.tool(
    "reassign_task",
    "Reassign a task to a different agent. Works on any non-terminal task (delivered/acked/running).",
    {
      task_id: z.string().min(1).max(200).describe("Task ID to reassign"),
      new_alias: z.string().min(1).max(200).describe("Target agent alias"),
      from_session: z.string().max(200).optional(),
      network_id: z.string().max(200).optional().describe("Network scope (auto-resolved for single-network user tokens)"),
      force: z.boolean().optional().describe("dispatch even if the target is degraded (user tokens only)"),
    },
    async ({ task_id, new_alias, from_session: _fromIn, network_id: netId, force }) => { const fromMismatch = fromIdentityMismatchReply(_fromIn); if (fromMismatch) return fromMismatch; const from_session = defaultFrom(_fromIn);
      const effectiveNetId = getNetworkId(netId);
      if (!canWrite(effectiveNetId)) return writeDeniedReply(effectiveNetId);
      console.log(`[${ts()}] ${from_session} → reassign_task → ${task_id.slice(0, 8)} → ${new_alias}`);
      const taskParams: any[] = [task_id];
      let taskSql = "SELECT * FROM tasks WHERE task_id = ?1";
      taskSql = addScope(taskSql, taskParams, effectiveNetId);
      const task = db.get<any>(taskSql, ...taskParams);
      if (!task) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "task not found" }) }] };
      if (["replied", "failed", "cancelled", "expired"].includes(task.status)) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: `task is terminal (${task.status})` }) }] };
      }
      const oldAlias = task.to_name;
      const canonical = resolveCanonicalAlias(effectiveNetId ?? task.network_id ?? null, new_alias);
      const reassignedAlias = canonical.alias;
      const target = resolveDeliveryTarget(reassignedAlias, effectiveNetId ?? task.network_id ?? null);
      const newNodeId = target.state === "not_found" ? null : (target.session?.node_id ?? null);
      // RFC-027 §2.3 inbox-enqueue lifecycle guard (PR1.1 site 5/6).
      {
        const lc = assertNodeActive(reassignedAlias, effectiveNetId ?? task.network_id ?? null);
        if (!lc.ok) return { content: [{ type: "text" as const, text: JSON.stringify(lc) }] };
      }
      // #460 — a node whose fresh health says a layer is down will not run the task: refuse instead of queueing silently.
      {
        const hg = assertNodeHealthy(reassignedAlias, effectiveNetId ?? task.network_id ?? null, { force, forceAllowed: !callerTokenIsNetwork });
        if (!hg.ok) return { content: [{ type: "text" as const, text: JSON.stringify(hg) }] };
      }
      db.transaction(() => {
        // Ack old inbox to prevent original agent from picking it up
        const inboxParams: any[] = [task_id];
        let inboxSql = "UPDATE inbox SET acked = 1 WHERE COALESCE(task_id, id) = ?1 AND acked = 0";
        inboxSql = addScope(inboxSql, inboxParams, effectiveNetId);
        db.run(inboxSql, inboxParams);

        const updateParams: any[] = [reassignedAlias, newNodeId, task_id];
        let updateSql = "UPDATE tasks SET to_name = ?1, to_node_id = ?2, status = 'delivered', started_at = NULL, delivered_at = datetime('now') WHERE task_id = ?3";
        updateSql = addScope(updateSql, updateParams, effectiveNetId);
        db.run(updateSql, updateParams);

        const newInboxId = uuidv4();
        db.run("INSERT INTO inbox (id, task_id, session_name, node_id, type, priority, content, from_session, requires_response, network_id) VALUES (?1, ?2, ?3, ?4, 'task', ?5, ?6, ?7, 'reply', ?8)",
          [newInboxId, task_id, reassignedAlias, newNodeId, task.priority, task.content, from_session, effectiveNetId ?? task.network_id ?? null]);
      });
      logTaskEvent(task_id, task.status, "delivered", from_session, `reassign: ${oldAlias} → ${reassignedAlias}`);
      pushEvent(reassignedAlias, { type: "new_task", inbox_count: pendingInboxCount(reassignedAlias, effectiveNetId ?? task.network_id ?? null), priority: task.priority, from: from_session, ...(canonical.renamed ? { renamed_from: new_alias } : {}) }, effectiveNetId ?? task.network_id ?? null);
      pushNetworkObserverEvent(effectiveNetId ?? task.network_id ?? null, { type: "new_task", task_id, from: from_session, to: reassignedAlias, status: "delivered", priority: task.priority });
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, task_id, reassigned_from: oldAlias, reassigned_to: reassignedAlias, ...(canonical.renamed ? { renamed_from: new_alias, renamed_to: reassignedAlias } : {}) }) }] };
    }
  );

  server.tool(
    "send_desktop_message",
    "Push a message to a user's active Desktop/web clients in one network. Targets user identity, not node alias.",
    {
      to_user_id: z.string().min(1).max(200).optional().describe("Target user_id. Mutually checked with to_username when both are supplied."),
      to_username: z.string().min(1).max(50).optional().describe("Target username. Mutually checked with to_user_id when both are supplied."),
      title: z.string().max(200).optional(),
      message: z.string().min(1).max(10000),
      severity: z.enum(["info", "success", "warning", "error"]).optional().default("info"),
      kind: z.string().min(1).max(80).optional().default("agent_message"),
      meta: z.record(z.string(), z.unknown()).optional(),
      from_session: z.string().max(200).optional(),
      network_id: z.string().max(200).optional().describe("Network scope (auto-resolved for single-network user tokens; ntok stays bound to its network)."),
    },
    async ({ to_user_id, to_username, title, message, severity, kind, meta, from_session: _fromIn, network_id: netId }) => {
      const fromMismatch = fromIdentityMismatchReply(_fromIn);
      if (fromMismatch) return fromMismatch;
      const from_session = defaultFrom(_fromIn);
      const effectiveNetId = getNetworkId(netId);
      // 人类 ↔ 人类私信:受限成员也能发(canWriteHuman 不看 Agent 授权),但发件人固定为自己的用户名。
      if (!canWriteHuman(effectiveNetId)) return writeDeniedReply(effectiveNetId, "write");
      if (effectiveNetId && restrictedNets.includes(effectiveNetId) && _fromIn?.trim() && _fromIn.trim() !== callerAlias) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "from_session_identity_mismatch", message: "restricted members always send as their own username" }) }] };
      }
      if (!effectiveNetId) return writeDeniedReply(effectiveNetId, "write");

      if (!to_user_id && !to_username) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "desktop_target_required", message: "to_user_id or to_username is required" }) }] };
      }

      const byId = to_user_id
        ? db.get<{ user_id: string; username: string }>("SELECT user_id, username FROM users WHERE user_id = ?1", to_user_id)
        : null;
      const byName = to_username
        ? db.get<{ user_id: string; username: string }>("SELECT user_id, username FROM users WHERE username = ?1", to_username)
        : null;

      if (to_user_id && !byId) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "desktop_target_not_found", field: "to_user_id" }) }] };
      }
      if (to_username && !byName) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "desktop_target_not_found", field: "to_username" }) }] };
      }
      if (byId && byName && byId.user_id !== byName.user_id) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "desktop_target_mismatch", to_user_id, to_username }) }] };
      }

      const target = byId ?? byName;
      if (!target) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "desktop_target_not_found" }) }] };
      }

      const targetRole = getUserNetworkRole(target.user_id, effectiveNetId);
      if (!targetRole) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "desktop_target_not_in_network", network_id: effectiveNetId }) }] };
      }

      const messageId = `dm_${uuidv4()}`;
      const event = {
        type: "desktop_message",
        message_id: messageId,
        kind,
        from: from_session,
        title: title || null,
        message,
        severity,
        created_at: new Date().toISOString(),
        ...(meta && Object.keys(meta).length ? { meta } : {}),
      };

      // #1459 ① P2 —— 审计与收件持久化必须同生共死：只落其中一半，就会出现
      // 「审计说发过、而用户永远收不到」或者反过来。放进同一个事务。
      db.transaction(() => {
        db.run(
          `INSERT INTO audit_log (user_id, username, action, target_type, target_id, detail, network_id)
           VALUES (?1, ?2, 'send_desktop_message', 'user', ?3, ?4, ?5)`,
          [
            enforceUserId || null,
            callerAlias || null,
            target.user_id,
            JSON.stringify({
              message_id: messageId,
              to_username: target.username,
              from: from_session,
              severity,
              kind,
              title: title || null,
              meta_keys: meta && typeof meta === "object" ? Object.keys(meta) : [],
            }),
            effectiveNetId,
          ],
        );
        // 🔴 `ON CONFLICT(message_id) DO NOTHING`，而不是 `INSERT OR IGNORE`：
        //   两者对"重投同一个 message_id"效果相同（幂等，不产生重复消息），
        //   但 OR IGNORE 会**连同其它约束错误一起吞掉** —— 我在实现本段时就
        //   撞上了：`kind` 为 NULL 触发 NOT NULL，OR IGNORE 静默丢弃整行，
        //   而工具照样返回 `persisted: true`。**一条消息凭空消失且报告成功**，
        //   正是本 issue 要消灭的那个形状。
        //   DO NOTHING 只针对主键冲突，别的约束照常抛出、事务回滚。
        //
        //   另：普通 INSERT 会让重试抛主键冲突（无害重试变 500）；
        //   OR REPLACE 会覆盖旧行、把用户已 ack 的状态冲掉。都不取。
        db.run(
          `INSERT INTO user_inbox
             (message_id, network_id, user_id, from_session, kind, title, content, severity, meta_json, sender_user_id)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
           ON CONFLICT(message_id) DO NOTHING`,
          [
            messageId,
            effectiveNetId ?? null,
            target.user_id,
            from_session,
            // 🔴 不依赖 zod 的 .default()：直接调用 handler 的调用方（测试、
            //    未来的内部调用）拿不到 zod 默认值，会把 NULL 写进 NOT NULL 列。
            //    列上虽有 DEFAULT，但**显式传 NULL 会覆盖列默认值**。
            kind ?? "agent_message",
            title || null,
            message,
            severity ?? "info",
            // 存储侧走与 inbox 一致的跨主机脱敏；读取侧另有一道 token 形状
            // 脱敏（规格 ③ redact-at-read），两层分别防不同的东西。
            meta && typeof meta === "object" ? normalizeMetaJson(meta) : null,
            // 多用户私信:只有人(用户令牌)发的才记发信人 user_id;节点令牌发的是 Agent 消息。
            !callerTokenIsNetwork && enforceUserId ? enforceUserId : null,
          ],
        );
      });
      // #1459 / #1563 — pushUserEvent 在没有订阅者时静默 return。
      // 🔴 这段注释原先写「本工具既不写 inbox、也没有 user 级回读路径 ⇒ dashboard
      //    关着时消息永久没了」。**那半句已经不成立** —— 上面 20 行就在
      //    `INSERT INTO user_inbox`，且 `/api/messages?scope=user` 能回读
      //    （desktop-message-seam.test.ts 有真实 send → 真实 GET 的端到端断言）。
      //    留着它会把 debug 未读数的人直接带向错误的一层。
      //
      // 这里先把**丢失变可见**：`ok` 仍表示「请求被接受、审计已落库」，
      // 新增 `delivered` 表示「此刻真的有人收到」。判据取自订阅者注册表，
      // 不是猜的。持久化 + 重连补投是另一条（按 user_id 寻址的新收件表，#1459）。
      //
      // 🔴 `reason` 报的是**观测到的事实**（此刻没有活订阅者），不是它的后果。
      //    今天「没有活订阅者」确实等于「丢了」，但持久化落地之后同一个事实会
      //    变成「已入库、等重连补投」。把值取成 no_live_subscriber 而不是
      //    "lost"/"dropped"，就是为了那天不用改写历史含义 —— 届时按需细分
      //    （如 lost vs queued）即可，现在不预先把语义焊死。
      // 🔴 push 必须在事务**提交之后**：放进事务里的话，活订阅者可能先收到
      //    事件、而行还没提交；一旦回滚，用户就看到了一条数据库里不存在的消息。
      const delivered = hasUserSubscribers(effectiveNetId, target.user_id);
      pushUserEvent(effectiveNetId, target.user_id, event);

      return { content: [{ type: "text" as const, text: JSON.stringify({
        ok: true,
        message_id: messageId,
        delivered,
        // #1459 ① P2 —— 有了持久化之后，「此刻没人在听」不再等于「丢了」。
        // `delivered` 说的是实时投递、`persisted` 说的是它已经入库等重连补投。
        // `reason` 仍报**观测到的事实**而不是它的后果，所以这个中间态没有说错话。
        persisted: true,
        ...(delivered ? {} : { reason: "no_live_subscriber" }),
        delivered_to_user_id: target.user_id,
        network_id: effectiveNetId,
      }) }] };
    },
  );

  server.tool(
    "broadcast",
    "Send a message to multiple sessions.",
    {
      message: z.string().min(1).max(10000),
      filter_server: z.string().max(200).optional(),
      filter_status: z.string().max(50).optional(),
      network_id: z.string().max(200).optional().describe("Broadcast within a specific network"),
    },
    async ({ message, filter_server, filter_status, network_id: netId }) => {
      const effectiveNetId = getNetworkId(netId);
      if (!canWrite(effectiveNetId)) return writeDeniedReply(effectiveNetId);
      console.log(`[${ts()}] hub → broadcast: ${message.slice(0, 60)}${effectiveNetId ? " [net=" + effectiveNetId.slice(0, 12) + "]" : ""}`);
      let sql = "SELECT alias, node_id, network_id FROM sessions WHERE alias IS NOT NULL";
      const params: any[] = [];
      sql = addScope(sql, params, effectiveNetId);
      if (filter_server) { sql += " AND server = ?"; params.push(filter_server); }
      if (filter_status) { sql += " AND status = ?"; params.push(filter_status); }

      const targets = db.all<{ alias: string; node_id: string | null; network_id: string | null }>(sql, ...params);
      const ids: string[] = [];
      // #1440 ① — the push loop must walk the recipients that actually
      // got an inbox row, not every candidate target. Walking `targets`
      // announced a broadcast to nodes the lifecycle guard had just
      // skipped, i.e. nodes with nothing to fetch.
      const delivered: Array<{ alias: string; netId: string | null }> = [];

      for (const t of targets) {
        // RFC-027 §2.3 inbox-enqueue lifecycle guard (PR1.1 site 6/6).
        // Broadcast skips non-active recipients silently rather than
        // failing the entire send — broadcast semantics are best-effort
        // per-recipient and a stopped node simply gets nothing.
        const netId = effectiveNetId ?? t.network_id ?? null;
        const lc = assertNodeActive(t.alias, netId);
        if (!lc.ok) continue;
        const id = uuidv4();
        db.run(
          `INSERT INTO inbox (id, session_name, node_id, type, priority, content, from_session, network_id)
           VALUES (?1, ?2, ?3, 'broadcast', 'normal', ?4, 'hub', ?5)`,
          [id, t.alias, t.node_id ?? null, message, netId]
        );
        ids.push(id);
        delivered.push({ alias: t.alias, netId });
      }

      for (const d of delivered) {
        pushEvent(d.alias, { type: "broadcast", inbox_count: pendingInboxCount(d.alias, d.netId) }, d.netId);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: true, recipients: ids.length, message_ids: ids }),
          },
        ],
      };
    }
  );

  server.tool(
    "get_completions",
    "Get recent task completions.",
    {
      since: z.string().optional().describe("ISO 8601 datetime, default last 24h"),
      alias: z.string().max(200).optional().describe("Filter by session alias"),
      network_id: z.string().max(200).optional().describe("Filter by network"),
      limit: z.number().min(1).max(500).optional().default(50),
    },
    async ({ since, alias, network_id: netId, limit }) => {
      const readScope = resolveReadScope(netId);
      if (readScope.denied) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: readScope.denied }) }] };
      console.log(`[${ts()}] hub → get_completions${alias ? ": " + alias : ""}`);
      const cutoff = since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      let sql = "SELECT * FROM completions WHERE completed_at >= ?1";
      const params: any[] = [cutoff];
      sql = addReadScope(sql, params, readScope);

      if (alias) {
        sql += ` AND session_name = ?${params.length + 1}`;
        params.push(alias);
      }

      const paramIdx = params.length + 1;
      sql += ` ORDER BY completed_at DESC LIMIT ?${paramIdx}`;
      params.push(limit);

      const rows = db.all(sql, ...params);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: true, completions: rows }) }],
      };
    }
  );

  // ──────────────────────────────────────────────────────────────────
  // RFC-024 (2026-06-28) — node config-apply MCP tools.
  //
  // Three contract tools (update / get / ack) + one lifecycle tool
  // (restart_node, Vincent 2026-06-28 increment). All four enforce
  // SEC-1 (network-scoped, never trust upstream dashboard routing —
  // every tool re-checks caller→token→network. Mirrors the #275
  // cross-tenant write防护带 pattern). update_node_config additionally
  // enforces SEC-2 — security-sensitive flags (permissionMode,
  // dangerouslySkipPermissions, teammateMode) are fail-CLOSED pending
  // Vincent's policy decision (see SECURITY_SENSITIVE_FLAGS below).
  //
  // See docs/rfcs/RFC-024-dashboard-node-config-apply.md for the
  // contract + sequence diagrams + guards.
  // ──────────────────────────────────────────────────────────────────

  // Helpers — ALLOWED_FLAGS, SECURITY_SENSITIVE_FLAGS, computeApplyMode,
  // validatePatch, isAllowedToChangeFlag live in
  // ./config-apply-validate.ts so the contract is unit-testable without
  // standing up an MCP server.

  /**
   * Resolve the node row that update_node_config / restart_node targets.
   * Returns the row + the SEC-1 verdict (network match against caller).
   * Network mismatch is the cross-tenant write防护带 from #275 — every
   * tool re-checks this even if dashboard already did, because curl
   * can talk directly to /mcp.
   */
  const resolveTargetNode = (
    nodeId: string,
    callerNetworkId: string | null,
  ): { row: any | null; sec1Ok: boolean } => {
    const row = db.get<any>(
      "SELECT node_id, alias, network_id, config_revision, config_snapshot FROM nodes WHERE node_id = ?1",
      nodeId,
    );
    if (!row) return { row: null, sec1Ok: false };
    // Use the same null/undefined → "default" normalization as the
    // report_status upsert guard (norm() helper) — `||` would also
    // coerce `""` to "default", which is unreachable in the V3 model
    // today but better aligned to avoid drift if any future migration
    // ever introduces empty-string network_ids. Single source of
    // truth: nullish-only.
    const nodeNet = row.network_id === null || row.network_id === undefined ? "default" : row.network_id;
    const callerNet = callerNetworkId === null || callerNetworkId === undefined ? "default" : callerNetworkId;
    return { row, sec1Ok: nodeNet === callerNet };
  };

  server.tool(
    "update_node_config",
    "Set the desired per-node config (model + flags) and push a doorbell to the node. The node pulls + validates + applies (hot or restart per field tier). RFC-024.",
    {
      ...NODE_ID_ALIAS_FIELDS,
      base_revision: z.number().int().min(0).describe("Current revision per the dashboard's last GET — 409 if hub's current revision differs."),
      patch: z.object({
        model: z.string().max(200).optional(),
        flags: z.record(z.string(), z.unknown()).optional(),
        // #260 P5 — channel enable/disable. Restart-tier field (agent-node
        // reads config.channels once at boot to fork per-channel workers,
        // so the swap takes effect via process restart). Not
        // SECURITY_SENSITIVE — this is a lifecycle op, gated by SEC-1
        // (network scope) only.
        //
        // Deliberately `z.array(z.unknown()).max(16)` (mirrors flags's
        // `z.record(z.string(), z.unknown())`): trust nothing at the wire boundary,
        // narrow the same way `narrowChannelsPatch` narrows raw untrusted
        // JSON (typeof + allowlist + dedup + case-fold). A strict
        // `z.array(z.string())` would fail-fast on a single non-string
        // entry, but the wire contract wants junk silently dropped so a
        // dashboard fat-finger doesn't turn into a 400 the user has to
        // interpret. validatePatch then re-rejects if the caller bypassed
        // narrowing.
        channels: z.array(z.unknown()).max(16).optional(),
      }).describe("Fields to update. Empty patch → no-op (use restart_node for that)."),
      network_id: z.string().max(200).optional(),
    },
    async ({ node_id, child_node_id, base_revision: baseRev, patch, network_id: clientNetId }) => {
      const idArg = resolveNodeIdArg({ node_id, child_node_id });
      if (!idArg.ok) return { content: [{ type: "text" as const, text: JSON.stringify(idArg) }] };
      const nodeId = idArg.node_id;
      const effectiveNetId = getNetworkId(clientNetId);
      if (!canWrite(effectiveNetId)) return writeDeniedReply(effectiveNetId, "write");

      const { row: node, sec1Ok } = resolveTargetNode(nodeId, effectiveNetId);
      if (!node) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "node_not_found", node_id: nodeId }) }] };
      }
      if (!sec1Ok) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "cross_network_node", message: "node belongs to another network" }) }] };
      }

      const model = typeof patch.model === "string" ? patch.model : undefined;
      const flags = (patch.flags && typeof patch.flags === "object") ? patch.flags as Record<string, unknown> : {};
      // Narrow untrusted `channels` at the boundary (typeof + allowlist +
      // dedup + case-fold), and distinguish two very different cases
      // that both narrow to `[]`:
      //   (a) `patch.channels === []` (explicit "disable all editable
      //       channels"). Downstream must proceed and write channels=[]
      //       so the node's next restart forks no workers.
      //   (b) `patch.channels === ["commhub"]` or similar — the caller
      //       sent items but every single one was invalid (dashboard PR
      //       #31 still ships commhub, and a typo like "telegarm" would
      //       hit the same path). Downstream MUST NOT treat this as
      //       (a) — silently converting to disable-all would nuke the
      //       user's existing telegram/feishu workers.
      //
      // The reject error is `channels_all_invalid` so the dashboard
      // can surface the mismatch instead of showing a false success.
      let channels: string[] | undefined = undefined;
      if (patch.channels !== undefined) {
        if (!Array.isArray(patch.channels)) {
          // Zod already permits arrays only; belt+braces if it drifts.
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "invalid_patch", field: "channels", reason: "must be an array" }) }],
          };
        }
        const narrowed = narrowChannelsPatch(patch.channels) ?? [];
        if (patch.channels.length === 0) {
          channels = []; // (a) explicit disable-all
        } else if (narrowed.length === 0) {
          // (b) every entry was invalid — refuse to write. Distinct
          // error so the dashboard can surface the failure.
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                ok: false,
                error: "channels_all_invalid",
                requested: patch.channels,
                message: "every requested channel is unknown or unsupported; use an explicit empty array to disable-all",
              }),
            }],
          };
        } else {
          channels = narrowed;
        }
      }

      // SEC-2 (final policy 2026-06-28) — security-sensitive flags
      // (permissionMode / dangerouslySkipPermissions / teammateMode)
      // require admin role on this network. Other flags fall through
      // to per-field validation. hub-side enforced (dashboard's UI
      // gate is not trusted; curl direct to /mcp is the attack
      // vector). See isAllowedToChangeFlag for the policy details.
      const callerRole = enforceUserId && effectiveNetId
        ? getUserNetworkRole(enforceUserId, effectiveNetId)
        : null;
      const secCheck = isAllowedToChangeFlag(callerRole, flags);
      if (secCheck) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              ok: false,
              error: "insufficient_role_for_security_flag",
              field: secCheck.field,
              required_role: "admin",  // or owner — both satisfy
              message: secCheck.reason,
            }),
          }],
        };
      }

      const validationFail = validatePatch(model, flags, channels);
      if (validationFail) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              ok: false,
              error: "invalid_patch",
              field: validationFail.field,
              reason: validationFail.reason,
            }),
          }],
        };
      }

      // Revision conflict.
      if ((node.config_revision || 0) !== baseRev) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              ok: false,
              error: "revision_conflict",
              current_revision: node.config_revision || 0,
              base_revision: baseRev,
            }),
          }],
        };
      }

      // F-B (CHANGE_REQ): single-flight with stale-update reaper.
      // Without TTL, a node that ack'd "restarting" then crashed (lost
      // power, OOM, killed) leaves a non-terminal row forever — every
      // subsequent update_node_config / restart_node returns
      // update_in_flight and the node is admin-bricked.
      //
      // Stale threshold = 60_000 ms (2× the §8-confirmed 30s apply ceiling,
      // chosen so a slow-but-alive node within its own deadline never
      // false-positives as stale). Stale rows are marked timeout +
      // superseded by the new update.
      //
      // Age anchor = COALESCE(acked_at, created_at) per 通信龙 polish:
      // a healthy-but-slow restart (drain 60s + respawn time) could
      // exceed the threshold if anchored on created_at alone (drain
      // cap and reaper threshold are both 60s — overlap). Anchoring
      // on acked_at means a node that ack'd "restarting" refreshes
      // the liveness clock, so an in-progress restart isn't falsely
      // reaped.
      const STALE_THRESHOLD_MS = 60_000;
      const inFlight = db.get<{ update_id: string; created_at: number; acked_at: number | null }>(
        "SELECT update_id, created_at, acked_at FROM node_config_updates WHERE node_id = ?1 AND status IN ('pending', 'restarting') ORDER BY created_at DESC LIMIT 1",
        nodeId,
      );
      if (inFlight) {
        const ageAnchor = inFlight.acked_at ?? inFlight.created_at;
        const age = Date.now() - ageAnchor;
        if (age <= STALE_THRESHOLD_MS) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                ok: false,
                error: "update_in_flight",
                existing_update_id: inFlight.update_id,
                age_ms: age,
              }),
            }],
          };
        }
        // Stale — supersede.
        db.run(
          "UPDATE node_config_updates SET status = 'timeout', acked_at = ?1, error = ?2 WHERE update_id = ?3",
          [Date.now(), `superseded by new update after ${age}ms stale (> ${STALE_THRESHOLD_MS}ms threshold)`, inFlight.update_id],
        );
      }

      // Compute apply_mode + persist + push doorbell.
      const updateId = `cu_${uuidv4()}`;
      const applyMode = computeApplyMode(model, flags, channels);
      const patchJson = JSON.stringify({
        ...(model !== undefined ? { model } : {}),
        flags,
        ...(channels !== undefined ? { channels } : {}),
      });
      const networkId = node.network_id || "default";
      db.run(
        `INSERT INTO node_config_updates (update_id, node_id, network_id, patch_json, apply_mode, base_revision, status, created_at, created_by_token) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?8)`,
        [updateId, nodeId, networkId, patchJson, applyMode, baseRev, Date.now(), callerTokenId || "unknown"],
      );

      pushEvent(node.alias, { type: "config_update", update_id: updateId }, networkId);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ ok: true, update_id: updateId, apply_mode: applyMode }),
        }],
      };
    },
  );

  // One alias can own several `nodes` rows in a network: re-creating a node
  // under the same alias leaves the old row behind, and `db.get` on
  // `WHERE alias = ? AND network_id = ?` then returns whichever row SQLite
  // happens to yield first. A field report showed the result: the client
  // queued a rules-file read for the live node, the node pulled with its own
  // token, the hub resolved its alias to the stale row, found nothing pending
  // and returned `request: null` until the read timed out.
  //
  // resolveNodeByAlias: prefer the row the alias's session points at (sessions
  // are UNIQUE per network+alias and carry the node_id that last reported),
  // then the newest row. Used where only an alias is known (a client targeting
  // by alias; unbound legacy node tokens).
  const resolveNodeByAlias = (alias: string, networkId: string) =>
    db.get<{ node_id: string; alias: string; network_id: string | null }>(
      `SELECT n.node_id, n.alias, n.network_id FROM nodes n
         LEFT JOIN sessions s ON s.alias = n.alias AND s.network_id = n.network_id AND s.node_id = n.node_id
        WHERE n.alias = ?1 AND n.network_id = ?2
        ORDER BY (s.node_id IS NOT NULL) DESC, n.created_at DESC, n.rowid DESC
        LIMIT 1`,
      alias,
      networkId,
    ) ?? null;
  // resolveCallerNode: the node a network token pulls/acks for. A token bound
  // to a node resolves to exactly that node (and never to another row that
  // shares its alias); only unbound legacy tokens fall back to the alias.
  // Callers have already required callerTokenIsNetwork + enforceNetworkId +
  // callerAlias.
  const resolveCallerNode = (): { node_id: string; network_id: string | null } | null => {
    const bound = callerTokenId
      ? db.get<{ bound_node_id: string | null }>(
          "SELECT bound_node_id FROM api_tokens WHERE token_id = ?1 AND network_id = ?2",
          callerTokenId,
          enforceNetworkId,
        )?.bound_node_id ?? null
      : null;
    if (bound) {
      return db.get<{ node_id: string; network_id: string | null }>(
        "SELECT node_id, network_id FROM nodes WHERE node_id = ?1 AND network_id = ?2",
        bound,
        enforceNetworkId,
      ) ?? null;
    }
    return resolveNodeByAlias(callerAlias!, enforceNetworkId!);
  };

  server.tool(
    "get_config_update",
    "Node pulls its pending config update (called from agent-node when SSE config_update doorbell arrives). RFC-024.",
    {},
    async () => {
      // F-A (CHANGE_REQ): require ntok_ + non-null enforceNetworkId.
      // Mirror report_status's guard (tools.ts:251-253) — utok_ has
      // enforceNetworkId=null and callerAlias=username, so without
      // this gate a utok_ whose username happens to match a node alias
      // could pull that node's pending update across network scope
      // (network filter would be silently dropped, since old code had
      // a conditional WHERE). Hub doesn't trust upstream gates — every
      // node-private tool must independently require a network-bound
      // token.
      if (!callerTokenIsNetwork || !enforceNetworkId) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "network_token_required" }) }] };
      }
      if (!callerAlias) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "alias_required" }) }] };
      }
      // Unconditional network_id filter (was previously conditional on
      // enforceNetworkId being set; the new ntok guard above guarantees
      // it's non-null so the filter is always applied).
      const node = resolveCallerNode();
      if (!node) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, update: null }) }] };
      }
      const update = db.get<any>(
        "SELECT update_id, patch_json, apply_mode, base_revision FROM node_config_updates WHERE node_id = ?1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
        node.node_id,
      );
      if (!update) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, update: null }) }] };
      }
      let patch: any = {};
      try { patch = JSON.parse(update.patch_json); } catch { patch = {}; }
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            ok: true,
            update: {
              update_id: update.update_id,
              patch,
              apply_mode: update.apply_mode,
              base_revision: update.base_revision,
            },
          }),
        }],
      };
    },
  );

  server.tool(
    "ack_config_update",
    "Node acknowledges a config update — applied / rejected / restarting / timeout. RFC-024.",
    {
      update_id: z.string().min(1).max(200),
      status: z.enum(["applied", "rejected", "restarting", "timeout"]),
      new_revision: z.number().int().min(0).optional(),
      error: z.string().max(2000).optional(),
    },
    async ({ update_id: updateId, status, new_revision: newRev, error: ackError }) => {
      // F-A (CHANGE_REQ): same ntok_ guard as get_config_update. Without
      // this, a utok_ whose username matches a node alias could ack
      // arbitrary updates within the alias-collision; the new ntok guard
      // closes that.
      if (!callerTokenIsNetwork || !enforceNetworkId) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "network_token_required" }) }] };
      }
      if (!callerAlias) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "alias_required" }) }] };
      }
      // Cross-tenant guard: the ack-er must own the update being acked.
      // Resolve node by caller's alias under the enforced network.
      // Network filter is unconditional (guard above guarantees non-null).
      const node = resolveCallerNode();
      if (!node) {
        // Silently ignore stale ack — return ok so the node doesn't retry forever.
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, ignored: "alias_unknown" }) }] };
      }
      const update = db.get<any>(
        "SELECT update_id, node_id, status FROM node_config_updates WHERE update_id = ?1",
        updateId,
      );
      if (!update || update.node_id !== node.node_id) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, ignored: "unknown_or_foreign_update" }) }] };
      }
      // Reject ack for already-terminal updates (idempotency).
      if (update.status === "applied" || update.status === "rejected" || update.status === "timeout") {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, ignored: "already_terminal", current_status: update.status }) }] };
      }

      const ackedAt = Date.now();
      if (status === "applied") {
        // Promote the node's config_revision to the new revision, atomically.
        const nextRev = (typeof newRev === "number" && newRev > 0) ? newRev : ((db.get<{ config_revision: number }>("SELECT config_revision FROM nodes WHERE node_id = ?1", node.node_id)?.config_revision || 0) + 1);
        db.run(
          `UPDATE node_config_updates SET status = 'applied', acked_at = ?1, new_revision = ?2 WHERE update_id = ?3`,
          [ackedAt, nextRev, updateId],
        );
        db.run(`UPDATE nodes SET config_revision = ?1 WHERE node_id = ?2`, [nextRev, node.node_id]);
      } else {
        db.run(
          `UPDATE node_config_updates SET status = ?1, acked_at = ?2, error = ?3 WHERE update_id = ?4`,
          [status, ackedAt, ackError || null, updateId],
        );
      }
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, status }) }] };
    },
  );

  // ── app#225 — 节点规则文件（AGENTS.md / CLAUDE.md）远程读写 ──
  //
  // 形状照抄 RFC-024 config-apply：客户端调 read_node_rules_file /
  // write_node_rules_file 落一行 node_rules_requests + 门铃 {type:"rules_file"}；
  // 节点收到门铃后 get_rules_file_request 拉（和 get_config_update 同一道
  // F-A 闸：网络 token + alias），做完 ack_rules_file_request 回报；客户端
  // 轮询 get_rules_file_result。
  //
  // 🔴 安全（#225 验收第 5 条）：整条链路**没有路径参数**。文件名由节点按
  // 自己的 RUNTIME 决定（claude → CLAUDE.md，其余 → AGENTS.md），目录固定是
  // 节点进程的 cwd（agent-node/src/runtime/rules-file.ts）。hub 只传 op +
  // content，客户端连文件名都指定不了，所以不存在「借路径参数写任意文件」。
  // 读和写都要 canWrite：规则文件是节点行为的一部分，读它等于读节点配置。
  const RULES_FILE_MAX_BYTES = 256 * 1024;
  const RULES_REQUEST_STALE_MS = 60_000;

  // Node skills view — skills_list / skill_read ride the same queue + doorbell.
  // `content` carries the skill NAME for skill_read (never a path; the node
  // validates it again against [A-Za-z0-9._-] and resolves it under its own
  // runtime's skills roots — node-skills.ts).
  const SKILL_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
  const isSkillsOp = (op: string) => op === "skills_list" || op === "skill_read";

  // Project folder view — files_list / file_read ride the same queue + doorbell.
  // `content` carries a path RELATIVE to the node's work dir. The hub refuses
  // absolute paths, `..` segments, backslashes and NUL before any row exists;
  // the node re-validates, realpath-contains the result in its work dir and
  // refuses secret-looking files (node-files.ts). Stricter than skills on the
  // caller: a node token may not browse another node's disk, and only the token
  // that asked can read the answer.
  const NODE_FILE_PATH_MAX = 1024;
  const NODE_FILES_RESULT_MAX_CHARS = 1024 * 1024;
  const isFilesOp = (op: string) => op === "files_list" || op === "file_read";
  const normalizeNodeRelPath = (raw: unknown): string | null => {
    if (raw === undefined || raw === null) return "";
    if (typeof raw !== "string" || raw.length > NODE_FILE_PATH_MAX) return null;
    if (raw.includes("\0") || raw.includes("\\")) return null;
    if (raw.startsWith("/") || raw.startsWith("~") || /^[A-Za-z]:/.test(raw)) return null;
    const segs = raw.split("/").filter((s) => s !== "" && s !== ".");
    if (segs.some((s) => s === "..")) return null;
    return segs.join("/");
  };

  // Node run-log view — logs_tail rides the same queue + doorbell. `content`
  // carries the filter parameters as JSON (lines / level / grep / since_ts) and
  // never a path: the node reads only its own log directory and redacts before
  // it answers (agent-node/src/runtime/node-logs.ts). Stricter than the project
  // folder on the caller: user login only, and only the node's owner or a
  // network owner/admin — a member who may chat with a node does not get to read
  // its process log. Log bytes are purged on the first terminal read (see
  // get_rules_file_result) and by the retention sweep after LOGS_CONTENT_TTL_MS.
  const isLogsOp = (op: string) => op === "logs_tail";
  const LOGS_MAX_LINES = 2000;
  const LOGS_GREP_MAX = 200;
  const logsParamsJson = (p: { lines?: number; level?: string; grep?: string; since_ts?: number }): string =>
    JSON.stringify({
      lines: Math.min(Math.max(Math.floor(p.lines ?? 500), 1), LOGS_MAX_LINES),
      ...(p.level ? { level: p.level } : {}),
      ...(p.grep ? { grep: p.grep.slice(0, LOGS_GREP_MAX) } : {}),
      ...(typeof p.since_ts === "number" && p.since_ts > 0 ? { since_ts: p.since_ts } : {}),
    });
  // Owner of the node row, or owner/admin of the network. Legacy open mode (no
  // user identity on the connection) keeps canWrite's allow-all semantics.
  const canReadNodeLogs = (nodeId: string, networkId: string): boolean => {
    if (!enforceUserId) return true;
    const role = getUserNetworkRole(enforceUserId, networkId);
    if (role === "owner" || role === "admin") return true;
    if (nodeId.startsWith("session:")) return false;
    const row = db.get<{ owner_user_id: string | null }>("SELECT owner_user_id FROM nodes WHERE node_id = ?1", nodeId);
    return !!row?.owner_user_id && row.owner_user_id === enforceUserId;
  };

  const enqueueRulesFileRequest = (
    op: "read" | "write" | "skills_list" | "skill_read" | "files_list" | "file_read" | "logs_tail",
    a: { node_id?: string; child_node_id?: string; alias?: string; network_id?: string; content?: string },
  ) => {
    const effectiveNetId = getNetworkId(a.network_id);
    if (isLogsOp(op) && callerTokenIsNetwork) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "node_token_cannot_read_logs", message: "a node token cannot read another node's run log; use a user login" }) }] };
    }
    if (isFilesOp(op)) {
      if (callerTokenIsNetwork) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "node_token_cannot_browse_files", message: "a node token cannot browse another node's project folder; use a user login" }) }] };
      }
      if (!canWrite(effectiveNetId)) return writeDeniedReply(effectiveNetId, `${op} node files`);
      const rel = normalizeNodeRelPath(a.content);
      if (rel === null || (op === "file_read" && rel === "")) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "invalid_path", reason: "path must be relative to the node work dir: no leading / or ~, no .. segment, no backslash or NUL, at most 1024 chars" }) }] };
      }
      a = { ...a, content: rel };
    }
    if (!canWrite(effectiveNetId)) return writeDeniedReply(effectiveNetId, isLogsOp(op) ? "read node logs" : isSkillsOp(op) ? `${op} node skills` : `${op} rules file`);
    if (op === "skill_read" && (typeof a.content !== "string" || !SKILL_NAME_RE.test(a.content) || a.content === "." || a.content === "..")) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "invalid_skill_name", reason: "name must match [A-Za-z0-9._-]{1,64} and not be . or .." }) }] };
    }

    // Target: a `nodes` row by node_id (original path), or — app#225 follow-up —
    // an alias. An alias resolves to its `nodes` row when there is one; otherwise
    // to a live session in the caller's network that advertised
    // rules_file_capable (claude-code sessions mostly have no `nodes` row). The
    // queue key for such a session is `session:<alias>`, network-scoped.
    let node: { node_id: string; alias: string; network_id: string | null } | null = null;
    if (a.node_id || a.child_node_id || !a.alias) {
      const idArg = resolveNodeIdArg({ node_id: a.node_id, child_node_id: a.child_node_id });
      if (!idArg.ok) return { content: [{ type: "text" as const, text: JSON.stringify(idArg) }] };
      const nodeId = idArg.node_id;
      const resolved = resolveTargetNode(nodeId, effectiveNetId);
      if (!resolved.row) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "node_not_found", node_id: nodeId }) }] };
      }
      if (!resolved.sec1Ok) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "cross_network_node", message: "node belongs to another network" }) }] };
      }
      node = resolved.row as any;
    } else {
      const scopeNet = effectiveNetId || "default";
      const byAlias = resolveNodeByAlias(a.alias, scopeNet);
      if (byAlias) {
        node = byAlias;
      } else {
        const session = db.get<{ alias: string; network_id: string | null }>(
          isLogsOp(op)
            ? "SELECT alias, network_id FROM sessions WHERE alias = ?1 AND network_id = ?2 AND logs_capable = 1 ORDER BY updated_at DESC LIMIT 1"
            : isFilesOp(op)
            ? "SELECT alias, network_id FROM sessions WHERE alias = ?1 AND network_id = ?2 AND files_capable = 1 ORDER BY updated_at DESC LIMIT 1"
            : isSkillsOp(op)
            ? "SELECT alias, network_id FROM sessions WHERE alias = ?1 AND network_id = ?2 AND skills_capable = 1 ORDER BY updated_at DESC LIMIT 1"
            : "SELECT alias, network_id FROM sessions WHERE alias = ?1 AND network_id = ?2 AND rules_file_capable = 1 ORDER BY updated_at DESC LIMIT 1",
          a.alias,
          scopeNet,
        );
        if (!session) {
          if (isLogsOp(op)) {
            return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "logs_target_not_found", alias: a.alias, message: "no node with this alias in the network, and no session with this alias that can serve its run log (its agent-node may be too old)" }) }] };
          }
          if (isFilesOp(op)) {
            return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "files_target_not_found", alias: a.alias, message: "no node with this alias in the network, and no session with this alias that can serve its project folder (its channel server may be too old)" }) }] };
          }
          return isSkillsOp(op)
            ? { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "skills_target_not_found", alias: a.alias, message: "no node with this alias in the network, and no session with this alias that can serve its skills (its channel server may be too old)" }) }] }
            : { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "rules_file_target_not_found", alias: a.alias, message: "no node with this alias in the network, and no session with this alias that can serve rules files (its channel server may be too old)" }) }] };
        }
        node = { node_id: `session:${session.alias}`, alias: session.alias, network_id: session.network_id };
      }
    }
    const nodeId = node.node_id;
    if (isLogsOp(op) && !canReadNodeLogs(nodeId, node.network_id || "default")) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "logs_permission_denied", message: "only the node's owner or a network owner/admin can read its run log" }) }] };
    }
    if (op === "write") {
      if (typeof a.content !== "string") {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "invalid_content", reason: "content must be a string" }) }] };
      }
      const bytes = Buffer.byteLength(a.content, "utf8");
      if (bytes > RULES_FILE_MAX_BYTES) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "content_too_large", bytes, max_bytes: RULES_FILE_MAX_BYTES }) }] };
      }
    }

    // 单飞 + 陈旧回收，同 update_node_config 的 F-B：节点掉线时旧行永远
    // 非终态，不回收就把这个节点锁死。
    // Separate single-flight lanes: the client opens the rules file and the
    // skills list together; one must not block the other.
    const inFlight = db.get<{ request_id: string; created_at: number; pulled_at: number | null }>(
      isLogsOp(op)
        ? "SELECT request_id, created_at, pulled_at FROM node_rules_requests WHERE node_id = ?1 AND status IN ('pending', 'in_progress') AND op = 'logs_tail' ORDER BY created_at DESC LIMIT 1"
        : isFilesOp(op)
        ? "SELECT request_id, created_at, pulled_at FROM node_rules_requests WHERE node_id = ?1 AND status IN ('pending', 'in_progress') AND op IN ('files_list', 'file_read') ORDER BY created_at DESC LIMIT 1"
        : isSkillsOp(op)
        ? "SELECT request_id, created_at, pulled_at FROM node_rules_requests WHERE node_id = ?1 AND status IN ('pending', 'in_progress') AND op IN ('skills_list', 'skill_read') ORDER BY created_at DESC LIMIT 1"
        : "SELECT request_id, created_at, pulled_at FROM node_rules_requests WHERE node_id = ?1 AND status IN ('pending', 'in_progress') AND op IN ('read', 'write') ORDER BY created_at DESC LIMIT 1",
      nodeId,
    );
    if (inFlight) {
      const age = Date.now() - (inFlight.pulled_at ?? inFlight.created_at);
      if (age <= RULES_REQUEST_STALE_MS) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "request_in_flight", existing_request_id: inFlight.request_id, age_ms: age }) }] };
      }
      db.run(
        "UPDATE node_rules_requests SET status = 'timeout', acked_at = ?1, error = ?2 WHERE request_id = ?3",
        [Date.now(), `superseded after ${age}ms (> ${RULES_REQUEST_STALE_MS}ms) — node did not answer`, inFlight.request_id],
      );
    }

    // Opportunistic content retention (bounded, indexed) — node-request-retention.ts.
    sweepNodeRequestContent();
    const requestId = `rf_${uuidv4()}`;
    const networkId = node.network_id || "default";
    db.run(
      `INSERT INTO node_rules_requests (request_id, node_id, network_id, op, content, status, created_at, created_by_token) VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7)`,
      [requestId, nodeId, networkId, op, op === "write" || op === "skill_read" || isFilesOp(op) || isLogsOp(op) ? a.content! : null, Date.now(), callerTokenId || "unknown"],
    );
    pushEvent(node.alias, { type: "rules_file", request_id: requestId }, networkId);
    return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, request_id: requestId, op }) }] };
  };

  server.tool(
    "read_node_rules_file",
    "Ask a node to send back its rules file (CLAUDE.md for claude nodes, AGENTS.md otherwise) from its working directory. No path argument by design. Poll get_rules_file_result with the returned request_id. app#225.",
    {
      ...NODE_ID_ALIAS_FIELDS,
      alias: z.string().min(1).max(200).optional().describe("Alias instead of node_id (a node, or a session reporting rules_file_capable)."),
      network_id: z.string().max(200).optional(),
    },
    async ({ node_id, child_node_id, alias, network_id }) => enqueueRulesFileRequest("read", { node_id, child_node_id, alias, network_id }),
  );

  server.tool(
    "write_node_rules_file",
    "Ask a node to overwrite its rules file (CLAUDE.md for claude nodes, AGENTS.md otherwise) in its working directory with `content`. No path argument by design. Poll get_rules_file_result with the returned request_id. app#225.",
    {
      ...NODE_ID_ALIAS_FIELDS,
      alias: z.string().min(1).max(200).optional().describe("Alias instead of node_id (a node, or a session reporting rules_file_capable)."),
      content: z.string().max(RULES_FILE_MAX_BYTES).describe("Full new file content (UTF-8). The node writes it atomically."),
      network_id: z.string().max(200).optional(),
    },
    async ({ node_id, child_node_id, alias, content, network_id }) => enqueueRulesFileRequest("write", { node_id, child_node_id, alias, content, network_id }),
  );

  server.tool(
    "list_node_skills",
    "Ask a node to list the skills its runtime loads (name, scope project|user|system, display path, frontmatter description). Read-only; no path argument. Poll get_rules_file_result — content is JSON {skills:[…]}.",
    {
      ...NODE_ID_ALIAS_FIELDS,
      alias: z.string().min(1).max(200).optional().describe("Alias instead of node_id (a node, or a session reporting skills_capable)."),
      network_id: z.string().max(200).optional(),
    },
    async ({ node_id, child_node_id, alias, network_id }) => enqueueRulesFileRequest("skills_list", { node_id, child_node_id, alias, network_id }),
  );

  server.tool(
    "read_node_skill",
    "Ask a node for one skill's SKILL.md by name. Read-only; the node resolves the name under its own runtime's skills roots — no path argument. Poll get_rules_file_result — content is JSON {name, scope, path_rel, description, content}.",
    {
      ...NODE_ID_ALIAS_FIELDS,
      alias: z.string().min(1).max(200).optional().describe("Alias instead of node_id (a node, or a session reporting skills_capable)."),
      name: z.string().min(1).max(64).describe("Skill directory name, [A-Za-z0-9._-]."),
      network_id: z.string().max(200).optional(),
    },
    async ({ node_id, child_node_id, alias, name, network_id }) => enqueueRulesFileRequest("skill_read", { node_id, child_node_id, alias, content: name, network_id }),
  );

  server.tool(
    "list_node_files",
    "Ask a node to list one directory level of its work dir (project folder view, read-only). `path` is relative to the work dir (default: the root); absolute paths and .. are refused. Poll get_rules_file_result — content is JSON {path, entries:[{name,type,size?,mtime?,hidden_reason?,no_descend?}], truncated, total}. User logins only.",
    {
      ...NODE_ID_ALIAS_FIELDS,
      alias: z.string().min(1).max(200).optional().describe("Alias instead of node_id (a node, or a session reporting files_capable)."),
      path: z.string().max(NODE_FILE_PATH_MAX).optional().describe("Directory relative to the node's work dir; omit or \"\" for the root."),
      network_id: z.string().max(200).optional(),
    },
    async ({ node_id, child_node_id, alias, path: relPath, network_id }) => enqueueRulesFileRequest("files_list", { node_id, child_node_id, alias, content: relPath ?? "", network_id }),
  );

  server.tool(
    "read_node_file",
    "Ask a node for one text file under its work dir (project folder view, read-only, 256 KiB cap; binary / too large → size only; secret-looking files → name only). `path` is relative to the work dir. Poll get_rules_file_result — content is JSON {path, name, kind, size?, mtime?, content?, hidden_reason?}. User logins only.",
    {
      ...NODE_ID_ALIAS_FIELDS,
      alias: z.string().min(1).max(200).optional().describe("Alias instead of node_id (a node, or a session reporting files_capable)."),
      path: z.string().min(1).max(NODE_FILE_PATH_MAX).describe("File path relative to the node's work dir."),
      network_id: z.string().max(200).optional(),
    },
    async ({ node_id, child_node_id, alias, path: relPath, network_id }) => enqueueRulesFileRequest("file_read", { node_id, child_node_id, alias, content: relPath, network_id }),
  );

  server.tool(
    "tail_node_logs",
    "Ask a node for the tail of its own agent-node run log (read-only, redacted on the node before it leaves). No path argument: the node reads only its own log directory. User logins only; the node's owner or a network owner/admin. Poll get_rules_file_result — content is JSON {files, lines:[{ts, level, text, key}], truncated, matched, now_ts}; it is handed out once and then purged.",
    {
      ...NODE_ID_ALIAS_FIELDS,
      alias: z.string().min(1).max(200).optional().describe("Alias instead of node_id (a node, or a session reporting logs_capable)."),
      lines: z.number().int().min(1).max(LOGS_MAX_LINES).optional().describe("How many of the newest matching lines (default 500, max 2000)."),
      level: z.enum(["info", "warn", "error"]).optional().describe("Only lines of exactly this level."),
      grep: z.string().min(1).max(LOGS_GREP_MAX).optional().describe("Case-insensitive substring, matched after redaction."),
      since_ts: z.number().int().min(0).optional().describe("Only lines at or after this epoch-ms timestamp (follow mode; the client de-duplicates by line key)."),
      network_id: z.string().max(200).optional(),
    },
    async ({ node_id, child_node_id, alias, lines, level, grep, since_ts, network_id }) =>
      enqueueRulesFileRequest("logs_tail", { node_id, child_node_id, alias, content: logsParamsJson({ lines, level, grep, since_ts }), network_id }),
  );

  server.tool(
    "get_rules_file_request",
    "Node pulls its oldest pending rules-file request (called from agent-node when the SSE rules_file doorbell arrives). app#225.",
    {},
    async () => {
      // 同 get_config_update 的 F-A 闸：必须是网络 token + alias。
      if (!callerTokenIsNetwork || !enforceNetworkId) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "network_token_required" }) }] };
      }
      if (!callerAlias) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "alias_required" }) }] };
      }
      const node = resolveCallerNode();
      // app#225 follow-up — no `nodes` row: this is a session-only target
      // (claude-code). Its queue key is `session:<alias>`, always paired with the
      // caller's network so a same-named alias in another network never matches.
      const queueKey: string = node ? node.node_id : `session:${callerAlias}`;
      const req = db.get<any>(
        "SELECT request_id, op, content FROM node_rules_requests WHERE node_id = ?1 AND network_id = ?2 AND status = 'pending' ORDER BY created_at ASC LIMIT 1",
        queueKey,
        enforceNetworkId,
      );
      if (!req) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, request: null }) }] };
      }
      db.run(
        "UPDATE node_rules_requests SET status = 'in_progress', pulled_at = ?1 WHERE request_id = ?2 AND status = 'pending'",
        [Date.now(), req.request_id],
      );
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            ok: true,
            request: {
              request_id: req.request_id,
              op: req.op,
              ...(req.op === "write" || req.op === "skill_read" || isFilesOp(req.op) || isLogsOp(req.op) ? { content: req.content ?? "" } : {}),
            },
          }),
        }],
      };
    },
  );

  server.tool(
    "ack_rules_file_request",
    "Node reports the outcome of a rules-file request — done (with content for reads) or failed (with error). app#225.",
    {
      request_id: z.string().min(1).max(200),
      status: z.enum(["done", "failed"]),
      file_name: z.string().max(64).optional(),
      exists: z.boolean().optional(),
      // Files results (JSON listing / a 256 KiB file, escaped) may exceed the rules
      // cap; the per-op cap is enforced below once the row's op is known.
      content: z.string().max(NODE_FILES_RESULT_MAX_CHARS).optional(),
      error: z.string().max(2000).optional(),
    },
    async ({ request_id: requestId, status, file_name: fileName, exists, content, error: ackError }) => {
      if (!callerTokenIsNetwork || !enforceNetworkId) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "network_token_required" }) }] };
      }
      if (!callerAlias) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "alias_required" }) }] };
      }
      const node = resolveCallerNode();
      const queueKey: string = node ? node.node_id : `session:${callerAlias}`;
      const req = db.get<any>(
        "SELECT request_id, node_id, network_id, status, op FROM node_rules_requests WHERE request_id = ?1",
        requestId,
      );
      // 跨租户闸：只能 ack 自己的请求；别人的当不存在处理。session 键另外核网络。
      if (!req || req.node_id !== queueKey || req.network_id !== enforceNetworkId) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, ignored: "unknown_or_foreign_request" }) }] };
      }
      if (req.status === "done" || req.status === "failed" || req.status === "timeout") {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, ignored: "already_terminal", current_status: req.status }) }] };
      }
      if (typeof content === "string" && !isFilesOp(req.op) && !isLogsOp(req.op) && content.length > RULES_FILE_MAX_BYTES) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "content_too_large", max: RULES_FILE_MAX_BYTES }) }] };
      }
      db.run(
        `UPDATE node_rules_requests SET status = ?1, acked_at = ?2, file_name = ?3, file_exists = ?4, result_content = ?5, error = ?6 WHERE request_id = ?7`,
        [
          status,
          Date.now(),
          fileName ?? null,
          typeof exists === "boolean" ? (exists ? 1 : 0) : null,
          status === "done" ? (content ?? null) : null,
          status === "failed" ? (ackError || "node reported failure without a reason") : null,
          requestId,
        ],
      );
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, request_id: requestId, status }) }] };
    },
  );

  server.tool(
    "get_rules_file_result",
    "Poll the outcome of a read_node_rules_file / write_node_rules_file request. Returns status pending|in_progress|done|failed|timeout, the file name the node used, and (for reads) the content. app#225.",
    { request_id: z.string().min(1).max(200), network_id: z.string().max(200).optional() },
    async ({ request_id: requestId, network_id: clientNetId }) => {
      const effectiveNetId = getNetworkId(clientNetId);
      if (!canWrite(effectiveNetId)) return writeDeniedReply(effectiveNetId, "read rules file result");
      const row = db.get<any>(
        "SELECT request_id, node_id, network_id, op, status, file_name, file_exists, result_content, error, created_at, pulled_at, acked_at, created_by_token FROM node_rules_requests WHERE request_id = ?1",
        requestId,
      );
      // SEC-1：结果行的网络必须等于调用方作用域，否则当不存在。
      // Project folder results: only the (user) token that asked may read them.
      // Run-log results: same rule — only the token that asked.
      const foreignFilesRow = !!row && (isFilesOp(row.op) || isLogsOp(row.op)) && (callerTokenIsNetwork || row.created_by_token !== (callerTokenId || "unknown"));
      if (!row || row.network_id !== (effectiveNetId || "default") || foreignFilesRow) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "request_not_found", request_id: requestId }) }] };
      }
      let status: string = row.status;
      const ageMs = Date.now() - (row.pulled_at ?? row.created_at);
      if ((status === "pending" || status === "in_progress") && ageMs > RULES_REQUEST_STALE_MS) {
        status = "timeout";
        db.run(
          "UPDATE node_rules_requests SET status = 'timeout', acked_at = ?1, error = ?2 WHERE request_id = ?3 AND status IN ('pending', 'in_progress')",
          [Date.now(), `node did not answer within ${RULES_REQUEST_STALE_MS}ms (offline, or running an agent-node without app#225 support)`, requestId],
        );
        row.error = `node did not answer within ${RULES_REQUEST_STALE_MS}ms (offline, or running an agent-node without app#225 support)`;
      }
      // Privacy: node file bytes are handed out for a short grace window after the
      // first terminal read, then purged (node-request-retention.ts). Only reached
      // after the SEC-1 scope check above — a foreign caller can't stamp/purge.
      const terminal = status === "done" || status === "failed" || status === "timeout";
      const purged = terminal ? noteTerminalResultRead(requestId).purged : false;
      // Run-log bytes are read-once: purge them in the same call that hands them
      // out (no grace window — the app never follows someone else's logs request,
      // it re-asks; see node-request-retention.ts).
      if (terminal && isLogsOp(row.op) && !purged) purgeLogsResultNow(requestId);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            ok: true,
            request_id: row.request_id,
            node_id: row.node_id,
            op: row.op,
            status,
            file_name: row.file_name ?? null,
            exists: row.file_exists === null || row.file_exists === undefined ? null : row.file_exists === 1,
            ...(status === "done" && row.op !== "write" && !purged ? { content: row.result_content ?? "" } : {}),
            ...(purged ? { content_purged: true } : {}),
            error: row.error ?? null,
            age_ms: ageMs,
          }),
        }],
      };
    },
  );


  server.tool(
    "restart_node",
    "Trigger a node restart without changing config. RFC-024 Vincent 2026-06-28 increment. Network-scoped (SEC-1); member+ role suffices (lifecycle ops are not privilege elevation).",
    {
      ...NODE_ID_ALIAS_FIELDS,
      network_id: z.string().max(200).optional(),
    },
    async ({ node_id, child_node_id, network_id: clientNetId }) => {
      const idArg = resolveNodeIdArg({ node_id, child_node_id });
      if (!idArg.ok) return { content: [{ type: "text" as const, text: JSON.stringify(idArg) }] };
      const nodeId = idArg.node_id;
      const effectiveNetId = getNetworkId(clientNetId);
      if (!canWrite(effectiveNetId)) return writeDeniedReply(effectiveNetId, "write");

      const { row: node, sec1Ok } = resolveTargetNode(nodeId, effectiveNetId);
      if (!node) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "node_not_found", node_id: nodeId }) }] };
      }
      if (!sec1Ok) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "cross_network_node" }) }] };
      }
      // F-B reaper: same stale-supersede semantics as update_node_config,
      // with same acked_at-anchored liveness clock (see update_node_config
      // for the 通信龙 polish reasoning).
      const STALE_THRESHOLD_MS_R = 60_000;
      const inFlight = db.get<{ update_id: string; created_at: number; acked_at: number | null }>(
        "SELECT update_id, created_at, acked_at FROM node_config_updates WHERE node_id = ?1 AND status IN ('pending', 'restarting') ORDER BY created_at DESC LIMIT 1",
        nodeId,
      );
      if (inFlight) {
        const ageAnchor = inFlight.acked_at ?? inFlight.created_at;
        const age = Date.now() - ageAnchor;
        if (age <= STALE_THRESHOLD_MS_R) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "update_in_flight", existing_update_id: inFlight.update_id, age_ms: age }) }] };
        }
        db.run(
          "UPDATE node_config_updates SET status = 'timeout', acked_at = ?1, error = ?2 WHERE update_id = ?3",
          [Date.now(), `superseded by restart_node after ${age}ms stale`, inFlight.update_id],
        );
      }
      const updateId = `cu_${uuidv4()}`;
      const networkId = node.network_id || "default";
      // RFC-027 PR1.2a latent fix (#346 ack): restart_node must reset
      // lifecycle_state to 'active'. Otherwise a node that was previously
      // stop_node'd → 'stopped' would, after restart, stay marked
      // 'stopped' in the nodes table → the 6 MCP + 2 REST inbox guards
      // would refuse every routing attempt → node silently unreachable
      // (no error to operator, just no traffic). Pair the schema flip
      // with the config_updates INSERT inside one tx so we don't
      // half-commit if the dispatch INSERT throws.
      db.transaction(() => {
        db.run(
          `INSERT INTO node_config_updates (update_id, node_id, network_id, patch_json, apply_mode, base_revision, status, created_at, created_by_token) VALUES (?1, ?2, ?3, '{}', 'restart_only', ?4, 'pending', ?5, ?6)`,
          [updateId, nodeId, networkId, node.config_revision || 0, Date.now(), callerTokenId || "unknown"],
        );
        db.run(
          `UPDATE nodes SET lifecycle_state = 'active' WHERE node_id = ?1`,
          [nodeId],
        );
      });
      pushEvent(node.alias, { type: "restart", update_id: updateId }, networkId);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: true, update_id: updateId, apply_mode: "restart_only" }) }],
      };
    },
  );

  // ── RFC-026 P1 — create-node + host-daemon (3 MCP tools) ──────────
  // Background timers (GC + sweeper) are idempotent + cheap; safe to
  // call on every registerTools invocation (statless mode re-registers
  // per request). They unref themselves so don't hold the event loop.
  startPendingEnvGcTimer();
  startSweeperTimer();

  // §4.1.4 C2 — caller daemon resolved via token-bound identity (NOT
  // alias). Thin closure over the module-level helper so callers in
  // this scope can use the captured request-level vars. The pure
  // helper lives in create-node.ts so unit tests call exactly the
  // same code path the tools do (per 通信龙 PR #299 nit 1 — no inline-
  // mirror SQL in tests).
  const resolveCallerDaemonTokenBound = () =>
    _resolveCallerDaemonTokenBound({ callerTokenIsNetwork, callerTokenId, enforceNetworkId });

  // Helper — map a ValidationError thrown from create-node-validate
  // into the MCP-tool-call JSON reply shape.
  const validationFailReply = (e: unknown) => {
    if (e instanceof ValidationError) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: e.code, ...(e.detail || {}) }) }] };
    }
    throw e;
  };

  // RFC-026 §9.2.1 / #338 PR2 — list_host_supervisors.
  // Surfaces host_supervisor daemons in the caller's network with
  // online flag + declared capabilities. Replaces the prior `node_daemon_`
  // prefix heuristic (dashboard /api/anet/node-create) + the role-extract
  // path on /api/nodes (#337). Member脱敏 strips host_telemetry IP /
  // cpu / mem (per RFC-026 §6 #3 — daemons can leak internal topology
  // to non-admin readers). Revoked daemon ntoks filtered out via
  // join on api_tokens.revoked_at.
  server.tool(
    "list_host_supervisors",
    "List host_supervisor daemon nodes in the caller's network (online status + runtimes_supported + allowed_secret_keys + telemetry; member-脱敏). RFC-026 §9.2.1.",
    {
      network_id: z.string().max(200).optional(),
    },
    async ({ network_id: clientNetId }) => {
      // SEC-1 — use resolveReadScope, NOT getNetworkId. getNetworkId is
      // for write-tool helpers and pairs with `canWrite`; READ tools that
      // bypass canWrite and trust getNetworkId leak across tenants
      // (PR2 v1 BLOCKER per 通信龙 audit — utok_ caller with
      // enforceNetworkId=null could pass any network_id and read daemon
      // names + allowed_secret_keys for tenants they're not a member of).
      // resolveReadScope checks network_members for the user + denies
      // on non-membership, mirroring REST resolveRestNetworkScope.
      const readScope = resolveReadScope(clientNetId);
      if (readScope.denied) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: readScope.denied }) }] };
      }
      // Caller role for 脱敏 decision (admin/owner = full, others = masked).
      // Use the resolved scope's networkId (the verified one), not the
      // unchecked clientNetId.
      const scopedNetId = readScope.networkId ?? null;
      const callerRole = enforceUserId && scopedNetId
        ? getUserNetworkRole(enforceUserId, scopedNetId)
        : null;
      // Network-bound tokens get full telemetry within their bound network
      // (already gate-locked by enforceNetworkId path of resolveReadScope).
      const isPrivileged = callerRole === "admin" || callerRole === "owner" || (!enforceUserId);

      // Pull candidate daemons. Active-token EXISTS subquery handles BOTH
      // revoked daemon ntoks (revoked_at set) AND DELETEd token rows
      // (the standard revokeToken path deletes the row, not flagging
      // revoked_at — PR2 v1 SHOULD-FIX per 通信龙 audit). EXISTS naturally
      // dedupes if a daemon ever had multiple tokens (e.g. rotation; nit ⚪).
      let sql = `
        SELECT
          n.node_id, n.alias, n.hostname, n.network_id,
          n.runtimes_supported, n.allowed_secret_keys,
          n.created_at, n.updated_at,
          s.last_seen_at AS session_last_seen,
          s.status AS session_status,
          s.cpu_cores AS session_cpu_cores,
          s.mem_total_gb AS session_mem_total_gb,
          s.ip AS session_ip,
          n.config_snapshot
        FROM nodes n
        LEFT JOIN sessions s ON s.alias = n.alias AND (s.network_id = n.network_id OR s.network_id IS NULL)
        WHERE EXISTS (
          SELECT 1 FROM api_tokens t
          WHERE t.network_id = n.network_id
            AND t.name = 'node:' || n.alias
            AND t.revoked_at IS NULL
        )
      `;
      const sqlParams: any[] = [];
      sql = addReadScope(sql, sqlParams, readScope, "n.network_id");
      sql += ` ORDER BY n.updated_at DESC`;
      const rows = db.all<Record<string, any>>(sql, ...sqlParams);

      // Filter to role=host_supervisor (read from config_snapshot;
      // schema-promoted columns runtimes_supported/allowed_secret_keys
      // are pre-extracted but role isn't a first-class column).
      const nowMs = Date.now();
      // 心跳周期是 3 分钟（agent-node/src/cli.ts 的 report_status 定时器），
      // 窗口必须大于它，否则每次心跳后的 60s~180s 之间必然抖成 offline
      // （通信评审牛 #1279 独审④）。取 5min，与仓内既有 stale 口径一致。
      const ONLINE_MS = 5 * 60_000;
      const daemons = rows
        .map(r => {
          let snapRole: string | null = null;
          if (r.config_snapshot) {
            try {
              const parsed = typeof r.config_snapshot === "string" ? JSON.parse(r.config_snapshot) : r.config_snapshot;
              snapRole = typeof parsed?.role === "string" ? parsed.role : null;
            } catch { /* malformed snapshot — role stays null */ }
          }
          return { row: r, role: snapRole };
        })
        .filter(({ role }) => role === "host_supervisor")
        .map(({ row: r }) => {
          // online = sessions.last_seen_at within ONLINE_MS
          let online = false;
          let lastSeenAt: string | null = null;
          if (r.session_last_seen) {
            lastSeenAt = r.session_last_seen;
            const t = parseDbTimestampMs(r.session_last_seen);
            if (!isNaN(t)) online = (nowMs - t) <= ONLINE_MS;
          }
          // Parse self-declare arrays (default to [] for pre-PR2 daemons)
          let runtimes: string[] = [];
          let secrets: string[] = [];
          try {
            if (r.runtimes_supported) {
              const parsed = JSON.parse(r.runtimes_supported);
              runtimes = Array.isArray(parsed) ? parsed.filter((s: unknown) => typeof s === "string") : [];
            }
          } catch { /* malformed — empty */ }
          try {
            if (r.allowed_secret_keys) {
              const parsed = JSON.parse(r.allowed_secret_keys);
              secrets = Array.isArray(parsed) ? parsed.filter((s: unknown) => typeof s === "string") : [];
            }
          } catch { /* malformed — empty */ }
          // host_telemetry — member脱敏 drops IP/cpu/mem
          const telemetry: Record<string, unknown> = {
            alert_level: online ? "green" : "gray",
          };
          if (isPrivileged) {
            telemetry.cpu_cores = r.session_cpu_cores ?? null;
            telemetry.mem_gb = r.session_mem_total_gb ?? null;
            telemetry.ip_internal = r.session_ip ?? null;
          }
          // 工作目录默认根会暴露那台机器的家目录路径 —— 与 IP 同级,只给 admin/owner
          // (也只有他们能 create_node)。见 create-node-validate.ts daemonDefaultWorkdirRoot。
          const workdirRoot = isPrivileged ? daemonDefaultWorkdirRoot(r.config_snapshot) : null;
          return {
            daemon_node_id: r.node_id,
            alias: r.alias,
            hostname: r.hostname,
            online,
            last_seen_at: lastSeenAt,
            runtimes_supported: runtimes,
            allowed_secret_keys: secrets,
            host_telemetry: telemetry,
            ...(workdirRoot ? { default_workdir_root: workdirRoot } : {}),
          };
        });

      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, daemons, count: daemons.length }) }] };
    },
  );

  // §2.5 step 1+2 — dashboard-facing tool. Validates spec, mint
  // child-ntok, stash env_blob in pendingEnvBlobs Map, write request
  // row (metadata only — no env_blob in SQL), pushEvent doorbell.
  server.tool(
    "create_node",
    "Create a node on a host-daemon and start it. Daemon forks `anet node create + start` on the target machine; child reports back to hub. RFC-026.",
    {
      daemon_node_id: z.string().min(1).max(200),
      node_spec: z.object({
        name: z.string().min(1).max(64),
        runtime: z.string().min(1).max(64),
        model: z.string().min(1).max(100).optional().nullable(),
        flags: z.record(z.string(), z.unknown()).optional(),
        env_refs: z.array(z.string().max(64)).optional(),
        channels: z.array(z.unknown()).optional(),
        // app「新建节点」确认页的工作目录(绝对路径或 ~/…,daemon 侧展开并校验)。
        // 缺席 = 老行为:落 daemon 的 cwd。
        workdir: z.string().max(1024).optional().nullable(),
      }),
      network_id: z.string().max(200).optional(),
    },
    async ({ daemon_node_id, node_spec, network_id: clientNetId }) => {
      const effectiveNetId = getNetworkId(clientNetId);
      if (!canWrite(effectiveNetId)) return writeDeniedReply(effectiveNetId, "write");

      // §4.1.1 — admin+ for create_node (creating a node = pulling new
      // resource + burning API quota, one level above edit single flag)
      const callerRole = enforceUserId && effectiveNetId
        ? getUserNetworkRole(enforceUserId, effectiveNetId)
        : null;
      if (callerRole !== "admin" && callerRole !== "owner") {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "insufficient_role_for_create_node", required_role: "admin", caller_role: callerRole }) }] };
      }

      // Daemon must exist + must be in caller's network + must be
      // online with role=host_supervisor capability.
      const { row: daemon, sec1Ok } = resolveTargetNode(daemon_node_id, effectiveNetId);
      if (!daemon) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "daemon_not_found", daemon_node_id }) }] };
      }
      if (!sec1Ok) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "cross_network_node" }) }] };
      }

      // #1353 Fix ① — daemon self-declared "I can't create nodes right now"
      // is now a dispatch-time gate, not just a stored fact. Before this,
      // daemon reported `daemon_capabilities.can_create_nodes=false` (via
      // #1371 + #1377), hub stored it in config_snapshot, and then no
      // consumer read it — dispatch still returned `{ok:true, request_id}`
      // and pushed an SSE doorbell to the broken daemon. That's the exact
      // "在线但静默失败" case the issue title reports.
      //
      // Vincent's own 2026-08-28 comment on #1353 authorizes this shape:
      // "daemon 侧确知不可用时,hub 应当**拒绝派发**并返回可操作的错误,
      //  而不是发一个注定失败的 doorbell".
      //
      // 🔴 Pre-#1371 compat: a daemon that has NOT reported
      // `can_create_nodes` at all leaves the field UNDEFINED in the
      // snapshot. Do NOT fail-closed on undefined — that would silently
      // start rejecting every daemon on the old (preview.10 through .55
      // roughly) shape. Only `=== false` gates; `=== true` and `undefined`
      // both pass through (new-guard-matches-existing-stance).
      try {
        const snap = daemon.config_snapshot ? JSON.parse(daemon.config_snapshot) : null;
        const caps = snap?.daemon_capabilities;
        if (caps && caps.can_create_nodes === false) {
          const reason: string = (typeof caps.create_nodes_blocked_reason === "string"
            && caps.create_nodes_blocked_reason.length > 0)
            ? caps.create_nodes_blocked_reason
            : "anet_bin_unknown";
          // #1545 —— 光说 `blocked_reason` 不够:**那个判断是什么时候做出来的**
          // 决定了下一步完全不同的两件事。
          //   刚测的 blocked      ⇒ 去那台机器按 reason 修
          //   三周前测的 blocked  ⇒ 那台 daemon 是**开机算一次就永久缓存**的旧版本
          //                        (agent-node ≤ 2.5.0-preview.54),它可能早就好了 ——
          //                        先重启/升级它,再谈修 pin
          // 而在拒绝这一刻,用户正好在决定"去修哪台机器"。
          //
          // 🔴 年龄未知时给的是**显式 null + 一个说明为什么的枚举**,不是省略这两个键。
          //    省略读起来像"没有这个问题",而调用方(常常是个 agent)会默认它是刚测的
          //    —— 那是朝「更可信」方向撒谎,比不给更糟。
          const rawAge = caps.create_capability_observed_ms_ago;
          const reportedAgeOk = typeof rawAge === "number" && Number.isFinite(rawAge)
            && rawAge >= 0 && rawAge <= 365 * 24 * 60 * 60 * 1000;
          // 🔴 daemon 报的是「测完到**这份 report 发出**之间隔了多久」,不是「到现在」。
          //    两者差一个心跳间隔(3 分钟),而对一个已经失联的 daemon 差多少都可能。
          //    直接把它当成"多久以前测的"渲染,会**朝更新鲜的方向**低报 ——
          //    正是这一格要防的那个方向。所以在这里补上心跳那一段:
          //      绝对年龄 = (now − last_seen_at) + daemon 报的时长
          //    hub 的钟出绝对时间,daemon 只提供时长(它自己的钟偏移污染不了这个数)。
          //
          //    这是冷路径(只有被拒时才走),多一次小查询不影响心跳路径。
          let heartbeatAgeMs: number | null = null;
          try {
            const sess = db.get<{ last_seen_at: string | null }>(
              "SELECT last_seen_at FROM sessions WHERE node_id = ?1 ORDER BY last_seen_at DESC LIMIT 1",
              daemon_node_id,
            );
            // #1650 — 这一列是 TEXT(`datetime('now')`),UTC 但不带时区标记。
            //   Date.parse 会按**本机时区**解析,误差 = 主机偏移(生产 hub 在 UTC+8
            //   时这个诊断数字整整偏 8 小时)。走 parseHubTimestamp 显式按 UTC 解。
            const t = parseHubTimestamp(sess?.last_seen_at);
            if (t !== null) heartbeatAgeMs = Math.max(0, Date.now() - t);
          } catch { /* 取不到就是取不到 —— 下面如实说 unknown,不猜 0 */ }

          // 🔴 三种取值,不能塌成两种:
          //    known                      两半都有,可以给绝对年龄
          //    unknown_legacy_daemon      那台 daemon 根本没报这一格(旧版本)
          //    unknown_no_heartbeat_time  它报了,但 hub 这边没有可用的心跳时间
          //                               ⇒ **补不出绝对年龄**,而不是"年龄是 0"
          const ageKnown = reportedAgeOk && heartbeatAgeMs !== null;
          return { content: [{ type: "text" as const, text: JSON.stringify({
            ok: false,
            error: "daemon_cannot_create_nodes",
            blocked_reason: reason,
            // 到**现在**为止,这个判断做出来有多久了(毫秒)。null = 补不出来。
            capability_observed_ms_ago: ageKnown ? heartbeatAgeMs! + (rawAge as number) : null,
            capability_age: ageKnown
              ? "known"
              : (reportedAgeOk ? "unknown_no_heartbeat_time" : "unknown_legacy_daemon"),
            // 🔴 这里**不复制那张 code → 修法命令 的表**。它只有一个作者,在
            //    `@sleep2agi/agent-network` 的 daemon-capability-display —— 抄一份到 hub,
            //    两份就会各自漂移,而「hub 教的修法」和「CLI 教的修法」不一致时,
            //    没有任何东西会红。这里只把人指到那一份。
            //    (同 `blocked_reason` 是 z.enum 而不是自由文本的立场:hub 出**代码**,
            //     渲染留给客户端。)
            remediation_hint: "run `anet daemon list` where that daemon is configured — it prints the exact, paste-able fix command for this blocked_reason",
            daemon_node_id,
          }) }] };
        }
      } catch { /* malformed snapshot: permissive, mirrors L3230 fallthrough */ }

      // Read daemon's host_supervisor capability + allowlist from its
      // last reported config_snapshot. PR3 (#338) canonical path is
      // `daemon_capabilities.runtimes_supported` (RFC-026 §9.3).
      // Pre-PR3 daemons (preview.10 and earlier) place these at the
      // TOP level of the snapshot rather than nested — those reads
      // return undefined here and `daemonAllowedRuntimes` stays null
      // (permissive — no allowlist enforcement); they fall back to
      // §4.2.2 structural validation only, identical to pre-PR3
      // behavior. No regression on in-flight daemons.
      let daemonAllowList = new Set<string>();
      let daemonAllowedRuntimes: string[] | null = null;
      try {
        const snap = daemon.config_snapshot ? JSON.parse(daemon.config_snapshot) : null;
        const caps = snap?.daemon_capabilities;
        if (Array.isArray(caps?.allowed_secret_keys)) {
          daemonAllowList = new Set(caps.allowed_secret_keys);
        }
        if (Array.isArray(caps?.runtimes_supported)) {
          daemonAllowedRuntimes = caps.runtimes_supported;
        }
      } catch { /* permissive fallback */ }

      // §4.2.2 — structural validation (catches name/runtime/model/
      // flag injection at the hub edge). Daemon repeats this; double
      // layer per RFC §4.2.2.
      try {
        validateChildName(node_spec.name);
        validateRuntime(node_spec.runtime);
        validateModel(node_spec.model);
        validateChannelsP1((node_spec as any).channels);
        validateWorkdir(node_spec.workdir);
        for (const [k, v] of Object.entries(node_spec.flags || {})) {
          if (!(FLAG_KEYS as readonly string[]).includes(k)) throw new ValidationError("flag_key_unknown", { field: k });
          validateFlagValue(k, v);
        }
      } catch (e) {
        return validationFailReply(e);
      }
      // 🔴 老 daemon 会**静默忽略** node_spec.workdir,把节点建在它自己的 cwd 里 ——
      //    用户以为指定了目录,实际落到了别处(常常就是 $HOME)。所以没自报支持的 daemon
      //    直接拒,而不是派一个会被悄悄改写的请求。app 在这种 daemon 上本就不显示那一行。
      const requestedWorkdir = typeof node_spec.workdir === "string" ? node_spec.workdir.trim() : null;
      if (requestedWorkdir && !daemonDefaultWorkdirRoot(daemon.config_snapshot)) {
        return { content: [{ type: "text" as const, text: JSON.stringify({
          ok: false,
          error: "workdir_not_supported_by_daemon",
          hint: "this daemon's agent-node predates create-node workdir support; upgrade it, or omit workdir to use its current directory",
          daemon_node_id,
        }) }] };
      }

      // P1 daemon-side allowlist: if daemon publishes allowed_runtimes,
      // enforce at hub for fast-fail; daemon repeats.
      if (daemonAllowedRuntimes && !daemonAllowedRuntimes.includes(node_spec.runtime)) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "runtime_not_in_local_allowlist", runtime: node_spec.runtime, allowed: daemonAllowedRuntimes }) }] };
      }

      // §4.4.7 — env_refs strict (7-step gate) + resolve to env_blob.
      let envBlob: Record<string, string> = {};
      const envRefs = (node_spec as any).env_refs;
      try {
        envBlob = validateEnvRefs(envRefs, {
          callerNetworkId: effectiveNetId || "default",
          daemonAllowList,
          networkSecretsGet: (_net: string, _key: string) => undefined, // P1: no vault yet — see note below
        });
      } catch (e) {
        return validationFailReply(e);
      }
      // P1 NOTE — network_secrets vault is RFC §4.4 / §2.4 future
      // work. For now if dashboard sends env_refs we'll reject as
      // not-in-vault (above). When the vault lands, replace the
      // `networkSecretsGet: () => undefined` line with the real DB
      // lookup; nothing else in this tool needs to change.

      // Single-flight per (daemon, child_name): partial unique index
      // uniq_ncr_inflight already prevents racing INSERT, but we
      // surface a friendly error rather than letting the DB constraint
      // raise.
      const existing = db.get<{ request_id: string; status: string }>(
        `SELECT request_id, status FROM node_create_requests WHERE daemon_node_id = ?1 AND child_name = ?2 AND status IN ('pending', 'delivered') ORDER BY created_at DESC LIMIT 1`,
        daemon_node_id, node_spec.name,
      );
      if (existing) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "node_name_conflict", existing_request_id: existing.request_id, existing_status: existing.status }) }] };
      }

      // §4.2.4 — daemon_max_children backpressure (best-effort: count
      // currently-active children for this daemon).
      const maxChildren = (() => {
        try {
          const snap = daemon.config_snapshot ? JSON.parse(daemon.config_snapshot) : null;
          const m = snap?.daemon_capabilities?.max_concurrent_children;
          return (typeof m === "number" && m > 0) ? m : 20;
        } catch { return 20; }
      })();
      const childCount = db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM node_create_requests WHERE daemon_node_id = ?1 AND status IN ('pending', 'delivered', 'succeeded')`,
        daemon_node_id,
      )?.n || 0;
      if (childCount >= maxChildren) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "daemon_max_children", current: childCount, max: maxChildren }) }] };
      }

      // §2.5 step 2 + §4.4 F1 — mint child-ntok + stash env_blob in
      // Map (NOT in DB). Token row marked role='child' + request_id
      // for sweeper traceability per §4.4.8 impl note.
      const childToken = generateNetworkToken();
      const childTokenId = generateId("tok");
      const networkIdForChild = daemon.network_id || effectiveNetId || "default";
      const requestId = newRequestId();
      // Use the dashboard caller's user_id as the token's user_id so
      // resolveToken returns sane role / network on the child's side
      // (audit trail = whoever created it).
      if (!enforceUserId) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "auth_required" }) }] };
      }
      db.run(
        `INSERT INTO api_tokens (token_id, token_hash, user_id, network_id, name, scope, role, request_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
        [childTokenId, hashToken(childToken), enforceUserId, networkIdForChild, `node:${node_spec.name}`, "network", "child", requestId]
      );

      putPendingEnvBlob({
        request_id: requestId,
        daemon_node_id,
        env_blob: envBlob,
        child_token: childToken,
        child_token_id: childTokenId,
      });

      // Write metadata-only row. env_blob field deliberately ABSENT
      // from the schema (see db.ts CREATE TABLE) — F1 lock.
      const envKeys = Object.keys(envBlob);
      db.run(
        `INSERT INTO node_create_requests
           (request_id, daemon_node_id, child_name, network_id, runtime, model, flags_json, env_keys, status, child_token_id, created_at, created_by_token, workdir)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', ?9, ?10, ?11, ?12)`,
        [
          requestId, daemon_node_id, node_spec.name, networkIdForChild,
          node_spec.runtime, node_spec.model ?? null, JSON.stringify(node_spec.flags || {}),
          JSON.stringify(envKeys), childTokenId, Date.now(), callerTokenId || "unknown",
          requestedWorkdir,
        ],
      );

      // SSE doorbell — daemon will pull via get_create_request.
      // Payload carries ONLY request_id (no secret); daemon current
      // SSE handler resolves the rest via MCP call.
      pushEvent(daemon.alias, { type: "create_node", request_id: requestId }, networkIdForChild);

      // §4.5 audit — request queued and doorbell attempted. pushEvent is
      // fire-and-forget, so actual SSE delivery is intentionally not claimed.
      auditCreateNode({
        action: "create_node_dispatch_attempted",
        user_id: enforceUserId,
        network_id: networkIdForChild,
        target_id: requestId,
        detail: {
          daemon_node_id,
          child_name: node_spec.name,
          runtime: node_spec.runtime,
          model: node_spec.model ?? null,
          flag_keys: Object.keys(node_spec.flags || {}),
          env_keys: envKeys,
          workdir: requestedWorkdir,
        },
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: true, request_id: requestId }) }],
      };
    },
  );

  // #1362 — daemon-side compensation for missed SSE doorbells. pushEvent is
  // intentionally best-effort; after a daemon connects or reconnects, it pulls
  // any still-pending requests bound to its own daemon token.
  server.tool(
    "list_my_pending_create_requests",
    "Daemon lists pending create-node requests bound to itself for SSE reconnect compensation. RFC-026/#1362.",
    {},
    async () => {
      const callerDaemon = resolveCallerDaemonTokenBound();
      if (!callerDaemon.ok) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: callerDaemon.error }) }] };
      }
      const rows = db.all<{ request_id: string; child_name: string; created_at: number }>(
        `SELECT request_id, child_name, created_at
           FROM node_create_requests
          WHERE daemon_node_id = ?1
            AND network_id = ?2
            AND status = 'pending'
          ORDER BY created_at ASC`,
        callerDaemon.daemonNodeId, callerDaemon.networkId,
      );
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, count: rows.length, requests: rows }) }] };
    },
  );

  // #1448 — stop/delete/start 门铃的 SSE 重连补偿，镜像 create 的
  // list_my_pending_create_requests(#1394)。pushEvent(push.ts) 是纯内存
  // fan-out：派发门铃那刻若 daemon 无 live SSE 订阅者(hub 重启/网络抖/boot
  // 窗口)就静默丢弃、不入队，于是 node_stop_requests/node_start_requests 的行
  // 永远停在 pending、节点卡死 stopping/deleting/starting。daemon 每次 SSE
  // connected 调本工具把漏掉的门铃拉回来重放(reconcilePendingLifecycleRequestsOnConnect)。
  //
  // 统一一个工具返回两张表的 pending 行(stop 表用 action 区分 stop/delete)，
  // 省一次往返。鉴权同 create：token-bound daemon 身份(alias 不是安全边界)，
  // 只返回绑定到本 daemon + 本网络的 pending 行。
  server.tool(
    "list_my_pending_lifecycle_requests",
    "Daemon lists pending stop/delete/start requests bound to itself for SSE reconnect compensation. Mirrors list_my_pending_create_requests (#1394/#1448).",
    {},
    async () => {
      const callerDaemon = resolveCallerDaemonTokenBound();
      if (!callerDaemon.ok) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: callerDaemon.error }) }] };
      }
      const stop_requests = db.all<{ request_id: string; action: string; child_node_id: string; child_alias: string; created_at: number }>(
        `SELECT request_id, action, child_node_id, child_alias, created_at
           FROM node_stop_requests
          WHERE daemon_node_id = ?1
            AND network_id = ?2
            AND status = 'pending'
          ORDER BY created_at ASC`,
        callerDaemon.daemonNodeId, callerDaemon.networkId,
      );
      const start_requests = db.all<{ request_id: string; child_node_id: string; child_alias: string; created_at: number }>(
        `SELECT request_id, child_node_id, child_alias, created_at
           FROM node_start_requests
          WHERE daemon_node_id = ?1
            AND network_id = ?2
            AND status = 'pending'
          ORDER BY created_at ASC`,
        callerDaemon.daemonNodeId, callerDaemon.networkId,
      );
      return { content: [{ type: "text" as const, text: JSON.stringify({
        ok: true,
        stop_count: stop_requests.length,
        start_count: start_requests.length,
        stop_requests,
        start_requests,
      }) }] };
    },
  );

  // §2.5 step 3 — daemon-facing pull. Returns full spec + env_blob +
  // child_ntok in one shot. Map evicted on take (one-shot consume).
  //
  // §4.1.4 C2 token-bound daemon resolution (PR #299 BLOCKER #1, 通信牛):
  // We MUST resolve the caller daemon via token-bound identity, NOT
  // alias. alias is NOT a security boundary — two daemons with the same
  // alias in different networks (or attacker-named-itself-the-same)
  // would otherwise resolve to the wrong row. Same class as the prior
  // report_status cross-tenant re-home bug.
  //
  // Resolution chain: caller's ntok (callerTokenId + callerTokenIsNetwork)
  // → api_tokens row → joins to nodes via name='node:<alias>' AND
  // network_id matches → unique daemon node row scoped to caller's
  // network. If the ntok isn't bound to a node, or the joined node
  // isn't a host_supervisor, reject.
  server.tool(
    "get_create_request",
    "Daemon pulls a pending create-node request (called when SSE create_node doorbell arrives). RFC-026.",
    {
      request_id: z.string().min(1).max(200),
    },
    async ({ request_id }) => {
      const callerDaemon = resolveCallerDaemonTokenBound();
      if (!callerDaemon.ok) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: callerDaemon.error }) }] };
      }

      const row = db.get<{ request_id: string; daemon_node_id: string; status: string; child_token_id: string | null; network_id: string }>(
        `SELECT request_id, daemon_node_id, status, child_token_id, network_id FROM node_create_requests WHERE request_id = ?1`,
        request_id,
      );
      if (!row) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "request_not_found" }) }] };
      // §4.1.4 — strict daemon binding by token-derived node_id.
      if (row.daemon_node_id !== callerDaemon.daemonNodeId) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "not_your_request" }) }] };
      }
      // Additional network-scope guard (defense in depth: row's
      // network_id MUST equal caller's network).
      if (row.network_id !== callerDaemon.networkId) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "cross_network_request" }) }] };
      }
      if (row.status !== "pending") {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "request_not_pending", current_status: row.status }) }] };
      }

      // Take env_blob from Map; this is the one-shot consume per F1.
      // takePendingEnvBlob ALSO checks daemon binding (belt+braces).
      const blob = takePendingEnvBlob(request_id, callerDaemon.daemonNodeId);
      if (!blob) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "env_blob_unavailable" }) }] };
      }
      // Hydrate spec from row.
      const specRow = db.get<{ child_name: string; runtime: string; model: string | null; flags_json: string; workdir: string | null }>(
        `SELECT child_name, runtime, model, flags_json, workdir FROM node_create_requests WHERE request_id = ?1`,
        request_id,
      );
      if (!specRow) {
        // Should never happen given the earlier row read.
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "request_vanished" }) }] };
      }
      // Mark delivered (so sweeper distinguishes F-1 from F-2).
      db.run(
        `UPDATE node_create_requests SET status = 'delivered', delivered_at = ?1 WHERE request_id = ?2 AND status = 'pending'`,
        [Date.now(), request_id],
      );

      return {
        content: [{ type: "text" as const, text: JSON.stringify({
          ok: true,
          request_id,
          node_spec: {
            name: specRow.child_name,
            runtime: specRow.runtime,
            model: specRow.model,
            flags: JSON.parse(specRow.flags_json),
            channels: [],
            // 只在请求真带了时出现:老 daemon 看不到多余的键,新 daemon 缺席即走老布局。
            ...(specRow.workdir ? { workdir: specRow.workdir } : {}),
          },
          child_token: blob.child_token,
          env_blob: blob.env_blob,
        }) }],
      };
    },
  );

  // §2.5 step 4 — daemon reports outcome. Note: 'succeeded' is set
  // automatically by hub when the child first registers (content-match
  // in upsertNodeWithSec1Guard); daemon's ack here is for explicit
  // failures (fork crashed, etc.). Daemon should still call this on
  // success too — it's a useful idempotent confirmation + lets hub
  // record fork-side info.
  server.tool(
    "ack_create_request",
    "Daemon acks a create-node request (called after fork). status='started' | 'failed' | 'rejected' | 'runtime_capability_check_failed'. RFC-026 §9.3 D2.",
    {
      request_id: z.string().min(1).max(200),
      // RFC-026 §9.3 D2 — runtime_capability_check_failed signals the
      // daemon spawned the child OK but it died within FAIL_FAST_MS
      // (5s in agent-node v2.5.0-preview.11+), indicating a
      // declaration↔reality gap on this daemon's runtimes_supported.
      // Treated terminal like 'failed' but fires a distinct audit_log
      // action so dashboards can highlight "lying daemons" separately
      // from generic spawn failures.
      status: z.enum(["started", "failed", "rejected", "runtime_capability_check_failed"]),
      error: z.string().max(1000).optional(),
      child_pid: z.number().int().optional(),
      runtime: z.string().max(64).optional(),   // populated by daemon when status=runtime_capability_check_failed
    },
    async ({ request_id, status, error: ackError, child_pid: _pid, runtime: ackRuntime }) => {
      const callerDaemon = resolveCallerDaemonTokenBound();
      if (!callerDaemon.ok) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: callerDaemon.error }) }] };
      }
      const row = db.get<{ daemon_node_id: string; status: string; child_token_id: string | null; network_id: string }>(
        `SELECT daemon_node_id, status, child_token_id, network_id FROM node_create_requests WHERE request_id = ?1`,
        request_id,
      );
      if (!row) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "request_not_found" }) }] };
      if (row.daemon_node_id !== callerDaemon.daemonNodeId) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "not_your_request" }) }] };
      }
      if (row.network_id !== callerDaemon.networkId) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "cross_network_request" }) }] };
      }
      const ackedAt = Date.now();
      if (status === "started") {
        // Don't flip to 'succeeded' here — that happens via content-
        // match when the child actually registers. We just stamp ack.
        db.run(
          `UPDATE node_create_requests SET acked_at = ?1 WHERE request_id = ?2 AND status IN ('delivered', 'pending')`,
          [ackedAt, request_id],
        );
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, status: "awaiting_register" }) }] };
      }
      // failed / rejected / runtime_capability_check_failed — revoke
      // child-ntok + mark request terminal.
      if (row.child_token_id) {
        db.run(`UPDATE api_tokens SET revoked_at = datetime('now') WHERE token_id = ?1 AND revoked_at IS NULL`, [row.child_token_id]);
      }
      db.run(
        `UPDATE node_create_requests SET status = ?1, error = ?2, acked_at = ?3 WHERE request_id = ?4 AND status IN ('pending', 'delivered')`,
        [status, ackError || null, ackedAt, request_id],
      );
      // RFC-026 §9.3 D2 — surface declaration↔reality gap on a
      // distinct audit_log action so dashboards / operators can spot
      // chronically-lying daemons separate from generic spawn-failed.
      if (status === "runtime_capability_check_failed") {
        auditCreateNode({
          action: "daemon_capability_lied",
          user_id: null,
          network_id: row.network_id,
          target_id: request_id,
          detail: {
            daemon_node_id: row.daemon_node_id,
            runtime: ackRuntime || null,
            error: ackError ? ackError.slice(0, 500) : null,
            acked_at: ackedAt,
          },
        });
      }
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, status }) }] };
    },
  );

  // ─── RFC-027 §2 — stop/delete node lifecycle ───────────────────────
  //
  // Two user-facing MCP tools (stop_node, delete_node) + two daemon-
  // facing tools (get_stop_request, ack_stop_request). State machine
  // per §2.3 — nodes.lifecycle_state ∈ {active, stopping, stopped,
  // deleting}. row-gone implies deleted. Security per §4:
  //   §4.1 SEC-1: trust-root SQL join, not getNetworkId
  //   §4.2 D6:    delete_node refuses target.role==host_supervisor
  //   §4.3 D4:    in-flight inbox default-refuse + force+audit
  //   §4.4 D7:    daemon writes backup chmod 700, sweeper真删
  //   §4.5 D8:    audit_log in same SQLite tx as state UPDATE
  //
  // The dispatcher logic shared by stop_node + delete_node lives in
  // dispatchStopOrDelete; the two tool handlers thin-wrap it with
  // their respective action discriminator.
  type DispatchAction = "stop" | "delete";
  type DispatchArgs = {
    action: DispatchAction;
    child_node_id: string;
    daemon_node_id: string;
    force: boolean;
    grace_seconds: number;
    delete_config: boolean;
    confirm_alias?: string;
  };
  // RFC-027 PR2 prereq — auto-resolve daemon_node_id from child_node_id.
  // The dashboard (and most callers of stop_node / delete_node) shouldn't
  // need to track the daemon→child mapping themselves; the hub has it on
  // node_create_requests at child creation time. Returns null when no
  // creation record exists (orphan node row OR pre-RFC-026 node) — caller
  // must then pass daemon_node_id explicitly. node_id derivation:
  // `node_${request_id.replace(/^cr_/,"")}` (see create-node-daemon.ts
  // and PR1 BLOCKER-1 fix), so we reverse it: `cr_${node_id.slice(5)}`.
  const resolveDaemonForChild = (child_node_id: string): string | null => {
    if (!child_node_id.startsWith("node_")) return null;
    const requestId = `cr_${child_node_id.slice(5)}`;
    const row = db.get<{ daemon_node_id: string }>(
      `SELECT daemon_node_id FROM node_create_requests WHERE request_id = ?1`,
      requestId,
    );
    return row?.daemon_node_id ?? null;
  };

  /**
   * 为什么这里要分两种「解析不到 daemon」(#196 / app 仓)。
   *
   * `resolveDaemonForChild` 对两件完全不同的事都返回 `null`:
   *   ① id 不以 `node_` 开头 —— 这个节点**根本不是 daemon 创建的**,
   *      是有人在某台机器上直接 `anet node start` 起来的。hub 上没有任何
   *      daemon 可以代它执行停止,**这条路径对它在概念上就不成立**。
   *   ② id 以 `node_` 开头,但 `node_create_requests` 里查不到那一行 ——
   *      它可能确实是 daemon 建的,只是记录缺失,这时「显式传 daemon_node_id」
   *      是一条真的走得通的路。
   *
   * 🔴 原先两种情况打印同一句 `pass daemon_node_id explicitly`。对 ① 来说
   *    **这句建议的前提是假的** —— 没有 daemon 可传,用户按它做只会走进死路。
   *    2026-08-28 对生产 hub 实测:218 个节点里 **207 个**是 ① 这种。
   *
   * 信息在源头就存在(那个 `startsWith("node_")` 判断),只是被丢在了返回值里。
   */
  const explainUnresolvableDaemon = (child_node_id: string) =>
    child_node_id.startsWith("node_")
      ? {
          ok: false, error: "daemon_not_resolvable",
          message: "no node_create_requests row found for this child_node_id; pass daemon_node_id explicitly",
        }
      : {
          ok: false, error: "not_daemon_managed",
          message:
            `node ${child_node_id} was not created by a daemon (it was started by hand with ` +
            `\`anet node start\` on some machine), so no daemon on the Hub can stop it. ` +
            `Run \`anet node stop <alias>\` on that machine instead. ` +
            `Daemon-created children have ids beginning with \`node_\`; this one does not.`,
        };

  const dispatchStopOrDelete = (args: DispatchArgs, clientNetId?: string | null) => {
    // §4.1 — SEC-1 trust-root join: resolve target node row WITHIN the
    // caller's scope. resolveReadScope returns 'denied' if the caller
    // doesn't belong to clientNetId; for the row-existence test we
    // re-join with member's networks so an attacker can't probe by
    // node_id from a network they don't belong to.
    const scope = resolveReadScope(clientNetId);
    if (scope.denied) {
      return { ok: false, error: "forbidden_cross_tenant", message: scope.denied };
    }
    const nodeQ: any[] = [args.child_node_id];
    let nodeSql = `SELECT node_id, alias, network_id, lifecycle_state, config_snapshot, runtimes_supported
      FROM nodes WHERE node_id = ?1`;
    nodeSql = addReadScope(nodeSql, nodeQ, scope);
    const node = db.get<{
      node_id: string;
      alias: string;
      network_id: string;
      lifecycle_state: string | null;
      config_snapshot: string | null;
    }>(nodeSql, ...nodeQ);
    if (!node) return { ok: false, error: "forbidden_cross_tenant", message: "node not found in your networks" };

    // Caller must hold a write-capable role on the resolved network
    // (admin/owner/member; viewer denied). canWrite walks getUserNetworkRole.
    if (!canWrite(node.network_id)) {
      return { ok: false, error: "permission_denied", message: "viewer role cannot stop/delete nodes" };
    }

    // §4.2 D6 — delete refuses targets whose role is host_supervisor.
    // Stop is allowed against any node per RFC table (host_supervisor's
    // stop is functionally a no-op anyway: the daemon's children_map
    // only tracks its child nodes, never the daemon itself).
    //
    // PR1 SF-4 (#345 review) — fail-CLOSED on role read. The first cut
    // parsed config_snapshot and treated parse-fail / missing-field as
    // role=null which slipped through the gate. A daemon row with a
    // corrupt snapshot would then be deletable via delete_node. Fix:
    // - read role via two independent paths (snapshot.role + the
    //   indexed `runtimes_supported` column whose presence ≈ daemon)
    // - if EITHER path indicates host_supervisor → refuse
    // - if snapshot parsed but role missing AND the node has any
    //   daemon-shape evidence (non-null runtimes_supported column,
    //   present in any node_create_requests as daemon_node_id) →
    //   refuse defensively. The defense-in-depth daemon-side
    //   children_map miss is the second layer; the hub gate must
    //   itself fail-closed when role is ambiguous.
    if (args.action === "delete") {
      let role: string | null = null;
      let snapshotParseFailed = false;
      try {
        const snap = node.config_snapshot ? JSON.parse(node.config_snapshot) : null;
        role = typeof snap?.role === "string" ? snap.role : null;
      } catch { snapshotParseFailed = true; }
      const ambiguous = snapshotParseFailed || (role == null);
      // Independent corroborating check: nodes flagged as daemons by
      // create_node dispatchers will show up as daemon_node_id in
      // node_create_requests. Costs one indexed query.
      let looksLikeDaemon = false;
      if (ambiguous) {
        const m = db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM node_create_requests WHERE daemon_node_id = ?1`,
          node.node_id,
        );
        if ((m?.n ?? 0) > 0) looksLikeDaemon = true;
      }
      if (role === "host_supervisor" || (ambiguous && looksLikeDaemon)) {
        return {
          ok: false, error: "cannot_delete_daemon_via_delete_node",
          message: snapshotParseFailed
            ? "node config_snapshot unreadable; node is referenced as a daemon — refuse delete defensively (use delete_daemon path)"
            : "host_supervisor daemons must be removed via the dedicated delete_daemon path (RFC-027.5)",
        };
      }
    }

    // delete_node confirm_alias gate: dashboard's二次确认 input must
    // match the actual alias byte-for-byte. Hub rejects mismatched
    // input even if dashboard UI claims it's disabled.
    if (args.action === "delete") {
      if (typeof args.confirm_alias !== "string" || args.confirm_alias !== node.alias) {
        return { ok: false, error: "confirm_alias_mismatch", message: "confirm_alias must equal the node's alias" };
      }
    }

    // Daemon must exist + be in the same network. We do NOT enforce
    // daemon.role==host_supervisor here: a child whose creator daemon
    // got demoted should still be stoppable. The daemon will refuse
    // with noop_not_my_child if children_map doesn't know it.
    //
    // PR1.2 e2e catch (BLOCKER): pushEvent keys SSE by clientKey ≈
    // `${networkId}:${sessionName}`, and agent-node registers its SSE
    // connection under its ALIAS (not its node_id). The create_node
    // doorbell at line ~2197 correctly pushes via `daemon.alias`;
    // stop_node was pushing via `daemon_node_id` so every doorbell
    // missed every SSE client → daemon never woke up → request_id
    // stayed 'pending' forever → child never reaped. The 24 unit tests
    // in stop-delete-node.test.ts all mock pushEvent and inject the
    // post-doorbell handler call directly, so single-unit coverage
    // couldn't surface this — exactly the failure class 通信龙 said
    // the docker e2e gate exists to catch (BLOCKER-1 同源). Load the
    // alias along with node_id + network_id and dispatch to the alias.
    const daemon = db.get<{ node_id: string; alias: string; network_id: string }>(
      `SELECT node_id, alias, network_id FROM nodes WHERE node_id = ?1`, args.daemon_node_id,
    );
    if (!daemon) return { ok: false, error: "daemon_not_found" };
    if (daemon.network_id !== node.network_id) {
      // Cross-tenant child↔daemon mismatch shouldn't be possible in
      // normal flow but is a SEC-1 hardening — refuse loud.
      return { ok: false, error: "daemon_cross_tenant", message: "daemon and child are in different networks" };
    }

    // #1448 finding-4 — daemon 必须是该 child 的**权威创建者**,镜像 start_node 的
    // daemon_child_mismatch。此前 stop/delete 接受调用方传入的 daemon_node_id,只校验
    // 它存在 + 同网,不验它真的创建了这个 child。同网调用方传错 daemon_node_id → 门铃
    // 路由到错 daemon。🔴 f3(#1453) 合入后更糟:错 daemon 无该 child 的 map entry → 走
    // 收敛分支 sweep(错机器 pgrep 空) + ack stopped → hub 假收敛 stopped、child 仍在
    // 正确机器上跑(旧 noop 至少留下可见的卡死态)。网络 scope 只挡跨租户,网内是 footgun。
    //
    // 用「确定性不匹配」判据:authority 已知(child 有 create 记录)且不等 → 拒。不对
    // authority==null(create 记录被裁剪的旧 child)加拒,避免给它们的 stop/delete 引入
    // 新失败面——handler 的 daemon_node_id??resolveDaemonForChild 已兜住无法解析的情形。
    const authoritativeDaemonId = resolveDaemonForChild(args.child_node_id);
    if (authoritativeDaemonId && authoritativeDaemonId !== args.daemon_node_id) {
      return { ok: false, error: "daemon_child_mismatch", message: "daemon_node_id is not this child's authoritative creator daemon" };
    }

    // State machine gate.
    const state = node.lifecycle_state ?? "active";
    if (args.action === "stop" && state !== "active") {
      return { ok: false, error: state === "stopping" ? "node_already_stopping" : "node_not_active", current_state: state };
    }
    if (args.action === "delete" && state === "deleting") {
      // #1286 —— stale-deleting 重派出口。
      //
      // 在 .40 埋点修复之前,daemon 丢失 ack 会让行**永远**停在 deleting:
      // 重发 delete 被这里挡住,force=true 也一样 —— 状态机没有出口,
      // 2026-08-28 实测两行卡死(acc-…-3373 / probe-tl2),API 层面无解。
      //
      // 出口的三个条件,缺一不放行:
      //   ① 调用方显式 force=true(不改默认行为 —— 正常并发的重复 delete 仍被拒)
      //   ② 该 child 最近一条 delete 请求不是终态(pending/dispatched)
      //      —— 终态说明 daemon 刚 ack 过,行马上会转移,不该重派
      //   ③ 那条请求已经晾了超过 STALE_DELETING_MS —— 🔴 不是"刚派发就能 force":
      //      给正常的 doorbell→ack 往返留时间,否则 force 变成竞态放大器。
      const STALE_DELETING_MS = 5 * 60_000;
      const last = db.get<{ request_id: string; status: string; created_at: number }>(
        `SELECT request_id, status, created_at FROM node_stop_requests
          WHERE child_node_id = ?1 AND action = 'delete'
          ORDER BY created_at DESC LIMIT 1`, node.node_id,
      );
      const lastIsStale = !!last
        && (last.status === "pending" || last.status === "dispatched")
        && (Date.now() - last.created_at) > STALE_DELETING_MS;
      if (!(args.force === true && (lastIsStale || !last))) {
        return {
          ok: false, error: "node_already_deleting", current_state: state,
          // 🔴 告诉调用方出口在哪,而不是让他反复撞同一面墙。
          ...(last ? { last_request_id: last.request_id, last_request_status: last.status } : {}),
          hint: last && (last.status === "pending" || last.status === "dispatched")
            ? `再等一下;若超过 ${STALE_DELETING_MS / 60000} 分钟仍未收敛,带 force=true 重试可重新派发`
            : "上一条请求已终态,行应即将转移;稍后重查",
        };
      }
      // 放行:走正常派发路径,生成新 request_id。旧请求行保留(审计线索),
      // daemon 侧对未知 request 的 get_stop_request 会拿到 request_not_found,无副作用。
    }
    if (args.action === "delete" && state === "stopping") {
      // Can't start delete while a stop is mid-flight — race-prone.
      return { ok: false, error: "node_stopping_in_progress", current_state: state };
    }

    // §4.3 D4 — in-flight inbox check. Count unacked tasks routed to
    // this node's alias (inbox routing uses session_name == alias).
    // Default refuse with the count surfaced; force=true overrides
    // and triggers the forced_stop_with_in_flight audit row.
    // SF-5 (#345 review): legacy inbox rows may have network_id=NULL
    // and would silently miss a network_id=?2 strict equality match.
    // Use COALESCE so a NULL inbox row is counted against the same
    // network as the target node (which is the only safe default
    // — pre-multi-network rows existed in single-network mode).
    //
    // #2022 — "unacked" alone is not "in flight". Nothing acks a row
    // whose task already reached a terminal state (report_completion,
    // send_reply, send_ack, the TTL patrol all leave inbox alone) and
    // retention sweeps only acked=1 rows, so those rows were counted
    // forever: one dead row pinned this gate to node_busy_in_flight
    // and force=true was the only way past it.
    //
    // Counting rule (#2029 review): a row counts while it can still be
    // work this node is doing — and the age ceiling must NOT be applied
    // to a task row whose tasks row we can see. agent-node acks the
    // inbox row only once the task is done, so a 90-minute (or 3-hour,
    // or ttl_seconds>3600) task keeps acked=0 for its whole run;
    // capping it by age would open this gate mid-run, which is exactly
    // what the gate exists to prevent. So:
    //   1. type='task' row with a matching tasks row — LEFT JOIN on
    //      COALESCE(task_id, id), the key cancel_task / ack_inbox use
    //      (first deliveries set id == task_id; retry/reassign write a
    //      fresh transport id). Status alone decides: terminal
    //      (replied / failed / cancelled / expired) → not counted;
    //      anything else → counted, no age ceiling. Expiry belongs to
    //      patrolExpiredTasks, which now acks the inbox row in the same
    //      transaction, so an expired task leaves this count together
    //      with its rows.
    //   2. every other row — a task row whose tasks row is gone
    //      (reaped by retention, or a legacy row whose id resolves to
    //      nothing) and non-task rows (reply / broadcast / message):
    //      these carry no status of their own and nothing else will
    //      ever retire them, so they get the age ceiling
    //      IN_FLIGHT_MAX_AGE_MINUTES on inbox.created_at.
    // The count stays a per-alias inbox count: one PK join per row.
    const IN_FLIGHT_MAX_AGE_MINUTES = 60;
    const inFlightRow = db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM inbox i
         LEFT JOIN tasks t
           ON i.type = 'task'
          AND t.task_id = COALESCE(i.task_id, i.id)
        WHERE i.session_name = ?1 AND i.acked = 0
          AND COALESCE(i.network_id, ?2) = ?2
          AND ((t.task_id IS NOT NULL
                AND t.status NOT IN ('replied', 'failed', 'cancelled', 'expired'))
            OR (t.task_id IS NULL
                AND i.created_at >= datetime('now', ?3)))`,
      node.alias, node.network_id, `-${IN_FLIGHT_MAX_AGE_MINUTES} minutes`,
    );
    const inFlight = inFlightRow?.n ?? 0;
    if (inFlight > 0 && !args.force) {
      return { ok: false, error: "node_busy_in_flight", in_flight_count: inFlight, hint: "set force=true to override (audit logged)" };
    }

    // ── all gates passed; create request + transition state + push doorbell, transactionally ──
    const requestId = generateId("sr");
    const now = Date.now();
    const newState = args.action === "stop" ? "stopping" : "deleting";

    // #1448 finding-5 — 记下该 child **当前活着的** ntok 的 token_id,让 ack 精确按
    // token_id 撤销,而非按 name='node:<alias>' 广撤。后者会在「同 alias 节点在这次
    // delete 未收敛的窗口内被重建(拿到同名新 token)」时,把新 token 一并误撤。这里
    // 在派发时刻定住身份;若此刻没有活 token(异常),存 null,ack 退回按 name 撤(旧语义)。
    const childTokenRow = db.get<{ token_id: string }>(
      `SELECT token_id FROM api_tokens WHERE network_id = ?1 AND name = ?2 AND revoked_at IS NULL`,
      node.network_id, `node:${node.alias}`,
    );
    const childTokenId = childTokenRow?.token_id ?? null;

    // §4.5 D8 — lifecycle UPDATE + audit INSERTs + request INSERT atomic.
    // PR1.1: use db.transaction() (SQLiteAdapter wraps better-sqlite3's
    // native transaction; PgAdapter ships a real BEGIN/COMMIT/ROLLBACK
    // shim). Lets us drop the open-coded BEGIN/COMMIT + makes the
    // SF-2 failure-injection test (mock db.run throw inside callback)
    // reliable across both backends.
    try {
      db.transaction(() => {
      db.run(
        `INSERT INTO node_stop_requests
           (request_id, network_id, daemon_node_id, child_node_id, child_alias, child_token_id, action,
            delete_config, grace_seconds, force, in_flight_at_dispatch, created_by_token,
            status, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'pending', ?13)`,
        [
          requestId, node.network_id, args.daemon_node_id, node.node_id, node.alias, childTokenId, args.action,
          args.delete_config ? 1 : 0, args.grace_seconds, args.force ? 1 : 0, inFlight,
          callerTokenId || "unknown", now,
        ],
      );
      db.run(
        `UPDATE nodes SET lifecycle_state = ?1 WHERE node_id = ?2`,
        [newState, node.node_id],
      );
      // §4.5 D8 — audit dispatch action. Uses the STRICT variant so a
      // failed audit INSERT propagates and triggers ROLLBACK (PR1 SF-2
      // review catch — auditCreateNode's swallow-and-warn would have
      // committed the lifecycle UPDATE without an audit row, leaving
      // exactly the "deleted but no audit" window §4.5 closes).
      auditCreateNodeStrict({
        action: args.action === "stop" ? "stop_node_dispatched" : "delete_node_dispatched",
        user_id: enforceUserId, network_id: node.network_id, target_id: requestId,
        detail: {
          child_node_id: node.node_id, child_alias: node.alias,
          daemon_node_id: args.daemon_node_id, action: args.action,
          force: args.force, delete_config: args.delete_config,
          grace_seconds: args.grace_seconds, in_flight_at_dispatch: inFlight,
          lifecycle_state_before: state, lifecycle_state_after: newState,
          ts_request: now,
        },
      });
      if (args.force && inFlight > 0) {
        auditCreateNodeStrict({
          action: "forced_stop_with_in_flight",
          user_id: enforceUserId, network_id: node.network_id, target_id: requestId,
          detail: { in_flight_count: inFlight, child_alias: node.alias },
        });
      }
      });   // end db.transaction
    } catch (e: any) {
      return { ok: false, error: "dispatch_tx_failed", message: e?.message || String(e) };
    }

    // SSE doorbell — daemon will pull via get_stop_request.
    // PR1.2 e2e fix: route by daemon.alias (see SELECT above for the
    // BLOCKER explanation). Mirrors create_node's pushEvent target at
    // line ~2197.
    pushEvent(daemon.alias, { type: "stop_node", request_id: requestId }, node.network_id);
    return {
      ok: true, request_id: requestId, action: args.action,
      lifecycle_state: newState, in_flight_at_dispatch: inFlight,
    };
  };

  server.tool(
    "stop_node",
    "Stop the agent-node child process; keep config dir intact. Reversible via restart_node. RFC-027 §2.2. daemon_node_id is auto-resolved from child_node_id when omitted (looked up in node_create_requests).",
    {
      ...NODE_ID_ALIAS_FIELDS,
      // PR2 prereq: dashboard rarely knows daemon_node_id directly.
      // When omitted, hub resolves from the original creation record
      // (node_create_requests.daemon_node_id keyed by this child).
      daemon_node_id: z.string().min(1).max(200).regex(/^node_[a-z0-9_-]+$/).optional(),
      force: z.boolean().optional().default(false),
      grace_seconds: z.number().int().min(5).max(60).optional().default(10),
      network_id: z.string().max(200).optional(),
    },
    async ({ node_id, child_node_id: child_node_id_arg, daemon_node_id, force, grace_seconds, network_id: clientNetId }) => {
      const idArg = resolveNodeIdArg({ node_id, child_node_id: child_node_id_arg });
      if (!idArg.ok) return { content: [{ type: "text" as const, text: JSON.stringify(idArg) }] };
      const child_node_id = idArg.node_id;
      const resolved = daemon_node_id ?? resolveDaemonForChild(child_node_id);
      if (!resolved) {
        return { content: [{ type: "text" as const,
          text: JSON.stringify(explainUnresolvableDaemon(child_node_id)) }] };
      }
      const r = dispatchStopOrDelete(
        { action: "stop", child_node_id, daemon_node_id: resolved, force: force ?? false,
          grace_seconds: grace_seconds ?? 10, delete_config: false },
        clientNetId,
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(r) }] };
    },
  );

  server.tool(
    "delete_node",
    "Stop child + revoke ntok + delete hub row + (default) backup config to ~/.anet/deleted/<ts>-<alias>/ for 30d. confirm_alias must equal the node's alias. daemon_node_id is auto-resolved when omitted. RFC-027 §2.2.",
    {
      ...NODE_ID_ALIAS_FIELDS,
      daemon_node_id: z.string().min(1).max(200).regex(/^node_[a-z0-9_-]+$/).optional(),
      confirm_alias: z.string().min(1).max(200),
      force: z.boolean().optional().default(false),
      grace_seconds: z.number().int().min(5).max(60).optional().default(10),
      delete_config: z.boolean().optional().default(true),
      network_id: z.string().max(200).optional(),
    },
    async ({ node_id, child_node_id: child_node_id_arg, daemon_node_id, confirm_alias, force, grace_seconds, delete_config, network_id: clientNetId }) => {
      const idArg = resolveNodeIdArg({ node_id, child_node_id: child_node_id_arg });
      if (!idArg.ok) return { content: [{ type: "text" as const, text: JSON.stringify(idArg) }] };
      const child_node_id = idArg.node_id;
      const resolved = daemon_node_id ?? resolveDaemonForChild(child_node_id);
      if (!resolved) {
        return { content: [{ type: "text" as const,
          text: JSON.stringify(explainUnresolvableDaemon(child_node_id)) }] };
      }
      const r = dispatchStopOrDelete(
        { action: "delete", child_node_id, daemon_node_id: resolved, force: force ?? false,
          grace_seconds: grace_seconds ?? 10, delete_config: delete_config ?? true, confirm_alias },
        clientNetId,
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(r) }] };
    },
  );

  server.tool(
    "get_stop_request",
    "Daemon pulls a pending stop/delete request (called when SSE stop_node doorbell arrives). RFC-027 §2.4.",
    {
      request_id: z.string().min(1).max(200),
    },
    async ({ request_id }) => {
      const callerDaemon = resolveCallerDaemonTokenBound();
      if (!callerDaemon.ok) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: callerDaemon.error }) }] };
      }
      const row = db.get<{
        daemon_node_id: string; status: string; network_id: string;
        child_node_id: string; child_alias: string; action: string;
        delete_config: number; grace_seconds: number; force: number;
      }>(`SELECT daemon_node_id, status, network_id, child_node_id, child_alias, action,
                 delete_config, grace_seconds, force
            FROM node_stop_requests WHERE request_id = ?1`, request_id);
      if (!row) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "request_not_found" }) }] };
      if (row.daemon_node_id !== callerDaemon.daemonNodeId) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "not_your_request" }) }] };
      }
      if (row.network_id !== callerDaemon.networkId) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "cross_network_request" }) }] };
      }
      // Stamp delivered_at on first pull (idempotent — only if still pending).
      db.run(
        `UPDATE node_stop_requests SET status = 'delivered', delivered_at = ?1
           WHERE request_id = ?2 AND status = 'pending'`,
        [Date.now(), request_id],
      );
      return { content: [{ type: "text" as const, text: JSON.stringify({
        ok: true,
        request_id,
        child_node_id: row.child_node_id,
        child_alias: row.child_alias,
        action: row.action,
        delete_config: row.delete_config === 1,
        grace_seconds: row.grace_seconds,
        force: row.force === 1,
      }) }] };
    },
  );

  server.tool(
    "ack_stop_request",
    "Daemon reports stop/delete completion (or per-status failure). On 'stopped' status finalizes the lifecycle: stop→stopped + keep config; delete→DB row gone + revoke ntok. RFC-027 §2.3 + §4.5.",
    {
      request_id: z.string().min(1).max(200),
      status: z.enum(["stopped", "stop_failed", "noop_not_my_child"]),
      exit_signal: z.string().max(16).optional(),
      backup_path: z.string().max(500).optional(),
      error: z.string().max(1000).optional(),
    },
    async ({ request_id, status, exit_signal, backup_path, error: ackError }) => {
      // #1358 —— 🔴 在此之前,这个工具的**每一条出口都是静默的**:到达不记、
      // 三条拒绝不记、成功收尾也不记。而隔壁 create-node 的收尾**是记的**
      // (`✓ create-node finalize`)。这种不对称最坑人:读日志的人看到 create 有、
      // delete 没有,第一反应是「delete 没发生」—— 但两者的日志覆盖面本来就不同,
      // 那条推论没有依据。排查 #1286 时我自己就差点这样读。
      console.log(`[commhub] ← ack_stop_request request=${request_id} status=${status}${exit_signal ? ` exit_signal=${exit_signal}` : ""}`);
      const callerDaemon = resolveCallerDaemonTokenBound();
      if (!callerDaemon.ok) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: callerDaemon.error }) }] };
      }
      const row = db.get<{
        daemon_node_id: string; status: string; network_id: string;
        child_node_id: string; child_alias: string; child_token_id: string | null; action: string;
        in_flight_at_dispatch: number; force: number;
      }>(`SELECT daemon_node_id, status, network_id, child_node_id, child_alias, child_token_id, action,
                 in_flight_at_dispatch, force
            FROM node_stop_requests WHERE request_id = ?1`, request_id);
      if (!row) {
        console.warn(`[commhub] ✕ ack_stop_request rejected: request_not_found request=${request_id}`);
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "request_not_found" }) }] };
      }
      if (row.daemon_node_id !== callerDaemon.daemonNodeId) {
        console.warn(`[commhub] ✕ ack_stop_request rejected: not_your_request request=${request_id} row_daemon=${row.daemon_node_id} caller=${callerDaemon.daemonNodeId}`);
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "not_your_request" }) }] };
      }
      if (row.network_id !== callerDaemon.networkId) {
        console.warn(`[commhub] ✕ ack_stop_request rejected: cross_network_request request=${request_id} row_net=${row.network_id} caller_net=${callerDaemon.networkId}`);
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "cross_network_request" }) }] };
      }
      const now = Date.now();

      // §4.5 D8 — lifecycle UPDATE + request UPDATE + audit INSERT
      // (+ DELETE for delete action) atomic via db.transaction().
      // PR1.1: replaces hand-rolled BEGIN..COMMIT so PG adapter and
      // SQLite both get correct rollback semantics from one code path.
      try {
        db.transaction(() => {
          db.run(
            `UPDATE node_stop_requests SET status = ?1, error = ?2, exit_signal = ?3,
                                            backup_path = ?4, acked_at = ?5
               WHERE request_id = ?6`,
            [status, ackError || null, exit_signal || null, backup_path || null, now, request_id],
          );
          if (status === "stopped" && row.action === "stop") {
            db.run(`UPDATE nodes SET lifecycle_state = 'stopped' WHERE node_id = ?1`, [row.child_node_id]);
            auditCreateNodeStrict({
              action: "stop_node_completed",
              user_id: null, network_id: row.network_id, target_id: request_id,
              detail: {
                child_node_id: row.child_node_id, child_alias: row.child_alias,
                exit_signal: exit_signal || null, ts_daemon_ack: now,
                lifecycle_state_after: "stopped",
              },
            });
          } else if (status === "stopped" && row.action === "delete") {
            // Revoke the child's ntok, then DELETE the nodes row.
            // #1448 finding-5 — 精确按派发时定住的 child_token_id 撤(镜像
            // ack_create_request 的 token_id 精撤)。旧行(升级前派发,child_token_id
            // 为 NULL)fallback 回按 name='node:<alias>' 撤——旧语义,不引入回归。
            // 按 token_id 撤避免了「同 alias 在本次 delete 窗口内被重建、拿到同名新
            // token」时把新 token 一并误撤。
            if (row.child_token_id) {
              db.run(
                `UPDATE api_tokens SET revoked_at = datetime('now')
                   WHERE token_id = ?1 AND revoked_at IS NULL`,
                [row.child_token_id],
              );
            } else {
              db.run(
                `UPDATE api_tokens SET revoked_at = datetime('now')
                   WHERE network_id = ?1 AND name = ?2 AND revoked_at IS NULL`,
                [row.network_id, `node:${row.child_alias}`],
              );
            }
            db.run(`DELETE FROM nodes WHERE node_id = ?1`, [row.child_node_id]);
            auditCreateNodeStrict({
              action: "delete_node_completed",
              user_id: null, network_id: row.network_id, target_id: request_id,
              detail: {
                child_node_id: row.child_node_id, child_alias: row.child_alias,
                exit_signal: exit_signal || null, backup_path: backup_path || null,
                ts_daemon_ack: now, lifecycle_state_after: "deleted",
              },
            });
          } else if (status === "stop_failed") {
            db.run(`UPDATE nodes SET lifecycle_state = 'stop_failed' WHERE node_id = ?1`, [row.child_node_id]);
            // No completion audit; the failure error is on the request row.
          }
          // noop_not_my_child: leave lifecycle_state as-is; the hub-side
          // sweeper / next reconciliation will pick it up. Don't transition.
        });
      } catch (e: any) {
        console.warn(`[commhub] ✕ ack_stop_request finalize_tx_failed request=${request_id} action=${row.action} child=${row.child_alias}: ${e?.message || e}`);
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "finalize_tx_failed", message: e?.message || String(e) }) }] };
      }

      // 🔴 关键的是最后那半句「据此做了什么」。#1286 里 hub 的代码路径经核对是
      // 正确的,缺的正是「它到底走没走那条分支」—— 只说「收到了 ack」回答不了。
      const did = status === "stopped" && row.action === "delete"
        ? "revoked ntok + DELETE FROM nodes"
        : status === "stopped" && row.action === "stop"
        ? "lifecycle_state=stopped"
        : status === "stop_failed"
        ? "lifecycle_state=stop_failed"
        : "no lifecycle transition (noop_not_my_child)";
      console.log(`[commhub] ✓ ${row.action}-node finalize: request=${request_id} child=${row.child_alias} (${row.child_node_id}) status=${status} → ${did}`);
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, status }) }] };
    },
  );

  // start_node is deliberately daemon-mediated. A stopped child has no SSE
  // consumer of its own, so restart_node's self-doorbell cannot revive it.
  server.tool(
    "start_node",
    "Start a stopped child through its host supervisor daemon. daemon_node_id is auto-resolved from the original create request.",
    {
      ...NODE_ID_ALIAS_FIELDS,
      daemon_node_id: z.string().min(1).max(200).regex(/^node_[a-z0-9_-]+$/).optional(),
      network_id: z.string().max(200).optional(),
    },
    async ({ node_id, child_node_id: child_node_id_arg, daemon_node_id, network_id: clientNetId }) => {
      const idArg = resolveNodeIdArg({ node_id, child_node_id: child_node_id_arg });
      if (!idArg.ok) return { content: [{ type: "text" as const, text: JSON.stringify(idArg) }] };
      const child_node_id = idArg.node_id;
      const resolvedDaemonId = daemon_node_id ?? resolveDaemonForChild(child_node_id);
      if (!resolvedDaemonId) {
        return { content: [{ type: "text" as const, text: JSON.stringify({
          ok: false, error: "daemon_not_resolvable",
          message: "no create request maps this child to a daemon",
        }) }] };
      }
      const scope = resolveReadScope(clientNetId);
      if (scope.denied) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "forbidden_cross_tenant" }) }] };
      const q: any[] = [child_node_id];
      const child = db.get<{ node_id: string; alias: string; network_id: string; lifecycle_state: string | null }>(
        addReadScope(`SELECT node_id, alias, network_id, lifecycle_state FROM nodes WHERE node_id = ?1`, q, scope), ...q,
      );
      if (!child) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "forbidden_cross_tenant" }) }] };
      if (!canWrite(child.network_id)) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "permission_denied" }) }] };
      // #1448 finding-2 — stale-starting reaper，对齐 update_node_config / restart_node
      // 的 60s single-flight stale-supersede。start 只受理 'stopped';一旦卡 'starting'
      // (门铃丢 / daemon 在 UPDATE 'starting' 后死),config/restart 有 reaper、delete 有
      // 5min force,唯独 start 裸奔 → 下面的 gate 永远拦、也无人把节点拉回 stopped →
      // 永久卡 'starting'。出口:'starting' 且最近一条 in-flight start 请求晾过阈值 → 标
      // 旧请求 timeout 超越、放行重派;未过阈值则拒 node_already_starting(带 age)。
      const priorState = child.lifecycle_state ?? "active";
      if (priorState !== "stopped") {
        if (priorState !== "starting") {
          return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "node_not_stopped", current_state: priorState }) }] };
        }
        const STALE_STARTING_MS = 60_000;
        const inFlight = db.get<{ request_id: string; created_at: number; delivered_at: number | null; acked_at: number | null }>(
          `SELECT request_id, created_at, delivered_at, acked_at FROM node_start_requests
             WHERE child_node_id = ?1 AND status IN ('pending', 'delivered')
             ORDER BY created_at DESC LIMIT 1`, child.node_id,
        );
        if (inFlight) {
          // Age anchor = COALESCE(acked_at, delivered_at, created_at)，同 config reaper:
          // 已 pull/已 ack 的活着但慢的 start 会刷新存活时钟,不被误 reap。
          const ageAnchor = inFlight.acked_at ?? inFlight.delivered_at ?? inFlight.created_at;
          const age = Date.now() - ageAnchor;
          if (age <= STALE_STARTING_MS) {
            return { content: [{ type: "text" as const, text: JSON.stringify({
              ok: false, error: "node_already_starting",
              existing_request_id: inFlight.request_id, age_ms: age,
              hint: `再等一下;超过 ${STALE_STARTING_MS / 1000}s 仍卡 starting,重试 start 会重新派发`,
            }) }] };
          }
          // Stale — 标旧请求 timeout(autocommit,先于下面 tx 的新 INSERT,解除
          // node_start_requests 对 pending/delivered 的 child 唯一约束),放行重派。
          db.run(
            `UPDATE node_start_requests SET status = 'timeout', acked_at = ?1, error = ?2 WHERE request_id = ?3`,
            [Date.now(), `superseded by new start after ${age}ms stale (> ${STALE_STARTING_MS}ms threshold)`, inFlight.request_id],
          );
        }
        // else: 'starting' 但无 in-flight 行(异常残留态)——照样放行重派以自愈。
      }
      // The caller may provide daemon_node_id, but it cannot override the
      // authoritative child->daemon relationship recorded at creation.
      const authoritativeDaemonId = resolveDaemonForChild(child_node_id);
      if (!authoritativeDaemonId || authoritativeDaemonId !== resolvedDaemonId) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "daemon_child_mismatch" }) }] };
      }
      const daemon = db.get<{ node_id: string; alias: string; network_id: string }>(
        `SELECT node_id, alias, network_id FROM nodes WHERE node_id = ?1`, resolvedDaemonId,
      );
      if (!daemon) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "daemon_not_found" }) }] };
      if (daemon.network_id !== child.network_id) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "daemon_cross_tenant" }) }] };
      }
      const requestId = generateId("str");
      const now = Date.now();
      try {
        db.transaction(() => {
          db.run(
            `INSERT INTO node_start_requests
               (request_id, network_id, daemon_node_id, child_node_id, child_alias,
                created_by_token, status, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7)`,
            [requestId, child.network_id, daemon.node_id, child.node_id, child.alias, callerTokenId || "unknown", now],
          );
          // #1448 finding-2 — 也接受从 'starting' 重派(stale-supersede 后原态仍是
          // starting);两种入态都合法地转/留到 'starting'。
          db.run(`UPDATE nodes SET lifecycle_state = 'starting' WHERE node_id = ?1 AND lifecycle_state IN ('stopped', 'starting')`, [child.node_id]);
          auditCreateNodeStrict({
            action: "start_node_dispatched", user_id: enforceUserId,
            network_id: child.network_id, target_id: requestId,
            detail: { child_node_id: child.node_id, child_alias: child.alias, daemon_node_id: daemon.node_id,
              lifecycle_state_before: priorState, lifecycle_state_after: "starting", ts_request: now },
          });
        });
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "dispatch_tx_failed", message: e?.message || String(e) }) }] };
      }
      pushEvent(daemon.alias, { type: "start_node", request_id: requestId }, child.network_id);
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, request_id: requestId, lifecycle_state: "starting" }) }] };
    },
  );

  server.tool(
    "get_start_request",
    "Host supervisor pulls an authenticated pending start request.",
    { request_id: z.string().min(1).max(200) },
    async ({ request_id }) => {
      const callerDaemon = resolveCallerDaemonTokenBound();
      if (!callerDaemon.ok) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: callerDaemon.error }) }] };
      const row = db.get<{ daemon_node_id: string; network_id: string; child_node_id: string; child_alias: string; status: string }>(
        `SELECT daemon_node_id, network_id, child_node_id, child_alias, status FROM node_start_requests WHERE request_id = ?1`, request_id,
      );
      if (!row) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "request_not_found" }) }] };
      if (row.daemon_node_id !== callerDaemon.daemonNodeId) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "not_your_request" }) }] };
      if (row.network_id !== callerDaemon.networkId) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "cross_network_request" }) }] };
      if (!['pending', 'delivered'].includes(row.status)) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "request_not_startable", status: row.status }) }] };
      db.run(`UPDATE node_start_requests SET status='delivered', delivered_at=?1 WHERE request_id=?2 AND status='pending'`, [Date.now(), request_id]);
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, request_id, child_node_id: row.child_node_id, child_alias: row.child_alias }) }] };
    },
  );

  server.tool(
    "ack_start_request",
    "Host supervisor reports start completion or failure.",
    {
      request_id: z.string().min(1).max(200),
      status: z.enum(["started", "start_failed"]),
      child_pid: z.number().int().positive().optional(),
      error: z.string().max(1000).optional(),
    },
    async ({ request_id, status, child_pid, error: ackError }) => {
      const callerDaemon = resolveCallerDaemonTokenBound();
      if (!callerDaemon.ok) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: callerDaemon.error }) }] };
      const row = db.get<{ daemon_node_id: string; network_id: string; child_node_id: string; child_alias: string; status: string }>(
        `SELECT daemon_node_id, network_id, child_node_id, child_alias, status FROM node_start_requests WHERE request_id=?1`, request_id,
      );
      if (!row) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "request_not_found" }) }] };
      if (row.daemon_node_id !== callerDaemon.daemonNodeId) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "not_your_request" }) }] };
      if (row.network_id !== callerDaemon.networkId) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "cross_network_request" }) }] };
      if (row.status === "started" || row.status === "start_failed") {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, status: row.status, idempotent: true }) }] };
      }
      if (!['pending', 'delivered'].includes(row.status)) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "request_not_ackable", status: row.status }) }] };
      }
      if (status === "started" && !child_pid) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "child_pid_required" }) }] };
      }
      const now = Date.now();
      try {
        db.transaction(() => {
          db.run(`UPDATE node_start_requests SET status=?1,error=?2,child_pid=?3,acked_at=?4 WHERE request_id=?5`, [status, ackError || null, child_pid || null, now, request_id]);
          db.run(`UPDATE nodes SET lifecycle_state=?1 WHERE node_id=?2`, [status === "started" ? "active" : "stopped", row.child_node_id]);
          if (status === "started") auditCreateNodeStrict({
            action: "start_node_completed", network_id: row.network_id, target_id: request_id,
            detail: { child_node_id: row.child_node_id, child_alias: row.child_alias, child_pid, lifecycle_state_after: "active", ts_daemon_ack: now },
          });
        });
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "finalize_tx_failed", message: e?.message || String(e) }) }] };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, status }) }] };
    },
  );

  // RFC-027 PR1.1 — list_my_children: daemon-only query. Returns the
  // {child_node_id, alias, lifecycle_state} tuples for nodes whose
  // active create-request has this daemon as daemon_node_id. Used at
  // daemon boot to rebuild the in-memory childrenMap (PR1 dropped
  // every entry on daemon restart → stop/delete silently no-op'd).
  //
  // Network-scope is the daemon's own (resolveCallerDaemonTokenBound
  // already binds tokenIsNetwork to a single network). No SEC-1 leak:
  // returns ONLY children whose request landed under this daemon's
  // token + network.
  server.tool(
    "list_my_children",
    "Daemon pulls the alias + node_id list of children it spawned (for childrenMap rebuild after restart). RFC-027 PR1.1.",
    {},
    async () => {
      const callerDaemon = resolveCallerDaemonTokenBound();
      if (!callerDaemon.ok) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: callerDaemon.error }) }] };
      }
      // node_create_requests carries the canonical authoritative
      // child→daemon mapping (the row id IS the request, and the
      // child node_id derives from it deterministically via
      // `node_${request_id.replace(/^cr_/, "")}`). Filter to children
      // that completed registration (have a nodes row) so we don't
      // ask the daemon to pgrep for children that never came up.
      const rows = db.all<{ request_id: string; child_name: string; child_node_id: string; lifecycle_state: string | null }>(
        `SELECT ncr.request_id, ncr.child_name,
                ('node_' || substr(ncr.request_id, 4)) AS child_node_id,
                n.lifecycle_state
           FROM node_create_requests ncr
           LEFT JOIN nodes n ON n.node_id = ('node_' || substr(ncr.request_id, 4))
          WHERE ncr.daemon_node_id = ?1
            AND ncr.network_id = ?2
            AND ncr.status IN ('succeeded', 'delivered')
            AND n.node_id IS NOT NULL
            AND COALESCE(n.lifecycle_state, 'active') NOT IN ('stopped', 'stop_failed')`,
        callerDaemon.daemonNodeId, callerDaemon.networkId,
      );
      const children = rows.map(r => ({
        child_node_id: r.child_node_id,
        alias: r.child_name,
        lifecycle_state: r.lifecycle_state ?? "active",
      }));
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, count: children.length, children }) }] };
    },
  );

  // ── RFC-028 P1 — Provider & Model Registry + connectivity probe ──
  // Background timers (probe GC + sweeper) idempotent; safe to call
  // per registerTools.
  startPendingProbeGcTimer();
  startProbeSweeperTimer();

  // Helper: zod to JSON-RPC reply for ProbeValidationError + VaultError
  const probeFailReply = (e: unknown) => {
    if (e instanceof ProbeValidationError) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: e.code, ...(e.detail || {}) }) }] };
    }
    if (e instanceof VaultError) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: e.code, message: e.message }) }] };
    }
    throw e;
  };

  // §2.3.4 — upsert_network_secret (OWNER-ONLY; vault write).
  server.tool(
    "upsert_network_secret",
    "Write or replace a secret value in the network's vault (AES-GCM encrypted at rest). OWNER-only. RFC-028.",
    {
      key: z.string().min(1).max(64).regex(/^[A-Z][A-Z0-9_]{0,63}$/),
      value: z.string().min(1).max(16 * 1024),
      network_id: z.string().max(200).optional(),
    },
    async ({ key, value, network_id: clientNetId }) => {
      const effectiveNetId = getNetworkId(clientNetId);
      if (!canWrite(effectiveNetId)) return writeDeniedReply(effectiveNetId, "write");
      const callerRole = enforceUserId && effectiveNetId
        ? getUserNetworkRole(enforceUserId, effectiveNetId)
        : null;
      if (callerRole !== "owner") {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "secret_owner_only", required_role: "owner", caller_role: callerRole }) }] };
      }
      try {
        vaultUpsert(effectiveNetId || "default", key, value);
        auditCreateNode({
          action: "create_node_dispatched",  // reusing audit_log shape (provider follow-up logs)
          user_id: enforceUserId, network_id: effectiveNetId, target_id: null,
          detail: { op: "vault_upsert", key, network_id: effectiveNetId },
        });
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, key }) }] };
      } catch (e) {
        return probeFailReply(e);
      }
    },
  );

  // §2.3.4b — list_network_secrets (key names only; viewer+).
  server.tool(
    "list_network_secrets",
    "List vault key NAMES (NEVER values) for a network. RFC-028.",
    { network_id: z.string().max(200).optional() },
    async ({ network_id: clientNetId }) => {
      const effectiveNetId = getNetworkId(clientNetId);
      if (!canWrite(effectiveNetId) && enforceUserId) {
        // viewer-level: allow if caller has any role in network
        const role = getUserNetworkRole(enforceUserId, effectiveNetId || "default");
        if (!role) return writeDeniedReply(effectiveNetId, "read");
      }
      const keys = vaultListKeys(effectiveNetId || "default");
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, keys }) }] };
    },
  );

  // §2.3.1 — upsert_provider (admin+).
  server.tool(
    "upsert_provider",
    "Create or update a provider (vendor + base_url + secret_key_ref + initial models). Admin+. RFC-028.",
    {
      name: z.string().min(1).max(100),
      vendor: z.string().min(1).max(64),
      base_url: z.string().min(1).max(500),
      secret_key_ref: z.string().min(1).max(64),
      models: z.array(z.object({
        model_name: z.string().min(1).max(100),
        display_name: z.string().max(100).optional(),
        context_window: z.number().int().min(0).optional(),
        supports_vision: z.boolean().optional(),
      })).optional(),
      network_id: z.string().max(200).optional(),
    },
    async ({ name, vendor, base_url, secret_key_ref, models, network_id: clientNetId }) => {
      const effectiveNetId = getNetworkId(clientNetId);
      if (!canWrite(effectiveNetId)) return writeDeniedReply(effectiveNetId, "write");
      const callerRole = enforceUserId && effectiveNetId
        ? getUserNetworkRole(enforceUserId, effectiveNetId)
        : null;
      if (callerRole !== "admin" && callerRole !== "owner") {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "insufficient_role_for_provider", required_role: "admin", caller_role: callerRole }) }] };
      }
      try {
        _validateBaseUrl(vendor, base_url);
      } catch (e) {
        return probeFailReply(e);
      }
      // Verify vault key exists (best-effort; just lists names)
      const vaultKeys = vaultListKeys(effectiveNetId || "default");
      if (!vaultKeys.includes(secret_key_ref)) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "secret_not_in_vault", key: secret_key_ref, hint: "upsert_network_secret first" }) }] };
      }
      const providerId = `prov_${uuidv4()}`;
      try {
        db.run(
          `INSERT INTO providers (provider_id, network_id, name, vendor, base_url, secret_key_ref, created_at, created_by, enabled)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1)`,
          [providerId, effectiveNetId || "default", name, vendor, base_url, secret_key_ref, Date.now(), enforceUserId || "unknown"],
        );
      } catch (e: any) {
        if (/UNIQUE constraint failed/.test(e?.message || "")) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "provider_name_conflict", name }) }] };
        }
        throw e;
      }
      const modelIds: string[] = [];
      if (models) {
        for (const m of models) {
          const mid = `pm_${uuidv4()}`;
          db.run(
            `INSERT INTO provider_models (model_id, provider_id, model_name, display_name, context_window, supports_vision, enabled, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7)`,
            [mid, providerId, m.model_name, m.display_name ?? null, m.context_window ?? null, m.supports_vision ? 1 : 0, Date.now()],
          );
          modelIds.push(mid);
        }
      }
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, provider_id: providerId, model_ids: modelIds }) }] };
    },
  );

  // §2.3.2 — update_provider (admin+; patch semantics). RFC-028 P1.5.
  // Single tool for editing existing providers — patch model: name/base_url/
  // models/enabled all optional, at least one required. Vendor and
  // secret_key_ref are IMMUTABLE via this tool (vendor change = create+delete;
  // secret change goes through upsert_network_secret first). network_id is
  // immutable (cross-tenant move forbidden).
  //
  // base_url change re-runs validateBaseUrl with vendor read from DB row
  // (NOT from patch) — defends against trying to widen host allowlist by
  // smuggling a new vendor name. zod .strict() on the wrapping object
  // surfaces extras as -32602 at MCP boundary (R3 lock, same as
  // ack_probe_request per #308 fold-in).
  //
  // Audit: every successful update writes audit_log with before/after diff
  // of the changed fields ONLY (no secret values — secret isn't a patch
  // field, no leak path).
  server.registerTool(
    "update_provider",
    {
      description: "Edit existing provider (name/base_url/models/enabled). Patch semantics — at least one field. Vendor/secret/network_id immutable. Admin+. RFC-028 P1.5.",
      inputSchema: z.object({
        provider_id: z.string().regex(/^prov_[a-zA-Z0-9_-]+$/).max(200),
        network_id: z.string().max(200).optional(),
        patch: z.object({
          name: z.string().min(1).max(100).optional(),
          base_url: z.string().min(1).max(500).optional(),
          models: z.array(z.object({
            model_name: z.string().min(1).max(100),
            display_name: z.string().max(100).optional(),
            context_window: z.number().int().min(0).optional(),
            supports_vision: z.boolean().optional(),
          })).optional(),
          enabled: z.boolean().optional(),
        }).strict(),
      }).strict() as any,
    },
    async (args: any) => {
      const { provider_id, network_id: clientNetId, patch } = args;
      const effectiveNetId = getNetworkId(clientNetId);
      if (!canWrite(effectiveNetId)) return writeDeniedReply(effectiveNetId, "write");
      const callerRole = enforceUserId && effectiveNetId
        ? getUserNetworkRole(enforceUserId, effectiveNetId)
        : null;
      if (callerRole !== "admin" && callerRole !== "owner") {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "insufficient_role_for_provider", required_role: "admin", caller_role: callerRole }) }] };
      }

      // Empty patch — surface noop_no_changes (don't silently succeed)
      const patchKeys = Object.keys(patch || {});
      if (patchKeys.length === 0) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "noop_no_changes", hint: "patch must include at least one of: name, base_url, models, enabled" }) }] };
      }

      // SEC-1: row must exist within caller's network (SQL-level enforcement)
      const row = db.get<{ provider_id: string; vendor: string; name: string; base_url: string; enabled: number }>(
        `SELECT provider_id, vendor, name, base_url, enabled FROM providers WHERE provider_id = ?1 AND network_id = ?2`,
        provider_id, effectiveNetId || "default",
      );
      if (!row) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "provider_not_found", provider_id }) }] };
      }

      // base_url change → re-run validateBaseUrl with vendor from DB (not patch)
      if (patch.base_url !== undefined && patch.base_url !== row.base_url) {
        try {
          _validateBaseUrl(row.vendor, patch.base_url);
        } catch (e) {
          return probeFailReply(e);
        }
      }

      // Diff staging — collect before/after for audit (NO secret values; secret
      // isn't a patch field). Skip fields that didn't actually change.
      const diff: Record<string, { before: unknown; after: unknown }> = {};
      const sets: string[] = [];
      const params: unknown[] = [];
      let paramIdx = 1;
      if (patch.name !== undefined && patch.name !== row.name) {
        sets.push(`name = ?${paramIdx++}`); params.push(patch.name);
        diff.name = { before: row.name, after: patch.name };
      }
      if (patch.base_url !== undefined && patch.base_url !== row.base_url) {
        sets.push(`base_url = ?${paramIdx++}`); params.push(patch.base_url);
        diff.base_url = { before: row.base_url, after: patch.base_url };
      }
      if (patch.enabled !== undefined) {
        const newEnabled = patch.enabled ? 1 : 0;
        if (newEnabled !== row.enabled) {
          sets.push(`enabled = ?${paramIdx++}`); params.push(newEnabled);
          diff.enabled = { before: row.enabled === 1, after: patch.enabled };
        }
      }

      // Replace models list (if supplied) atomically with the providers UPDATE
      const willReplaceModels = patch.models !== undefined;
      const newModelIds: string[] = [];

      // No-op early return (通信牛 nit): all patch fields matched the
      // existing row values + no models supplied → no real change to
      // persist. Returning here means we don't write an empty-diff
      // audit row (audit noise). Audit_log INSERT must only fire when
      // something actually changed.
      if (sets.length === 0 && !willReplaceModels) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, provider_id, no_changes: true, hint: "patch fields matched existing row, no-op" }) }] };
      }

      try {
        db.exec("BEGIN");
        if (sets.length > 0) {
          params.push(provider_id);
          try {
            db.run(`UPDATE providers SET ${sets.join(", ")} WHERE provider_id = ?${paramIdx}`, params);
          } catch (e: any) {
            if (/UNIQUE constraint failed/.test(e?.message || "")) {
              db.exec("ROLLBACK");
              return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "provider_name_conflict", name: patch.name }) }] };
            }
            throw e;
          }
        }
        if (willReplaceModels) {
          db.run(`DELETE FROM provider_models WHERE provider_id = ?1`, [provider_id]);
          for (const m of patch.models) {
            const mid = `pm_${uuidv4()}`;
            db.run(
              `INSERT INTO provider_models (model_id, provider_id, model_name, display_name, context_window, supports_vision, enabled, created_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7)`,
              [mid, provider_id, m.model_name, m.display_name ?? null, m.context_window ?? null, m.supports_vision ? 1 : 0, Date.now()],
            );
            newModelIds.push(mid);
          }
          diff.models = { before: "(prior list)", after: `${patch.models.length} models replaced` };
        }
        db.run(
          `INSERT INTO audit_log (user_id, username, action, target_type, target_id, detail, network_id)
           VALUES (?1, ?2, 'update_provider', 'provider', ?3, ?4, ?5)`,
          [enforceUserId || null, callerAlias || null, provider_id, JSON.stringify({ diff, fields_changed: Object.keys(diff) }), effectiveNetId || null],
        );
        db.exec("COMMIT");
      } catch (e: any) {
        try { db.exec("ROLLBACK"); } catch { /* ok */ }
        throw e;
      }

      return { content: [{ type: "text" as const, text: JSON.stringify({
        ok: true, provider_id,
        fields_changed: Object.keys(diff),
        models_replaced: willReplaceModels ? newModelIds.length : null,
      }) }] };
    },
  );

  // §2.3.3 — list_providers (viewer+; never returns secret VALUES).
  server.tool(
    "list_providers",
    "List providers + models in the caller's network. Never returns secret VALUES. RFC-028.",
    { network_id: z.string().max(200).optional() },
    async ({ network_id: clientNetId }) => {
      const effectiveNetId = getNetworkId(clientNetId);
      // viewer access: caller must be member of network (read access)
      if (enforceUserId) {
        const role = getUserNetworkRole(enforceUserId, effectiveNetId || "default");
        if (!role) return writeDeniedReply(effectiveNetId, "read");
      }
      const providers = db.all<any>(
        `SELECT provider_id, name, vendor, base_url, secret_key_ref, enabled FROM providers WHERE network_id = ?1 AND enabled = 1 ORDER BY name`,
        effectiveNetId || "default",
      );
      const out = providers.map(p => {
        const models = db.all<any>(
          `SELECT model_id, model_name, display_name, context_window, supports_vision, enabled FROM provider_models WHERE provider_id = ?1 AND enabled = 1 ORDER BY model_name`,
          p.provider_id,
        );
        return { ...p, in_vault: true, models };  // in_vault: true since we required it on upsert
      });
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, providers: out }) }] };
    },
  );

  // §2.3.5 — probe_provider_model (admin+; dispatches to daemon).
  server.tool(
    "probe_provider_model",
    "Dispatch a connectivity probe to a daemon. Mints ephemeral secret blob; daemon pulls via get_probe_request. Admin+. RFC-028.",
    {
      provider_id: z.string().min(1).max(200),
      model_name: z.string().min(1).max(100),
      daemon_node_id: z.string().min(1).max(200),
      network_id: z.string().max(200).optional(),
    },
    async ({ provider_id, model_name, daemon_node_id, network_id: clientNetId }) => {
      const effectiveNetId = getNetworkId(clientNetId);
      if (!canWrite(effectiveNetId)) return writeDeniedReply(effectiveNetId, "write");
      const callerRole = enforceUserId && effectiveNetId
        ? getUserNetworkRole(enforceUserId, effectiveNetId)
        : null;
      if (callerRole !== "admin" && callerRole !== "owner") {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "insufficient_role_for_probe", required_role: "admin", caller_role: callerRole }) }] };
      }
      // Resolve provider + model (network-scoped). Distinguish "not found"
      // from "disabled" so the dashboard can render the right error
      // (P1.5 dashboard编辑/停用 needs this to explain why probe rejected).
      const provider = db.get<any>(
        `SELECT provider_id, vendor, base_url, secret_key_ref, enabled FROM providers WHERE provider_id = ?1 AND network_id = ?2`,
        provider_id, effectiveNetId || "default",
      );
      if (!provider) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "provider_not_found", provider_id }) }] };
      if (provider.enabled !== 1) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "provider_disabled", provider_id, hint: "update_provider with enabled:true to re-enable" }) }] };
      const model = db.get<any>(
        `SELECT model_id, model_name FROM provider_models WHERE provider_id = ?1 AND model_name = ?2 AND enabled = 1`,
        provider_id, model_name,
      );
      if (!model) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "model_not_found", model_name }) }] };
      // Resolve daemon (must be in caller network)
      const { row: daemon, sec1Ok } = resolveTargetNode(daemon_node_id, effectiveNetId);
      if (!daemon) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "daemon_not_found" }) }] };
      if (!sec1Ok) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "cross_network_node" }) }] };
      // Vault decrypt the API key (may throw VaultError)
      let apiKey: string;
      try {
        const v = vaultGet(effectiveNetId || "default", provider.secret_key_ref);
        if (!v) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "secret_not_in_vault", key: provider.secret_key_ref }) }] };
        apiKey = v;
      } catch (e) { return probeFailReply(e); }
      // Mint probe row + stash ephemeral blob
      const probeId = newProbeId();
      db.run(
        `INSERT INTO probe_results (probe_id, provider_id, model_name, daemon_node_id, network_id, status, probed_at, probed_by_user)
         VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7)`,
        [probeId, provider_id, model_name, daemon_node_id, effectiveNetId || "default", Date.now(), enforceUserId || null],
      );
      putPendingProbeSecret({
        probe_id: probeId,
        daemon_node_id,
        provider_id,
        vendor: provider.vendor,
        base_url: provider.base_url,
        model_name,
        api_key: apiKey,
        network_id: effectiveNetId || "default",
      });
      pushEvent(daemon.alias, { type: "probe_provider", probe_id: probeId }, daemon.network_id || effectiveNetId || "default");
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, probe_id: probeId }) }] };
    },
  );

  // §2.3.6 — get_probe_results (viewer+; matrix renderer source).
  server.tool(
    "get_probe_results",
    "Query probe history (optionally filtered by provider/model/daemon). Used by dashboard reachability matrix. RFC-028.",
    {
      provider_id: z.string().max(200).optional(),
      model_name: z.string().max(100).optional(),
      daemon_node_id: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(500).optional(),
      network_id: z.string().max(200).optional(),
    },
    async ({ provider_id, model_name, daemon_node_id, limit, network_id: clientNetId }) => {
      const effectiveNetId = getNetworkId(clientNetId);
      if (enforceUserId) {
        const role = getUserNetworkRole(enforceUserId, effectiveNetId || "default");
        if (!role) return writeDeniedReply(effectiveNetId, "read");
      }
      const where: string[] = ["network_id = ?1"];
      const params: any[] = [effectiveNetId || "default"];
      if (provider_id)    { where.push(`provider_id = ?${params.length + 1}`); params.push(provider_id); }
      if (model_name)     { where.push(`model_name = ?${params.length + 1}`); params.push(model_name); }
      if (daemon_node_id) { where.push(`daemon_node_id = ?${params.length + 1}`); params.push(daemon_node_id); }
      const sql = `SELECT probe_id, provider_id, model_name, daemon_node_id, status, latency_ms, error_label, probed_at, raw_status_code FROM probe_results WHERE ${where.join(" AND ")} ORDER BY probed_at DESC LIMIT ${limit ?? 100}`;
      const rows = db.all<any>(sql, ...params);
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, results: rows }) }] };
    },
  );

  // §2.3.7 daemon-facing — get_probe_request.
  server.tool(
    "get_probe_request",
    "Daemon pulls a pending probe request (called when SSE probe_provider doorbell arrives). RFC-028.",
    { probe_id: z.string().min(1).max(200) },
    async ({ probe_id }) => {
      const callerDaemon = _resolveCallerDaemonTokenBound({ callerTokenIsNetwork, callerTokenId, enforceNetworkId });
      if (!callerDaemon.ok) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: callerDaemon.error }) }] };
      }
      // takePendingProbeSecret enforces daemon binding + evicts
      const blob = (await import("./probe.js")).takePendingProbeSecret(probe_id, callerDaemon.daemonNodeId);
      if (!blob) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "probe_request_unavailable", reason: "not_found_or_wrong_daemon_or_expired" }) }] };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify({
        ok: true,
        probe_id: blob.probe_id,
        vendor: blob.vendor,
        base_url: blob.base_url,
        model_name: blob.model_name,
        api_key: blob.api_key,        // ephemeral; daemon writes to .env.local or in-memory only
      }) }] };
    },
  );

  // §2.3.8 daemon-facing — ack_probe_request (STRICT whitelist via zod).
  // R3 LOCK (RFC-028 v3): ack payload has EXACTLY 4 keys. We pass a
  // ZodObject with .strict() so the MCP SDK's validateToolInput surfaces
  // any extra field (e.g. an attacker smuggling `error_message` to leak a
  // secret) as a -32602 Invalid params error at the protocol boundary
  // BEFORE our handler runs. The SDK invokes z.object(shape) by default
  // which is strip-mode; passing a fully-constructed strict object
  // bypasses that and enforces unknownKeys='strict'.
  server.registerTool(
    "ack_probe_request",
    {
      description: "Daemon acks a probe. Schema is STRICT whitelist (no error_message; v3 R3 LOCK). RFC-028.",
      // Strict-mode ZodObject so the MCP SDK's validateToolInput surfaces
      // any extra field as a -32602 Invalid params error BEFORE the
      // handler runs. server.tool() accepts only ZodRawShape (default
      // strip-mode); registerTool() accepts a constructed ZodObject and
      // honors its unknownKeys policy.
      inputSchema: z.object({
        probe_id: z.string().min(1).max(200),
        status: z.enum(["ok", "auth_fail", "quota", "rate_limit", "network_error", "timeout", "redirect_forbidden", "vendor_5xx", "other_4xx", "tls_error", "probe_resolve_unsafe_ip", "probe_target_forbidden"]),
        raw_status_code: z.number().int().min(100).max(599).optional(),
        latency_ms: z.number().int().min(0).max(60_000),
      }).strict() as any,
    },
    async (args: any) => {
      const callerDaemon = _resolveCallerDaemonTokenBound({ callerTokenIsNetwork, callerTokenId, enforceNetworkId });
      if (!callerDaemon.ok) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: callerDaemon.error }) }] };
      }
      try {
        const r = finalizeProbeAck(args, { network_id: callerDaemon.networkId, daemon_node_id: callerDaemon.daemonNodeId });
        return { content: [{ type: "text" as const, text: JSON.stringify(r) }] };
      } catch (e) {
        return probeFailReply(e);
      }
    },
  );

  // ── 需求池 / 任务看板(Agent 读写任务,例如把 GitHub issue 同步成任务) ──
  // 全部走 REST 同一个处理函数(requirements.ts handleRequirementsRequest):权限、校验、谁做的记录只有一份。
  // 节点令牌只在它绑定的网络里读 / 建 / 改 / 勾子任务 / upsert / 读项目;删除和管理项目只给人。
  const requirementsCall = async (method: string, path: string, clientNetId?: string | null, body?: Record<string, unknown>) => {
    const scope = resolveRestNetworkScope(enforceNetworkId ? null : (clientNetId ?? null), mcpAuthCtx, false);
    if (scope.denied) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "access_denied", message: scope.denied }) }] };
    const url = new URL(`http://mcp.internal${path}`);
    const req = new Request(url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const res = await handleRequirementsRequest({
      req, url,
      auth: mcpAuthCtx ? { ...mcpAuthCtx, username: "", tokenId: callerTokenId ?? null, tokenName: callerTokenIsNetwork && callerAlias ? `node:${callerAlias}` : null } : null,
      isAdmin: false,
      isNodeToken: callerTokenIsNetwork,
      scope,
      // #470:经 MCP 的写一律严格 —— owner 传节点回 400 owner_must_be_human(+ hint),不走旧 App 的兼容改写。
      strictOwner: true,
    });
    const data = res ? await res.json() : { ok: false, error: "not_found" };
    return { content: [{ type: "text" as const, text: JSON.stringify(res && !res.ok && data && typeof data === "object" ? { ...data, status: res.status } : data) }] };
  };
  // #473 —— 人员字段除了 id,也可以按名字:{kind:'user', username} / {kind:'node', alias},在任务所在的网络里解析
  // (requirements.ts personRef;找不到 / 别名对上多个 → 400 + hint)。给了 id 就只看 id。
  const reqPerson = z.object({
    kind: z.enum(["user", "node"]),
    // #476 —— 这三格的说明不写在这里:reqPerson 在 3 个工具 × 3 个字段里展开,每份都复制一遍(~1.6 KB)。
    // 写法在 owner / agent_owner / participants 的 describe 里各说一次。
    id: z.string().min(1).max(200).optional(),
    username: z.string().min(1).max(100).optional(),
    alias: z.string().min(1).max(200).optional(),
  });
  const reqChecklistItem = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).optional(), text: z.string().min(1).max(500), done: z.boolean().optional() });
  const reqFields = {
    tags: z.array(z.string()).max(10).optional().describe("Task labels; each 1–20 Unicode characters. Omit to preserve, [] to clear."),
    name: z.string().min(1).max(80).optional(),
    priority: z.enum(["high", "normal", "low", "lowest"]).optional().describe("high = P0 最高, normal = P1 普通, low = P2 低, lowest = P3 极低"),
    column: z.enum(["pool", "doing", "done"]).optional(),
    due: z.string().max(40).optional().describe("YYYY-MM-DD (all day) or ISO 8601 with Z / ±HH:MM (stored as UTC seconds); \"\" clears"),
    start: z.string().max(40).optional().describe("start date (Gantt): same shapes as due; \"\" clears"),
    description: z.string().max(20_000).optional().describe("markdown"),
    checklist: z.array(reqChecklistItem).max(100).optional().describe("replaces the whole list"),
    project_id: z.string().max(200).nullable().optional(),
    owner: reqPerson.nullable().optional().describe("负责人 (a person): {kind:'user', id | username} (ids / usernames from requirements_people; names resolve in the task's network); a node is rejected with owner_must_be_human — use agent_owner"),
    agent_owner: reqPerson.nullable().optional().describe("负责 Agent: {kind:'node', id | alias}"),
    participants: z.array(reqPerson).max(100).optional().describe("REPLACES the whole list (written like owner / agent_owner; omitted people are removed, [] clears). To add or remove a few, use participants_add / participants_remove on requirements_update."),
    external_url: z.string().max(500).nullable().optional(),
    parent_id: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).nullable().optional().describe("parent requirement (same network, no cycles, ≤ 5 levels); null detaches"),
  };
  const pick = (args: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter(k => args[k] !== undefined).map(k => [k, args[k]]));
  const REQ_WRITE_KEYS = [...Object.keys(reqFields), "external_ref", "archived"];
  // #475 —— status 是 column 的别名(列表的筛选参数就叫 status,Agent 写任务时也常这么写)。只在 MCP 这层换名,REST 不变;
  // 两个都给且不同 → 400 status_conflicts_with_column,不替调用方挑一个。
  const reqStatus = z.enum(["pool", "doing", "done"]).optional().describe("alias of column; must match it if both are sent");
  const withColumn = (args: Record<string, unknown>, call: (args: Record<string, unknown>) => Promise<{ content: { type: "text"; text: string }[] }>) => {
    if (args.status === undefined) return call(args);
    if (args.column !== undefined && args.column !== args.status) return Promise.resolve({ content: [{ type: "text" as const, text: JSON.stringify({ ...errorBody("status_conflicts_with_column"), status: 400 }) }] });
    return call({ ...args, column: args.status });
  };
  const reqPeopleDelta = (verb: string) => z.array(reqPerson).max(100).optional().describe(`${verb === "add" ? "Add to" : "Remove from"} the participant list, keeping the rest (atomic; not with participants).`);
  const REQ_ID_DESC = "requirement id (req_…) or short number \"#N\" (per network; with several networks also pass network_id)";

  // #471 —— MCP 的列表默认省流:summary 视图 + 50 张一页(REST 的默认 full + 500 不变,App 靠它)。
  // 生产实测 122 张卡:旧默认(full、500)148 KB,summary 81 KB —— 一次调用就塞满 Agent 的上下文。
  // 输入 schema 严格:写错 / 不认识的参数(比如以前的 tag)原来会被静默丢掉、回整张表;现在回 -32602 并列出能用的参数。
  const REQ_LIST_MCP_DEFAULT_LIMIT = 50;
  const reqListShape = {
    network_id: z.string().max(200).optional(),
    seq: z.number().int().positive().optional().describe("short number (#N) of one task in this network"),
    status: z.enum(["pool", "doing", "done"]).optional(),
    project_id: z.string().max(200).optional(),
    owner: z.string().max(210).optional(),
    agent_owner: z.string().max(210).optional(),
    tag: z.string().min(1).max(80).optional().describe("only tasks carrying this label (exact, case-sensitive)"),
    updated_since: z.string().max(40).optional(),
    external_ref: z.string().max(200).optional(),
    include_archived: z.boolean().optional(),
    parent_id: z.string().max(200).optional().describe("children of this requirement ('none' = top level)"),
    department_id: z.string().max(64).optional().describe("owner (or its Agent's owner) in this department or below"),
    top_level: z.boolean().optional(), q: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(1000).optional().describe(`page size, default ${REQ_LIST_MCP_DEFAULT_LIMIT}`),
    cursor: z.string().max(600).optional().describe("next_cursor from the previous page"),
    view: z.enum(["full", "summary"]).optional().describe("default summary (no description / checklist bodies; has_description, checklist_count instead); full = everything"),
    changes: z.boolean().optional().describe("with updated_since: only tasks changed since then (archived included) + deleted ids + server_time"),
  };
  const reqListKeys = Object.keys(reqListShape);
  server.registerTool(
    "requirements_list",
    {
      description: `List requirement tasks in your network, newest first. Defaults (MCP): view='summary' (no description / checklist bodies; has_description, checklist_count instead; ~0.5 KB per task) and ${REQ_LIST_MCP_DEFAULT_LIMIT} per page; has_more + next_cursor → pass cursor. Full text: requirements_get, or view='full' with a small limit (≤ 1000). Filters: seq (#N), status, project_id ('none'), owner / agent_owner ('user:<id>' / 'node:<id>' / 'none'), tag (exact), updated_since (ISO), external_ref, parent_id / top_level, department_id (owner in it or below), include_archived; q searches title / description / people / project / tags (terms ANDed). Rows carry children {total, done}. changes=true (with updated_since) returns only tasks changed since then, archived included, plus deleted ids and server_time for the next updated_since. Unknown parameters are rejected (-32602).`,
      // Strict: registerTool honours a constructed object's unknownKeys (server.tool() would strip them silently).
      inputSchema: z.strictObject(reqListShape, {
        error: (iss: any) => iss.code === "unrecognized_keys"
          ? `unknown parameter(s): ${(iss.keys ?? []).join(", ")}; valid parameters: ${reqListKeys.join(", ")}`
          : undefined,
      }) as any,
    },
    async (args: any) => {
      const q = new URLSearchParams();
      for (const k of ["seq", "status", "project_id", "owner", "agent_owner", "tag", "updated_since", "external_ref", "parent_id", "department_id", "q", "limit", "cursor", "view"] as const) if (args[k] !== undefined) q.set(k, String(args[k]));
      if (!q.has("view")) q.set("view", "summary");
      if (!q.has("limit")) q.set("limit", String(REQ_LIST_MCP_DEFAULT_LIMIT));
      if (args.include_archived) q.set("include_archived", "1");
      if (args.top_level) q.set("top_level", "1");
      if (args.changes) q.set("changes", "1");
      return requirementsCall("GET", `/api/requirements?${q}`, args.network_id);
    },
  );

  // #473 —— Agent 查人:紧凑通讯录(requirements-people.ts)。严格参数,同 requirements_list(#471)。
  const reqPeopleShape = {
    network_id: z.string().max(200).optional(),
    q: z.string().min(1).max(100).optional().describe("case-insensitive substring of username, display name, department or Agent alias"),
    limit: z.number().int().min(1).max(200).optional().describe("people per page, default 50"),
    offset: z.number().int().min(0).optional().describe("next_offset from the previous page"),
  };
  const reqPeopleKeys = Object.keys(reqPeopleShape);
  server.registerTool(
    "requirements_people",
    {
      description: "Look up the people in your network and the Agents they own, to fill task person fields. Each row: user_id, username, display_name (\"\" if not set), role, department {id, name} or null, agents [{node_id, alias}]; Agents with no owner in this network are listed in agents_without_owner (first page only). q filters by username / display name / department / Agent alias (case-insensitive substring). 50 people per page (limit ≤ 200); has_more + next_offset → pass offset. Agents you are not granted are left out. Task person fields take these ids, or {kind:'user', username} / {kind:'node', alias}.",
      inputSchema: z.strictObject(reqPeopleShape, {
        error: (iss: any) => iss.code === "unrecognized_keys"
          ? `unknown parameter(s): ${(iss.keys ?? []).join(", ")}; valid parameters: ${reqPeopleKeys.join(", ")}`
          : undefined,
      }) as any,
    },
    async (args: any) => {
      const q = new URLSearchParams();
      for (const k of ["q", "limit", "offset"] as const) if (args[k] !== undefined) q.set(k, String(args[k]));
      return requirementsCall("GET", `/api/requirements/people/directory${q.size ? `?${q}` : ""}`, args.network_id);
    },
  );

  server.tool(
    "requirements_get",
    "Get one requirement task by id or by its short number \"#N\" (with description, checklist, owners, project, external_ref, seq).",
    { id: z.string().min(1).max(200).describe(REQ_ID_DESC), network_id: z.string().max(200).optional() },
    async ({ id, network_id }) => requirementsCall("GET", `/api/requirements/${encodeURIComponent(id)}`, network_id),
  );

  server.tool(
    "requirements_create",
    "Create a requirement task. name is required. column (or its alias status) = pool / doing / done. A duplicate external_ref in the network returns 409 external_ref_exists with existing_id — use requirements_upsert_by_external_ref for syncing.",
    { network_id: z.string().max(200).optional(), ...reqFields, status: reqStatus, name: z.string().min(1).max(80), external_ref: z.string().max(200).optional() },
    async (args) => withColumn(args, a => requirementsCall("POST", "/api/requirements", args.network_id, pick(a, REQ_WRITE_KEYS))),
  );

  server.tool(
    "requirements_update",
    "Patch a requirement task (id or \"#N\"); omitted fields keep their value. column (or its alias status) moves it between pool / doing / done. participants REPLACES the whole list; to add or remove people without dropping the others use participants_add / participants_remove. archived=true hides it from the default list (agents cannot delete).",
    { id: z.string().min(1).max(200).describe(REQ_ID_DESC), network_id: z.string().max(200).optional(), ...reqFields, status: reqStatus, participants_add: reqPeopleDelta("add"), participants_remove: reqPeopleDelta("remove"), external_ref: z.string().max(200).nullable().optional(), archived: z.boolean().optional() },
    async (args) => withColumn(args, a => requirementsCall("PATCH", `/api/requirements/${encodeURIComponent(args.id)}`, args.network_id, pick(a, [...REQ_WRITE_KEYS, "participants_add", "participants_remove"]))),
  );

  server.tool(
    "requirements_checklist_toggle",
    "Set one checklist item done / not done (only that item is written, so concurrent edits of other items are kept).",
    { id: z.string().min(1).max(200).describe(REQ_ID_DESC), item_id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/), done: z.boolean(), network_id: z.string().max(200).optional() },
    async ({ id, item_id, done, network_id }) => requirementsCall("PATCH", `/api/requirements/${encodeURIComponent(id)}/checklist/${encodeURIComponent(item_id)}`, network_id, { done }),
  );

  server.tool(
    "requirements_upsert_by_external_ref",
    "Idempotent sync: create the task for external_ref (e.g. github:owner/repo#123) or, if it already exists in the network, patch it (omitted fields — including column / status — are kept). Returns { requirement, created }.",
    { network_id: z.string().max(200).optional(), external_ref: z.string().min(1).max(200), ...reqFields, status: reqStatus, archived: z.boolean().optional() },
    async (args) => withColumn(args, a => requirementsCall("POST", "/api/requirements/upsert", args.network_id, pick(a, REQ_WRITE_KEYS))),
  );

  server.tool(
    "projects_list",
    "List requirement projects in your network (id, name, color, sort, archived). Node (Agent) tokens can only read projects; creating / changing them (projects_create / projects_update) needs a person's token.",
    { network_id: z.string().max(200).optional() },
    async ({ network_id }) => requirementsCall("GET", "/api/requirements/projects", network_id),
  );

  // Agent parity (app task audit 2026-10-02 M3): what people do under 管理项目 and the task 动态 timeline. Both go
  // through the same REST handlers as the app, so every permission check is the app's own: project management needs
  // write access and is refused to 「仅相关任务」(task-scoped) members; events use the task list's visibility.
  server.tool(
    "projects_create",
    "Create a requirement project in your network (same as 管理项目 → 新建 in the app). name 1–40 characters, unique in the network; color #RRGGBB (default: next palette colour); sort integer. Returns { project }. Needs a person's token: node (Agent) tokens can only read projects (403 user_token_required). Also refused (403) for task-scoped members and read-only roles.",
    {
      network_id: z.string().max(200).optional(),
      name: z.string().min(1).max(40),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      sort: z.number().int().optional(),
    },
    async (args) => requirementsCall("POST", "/api/requirements/projects", args.network_id, pick(args, ["name", "color", "sort"])),
  );

  server.tool(
    "projects_update",
    "Rename, recolour, reorder, archive or unarchive a requirement project (same as 管理项目 in the app). Only the fields you pass change. archived=true hides it from pickers (its tasks keep project_id); archived=false brings it back. Returns { project }. Needs a person's token: node (Agent) tokens can only read projects (403 user_token_required). Also refused (403) for task-scoped members and read-only roles.",
    {
      network_id: z.string().max(200).optional(),
      id: z.string().min(1).max(200).describe("project id (proj_…), from projects_list"),
      name: z.string().min(1).max(40).optional(),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      sort: z.number().int().optional(),
      archived: z.boolean().optional(),
    },
    async (args) => requirementsCall("PATCH", `/api/requirements/projects/${encodeURIComponent(args.id)}`, args.network_id, pick(args, ["name", "color", "sort", "archived"])),
  );

  // #476 —— 不带 requirement_id 的全网动态默认 50 条(REST 默认 200 不变,App 走 REST);严格参数同 #471。
  const REQ_EVENTS_NETWORK_DEFAULT_LIMIT = 50;
  const reqEventsShape = {
    network_id: z.string().max(200).optional(),
    requirement_id: z.string().min(1).max(200).optional().describe(REQ_ID_DESC),
    since: z.string().max(40).optional().describe("ISO; only events after it"),
    limit: z.number().int().min(1).max(500).optional(),
    cursor: z.string().max(20).optional().describe("next_cursor from the previous page (older events)"),
  };
  const reqEventsKeys = Object.keys(reqEventsShape);
  server.registerTool(
    "requirements_events",
    {
      description: `Read the task activity timeline (the app's 动态), newest first: field-level changes (who, when, old → new) and comments (kind=comment, text in new.text; add one with requirements_comment). With requirement_id (req_… or "#N"): that task's events (limit default 200). Without it: the whole network, ${REQ_EVENTS_NETWORK_DEFAULT_LIMIT} per page by default. limit ≤ 500; next_cursor → pass as cursor for older events; server_time → use as the next since. Same visibility as requirements_list. Unknown parameters are rejected (-32602).`,
      inputSchema: z.strictObject(reqEventsShape, {
        error: (iss: any) => iss.code === "unrecognized_keys"
          ? `unknown parameter(s): ${(iss.keys ?? []).join(", ")}; valid parameters: ${reqEventsKeys.join(", ")}`
          : undefined,
      }) as any,
    },
    async (args: any) => {
      let card = args.requirement_id;
      // "#N" → the card's id, resolved exactly like requirements_get (same scope; a card you can't see is a 404 here too).
      if (card && /^#\d+$/.test(card)) {
        const got = await requirementsCall("GET", `/api/requirements/${encodeURIComponent(card)}`, args.network_id);
        const parsed = JSON.parse(got.content[0].text) as { requirement?: { id?: string } };
        if (!parsed.requirement?.id) return got;
        card = parsed.requirement.id;
      }
      const q = new URLSearchParams();
      if (card) q.set("requirement_id", card);
      if (args.since) q.set("since", args.since);
      if (args.limit !== undefined) q.set("limit", String(args.limit));
      else if (!card) q.set("limit", String(REQ_EVENTS_NETWORK_DEFAULT_LIMIT));
      if (args.cursor) q.set("cursor", args.cursor);
      return requirementsCall("GET", `/api/requirements/events${q.size ? `?${q}` : ""}`, args.network_id);
    },
  );

  // #474(MCP 任务生命周期测试报告问题 5):评论 / 进展。以前只能 requirements_get 读全文、再整段改写 description ——
  // 两次调用,并发时覆盖别人刚写的描述。这条只追加,进「动态」(requirements_events kind=comment),不改任务本身。
  server.tool(
    "requirements_comment",
    "Add a comment / progress note to a task (append-only; never rewrites the description). It shows in the task's activity timeline (the app's 动态, requirements_events kind=comment, text in new.text) under your name. text: markdown, 1–4000 characters. Anyone who can see the task and can write in the network (not read-only) may comment. Returns { event }.",
    {
      id: z.string().min(1).max(200).describe(REQ_ID_DESC),
      text: z.string().min(1).max(4000).describe("the comment (markdown), 1–4000 characters"),
      network_id: z.string().max(200).optional(),
    },
    async ({ id, text, network_id }) => requirementsCall("POST", `/api/requirements/${encodeURIComponent(id)}/comments`, network_id, { text }),
  );

  // #478:tools/list 只列这个调用者真能用的工具(tool-audience.ts)。只滤列表,tools/call 不变。
  const caller: ToolCaller = callerTokenIsNetwork
    ? { kind: "node", tokenId: callerTokenId ?? null, networkId: enforceNetworkId ?? null, includeProtocol: listing.includeProtocol === true }
    : enforceUserId ? { kind: "user", includeProtocol: listing.includeProtocol === true } : { kind: "unknown" };
  scopeToolsList(server, listedToolFilter(caller));
}

// ────────────────────────────────────────────────────────────────────
// PR A SEC follow-up (#287 cross-tenant trust-root catch, 通信牛
// 2026-06-28) — exported so the production report_status path AND
// the regression test in config-apply-sec1.test.ts exercise the SAME
// code. Per 通信龙 test-quality finding: an inline-mirror test that
// re-implements the gate inside the test body provides zero
// protection against guard drift. By forcing both code paths through
// this single helper, deleting / weakening the gate fails the test.
//
// Returns a discriminated outcome so callers can log/route the refused
// case (production: silent skip + console.warn; tests: assertion).
// ────────────────────────────────────────────────────────────────────
export interface UpsertNodeWithSec1GuardInput {
  node_id: string;
  callerNetworkId: string | null;
  callerUserId?: string | null;
  callerTokenId?: string | null;
  node_name?: string | null;
  alias?: string | null;
  runtime?: string | null;
  model?: string | null;
  config_path?: string | null;
  channels?: string | null;
  server?: string | null;
  hostname?: string | null;
  config_snapshot?: unknown | null;
}
export type UpsertNodeOutcome =
  | { result: "inserted" | "updated"; node_id: string }
  | { result: "refused"; reason: "cross_network" | "token_node_mismatch" | "owner_mismatch"; existingNet: string | null; callerNet: string | null }
  | { result: "skipped"; reason: "missing_node_id" };

const _norm = (x: string | null | undefined) => (x === null || x === undefined ? "default" : x);

/**
 * A capability that changes peer delivery semantics is trusted only when the
 * authenticating ntok is immutably bound to the exact reported node. Legacy
 * alias-only tokens may still heartbeat, but cannot opt a node into #698.
 */
export function trustedConfigSnapshotForNode(
  snapshot: unknown | null | undefined,
  callerTokenId: string | null | undefined,
  nodeId: string,
): unknown | null | undefined {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  const copy = { ...(snapshot as Record<string, unknown>) };
  const token = callerTokenId
    ? db.get<{ bound_node_id: string | null }>(
      "SELECT bound_node_id FROM api_tokens WHERE token_id = ?1",
      callerTokenId,
    )
    : null;
  if (token?.bound_node_id !== nodeId) delete copy.peer_reply_inbox_capable;
  return copy;
}

export function upsertNodeWithSec1Guard(input: UpsertNodeWithSec1GuardInput): UpsertNodeOutcome {
  if (!input.node_id) return { result: "skipped", reason: "missing_node_id" };
  const existing = db.get<{ network_id: string | null; owner_user_id: string | null }>(
    "SELECT network_id, owner_user_id FROM nodes WHERE node_id = ?1",
    input.node_id,
  );
  const callerNet = input.callerNetworkId;

  // RFC-036 — when a token was minted with a node_id binding, a heartbeat may
  // report only that exact node. Legacy unbound ntok rows remain compatible,
  // but they can never consume owner-gated schedule intents.
  if (input.callerTokenId) {
    const token = db.get<{ bound_node_id: string | null; user_id: string; network_id: string | null }>(
      "SELECT bound_node_id, user_id, network_id FROM api_tokens WHERE token_id = ?1",
      input.callerTokenId,
    );
    if (token?.bound_node_id && token.bound_node_id !== input.node_id) {
      return { result: "refused", reason: "token_node_mismatch", existingNet: existing?.network_id ?? null, callerNet };
    }
    if (token?.network_id && _norm(token.network_id) !== _norm(callerNet)) {
      return { result: "refused", reason: "cross_network", existingNet: existing?.network_id ?? null, callerNet };
    }
  }
  if (existing?.owner_user_id && input.callerUserId !== existing.owner_user_id) {
    return { result: "refused", reason: "owner_mismatch", existingNet: existing.network_id, callerNet };
  }

  // Legacy / first-write paths: row missing OR network_id NULL → claim.
  const isLegacy = !existing
    || existing.network_id === null
    || existing.network_id === undefined;
  const sec1Ok = isLegacy || _norm(existing.network_id) === _norm(callerNet);

  if (!sec1Ok) {
    console.warn(
      `[commhub] 🚫 report_status cross-network node upsert refused: caller-net=${callerNet ?? "default"} existing-net=${existing!.network_id} node_id=${input.node_id}`,
    );
    return {
      result: "refused",
      reason: "cross_network",
      existingNet: existing!.network_id,
      callerNet,
    };
  }

  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, runtime, model, config_path, channels, server, hostname, network_id, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, datetime('now'))
     ON CONFLICT(node_id) DO UPDATE SET
       node_name = COALESCE(?2, nodes.node_name),
       alias = COALESCE(?3, nodes.alias),
       runtime = COALESCE(?4, nodes.runtime),
       model = COALESCE(?5, nodes.model),
       config_path = COALESCE(?6, nodes.config_path),
       channels = COALESCE(?7, nodes.channels),
       server = COALESCE(?8, nodes.server),
       hostname = COALESCE(?9, nodes.hostname),
       network_id = COALESCE(?10, nodes.network_id),
       updated_at = datetime('now')`,
    [
      input.node_id,
      input.node_name ?? input.alias ?? null,
      input.alias ?? null,
      input.runtime ?? null,
      input.model ?? null,
      input.config_path ?? null,
      input.channels ?? null,
      input.server ?? null,
      input.hostname ?? null,
      callerNet ?? null,
    ],
  );
  const trustedSnapshot = trustedConfigSnapshotForNode(
    input.config_snapshot,
    input.callerTokenId,
    input.node_id,
  );
  if (trustedSnapshot) {
    // RFC-026 §9.3 / #338 PR2+PR3 — promote daemon self-declare fields
    // to first-class indexable columns alongside the snapshot blob.
    // The snapshot stays the source of truth for non-list reads; the
    // columns exist so `list_host_supervisors` doesn't JSON.parse on
    // every call. typeof-narrow per
    // per team rule (typeof-narrow extracted JSON fields at the boundary) — zod narrowed but
    // input.config_snapshot is typed `unknown` here.
    //
    // PR3 nit ①: read from nested `daemon_capabilities.*` (canonical
    // per RFC §9.3 + matches existing hub create_node reads at
    // tools.ts:2010/2075). PR2 ate from top-level keys, which the
    // hub create_node path never read → max_concurrent_children
    // backpressure was dead config + allowlist enforcement bypassed.
    const snap = trustedSnapshot as Record<string, unknown> | null;
    const caps = (snap?.daemon_capabilities ?? null) as Record<string, unknown> | null;
    const runtimesRaw = caps?.runtimes_supported;
    const allowedRaw = caps?.allowed_secret_keys;
    const runtimesJson = Array.isArray(runtimesRaw) && runtimesRaw.every(s => typeof s === "string")
      ? JSON.stringify(runtimesRaw)
      : null;
    const allowedJson = Array.isArray(allowedRaw) && allowedRaw.every(s => typeof s === "string")
      ? JSON.stringify(allowedRaw)
      : null;
    db.run(
      `UPDATE nodes SET config_snapshot = ?1, runtimes_supported = ?2, allowed_secret_keys = ?3 WHERE node_id = ?4`,
      [JSON.stringify(trustedSnapshot), runtimesJson, allowedJson, input.node_id],
    );
    // RFC-024 — finalize any pending/restarting update whose target
    // patch is now reflected in the snapshot. Closes the
    // restart-required-never-reaches-applied gap that 通信牛 caught:
    // the old child acks `restarting` + exits 75; the new child boots,
    // reads the new config, reports status — but never had the
    // update_id to call ack_config_update(applied) itself. Hub does
    // it on the new child's behalf by content-matching the patch
    // against the reported snapshot.
    finalizePendingMatchingUpdates(input.node_id, trustedSnapshot);
  }
  // RFC-026 §2.5 step 4 — on every register/report_status, opportunistically
  // close out any pending create_node request whose child_name matches
  // this incoming alias. Same content-match pattern as RFC-024's
  // finalizePendingMatchingUpdates; the new child doesn't have the
  // request_id, so hub does the matching on its behalf.
  try {
    finalizeCreateOnFirstRegister({
      node_id: input.node_id,
      alias: input.alias || input.node_name || "",
      network_id: input.callerNetworkId ?? null,
    });
  } catch (e: any) {
    // create-node finalize is best-effort — never block report_status
    // on it. Log + continue.
    console.warn(`[commhub] create-node finalize on report_status failed: ${e?.message || e}`);
  }
  return { result: existing ? "updated" : "inserted", node_id: input.node_id };
}

/**
 * RFC-024 restart-finalize (Option A per 通信牛 final review).
 *
 * Called from `upsertNodeWithSec1Guard` after writing a fresh
 * `config_snapshot` for the node. For each pending/restarting update
 * row, parse the patch and compare every field against the snapshot.
 * If everything in the patch is now reflected in the live snapshot,
 * mark the update applied + bump `nodes.config_revision`. The new
 * child doesn't need to know the update_id — content-matching against
 * the live state IS the proof that the apply landed.
 *
 * Edge cases:
 *   - Empty patch (apply_mode=restart_only from `restart_node` tool) →
 *     ANY snapshot matches (the restart itself was the goal).
 *   - Patch field absent from snapshot → not a match (snapshot
 *     post-dates the apply only when every requested field shows up).
 *   - Multiple concurrent pending rows → impossible by single-flight,
 *     but defensive: finalize OLDEST first so the chain stays linear.
 *
 * Pure-ish: takes a snapshot blob (TS shape, see config-snapshot type)
 * and runs only db.run / db.get. No external IO.
 */
export function finalizePendingMatchingUpdates(
  nodeId: string,
  snapshot: any,
): { finalizedCount: number; finalizedIds: string[] } {
  const pending = db.all<{
    update_id: string;
    patch_json: string;
    apply_mode: string;
    base_revision: number;
  }>(
    "SELECT update_id, patch_json, apply_mode, base_revision FROM node_config_updates WHERE node_id = ?1 AND status IN ('pending', 'restarting') ORDER BY created_at ASC",
    nodeId,
  );
  if (pending.length === 0) return { finalizedCount: 0, finalizedIds: [] };

  const snapModel: string | null | undefined = snapshot?.model;
  const snapFlags: Record<string, unknown> = (snapshot?.flags && typeof snapshot.flags === "object") ? snapshot.flags : {};
  // #260 P5 — snapshot.channels is the (sorted, bare-type) channel set
  // the node currently has forked. agent-node's buildConfigSnapshot
  // always emits it (even as []), so the "absent field" case here means
  // an older pre-#260-P5 agent-node — for those, don't finalize a
  // channels-carrying patch (would false-positive on the OTHER fields).
  const snapChannelsPresent = Array.isArray(snapshot?.channels);
  const snapChannels: string[] = snapChannelsPresent
    ? (snapshot.channels as unknown[]).filter((c): c is string => typeof c === "string")
    : [];

  const finalizedIds: string[] = [];

  for (const row of pending) {
    let patch: any = {};
    try { patch = JSON.parse(row.patch_json); } catch { continue; }

    let matches = true;
    // restart_only / empty patch → any snapshot proves the restart
    // happened, finalize unconditionally.
    if (row.apply_mode !== "restart_only") {
      if (patch.model !== undefined) {
        if (snapModel !== patch.model) { matches = false; }
      }
      if (matches && patch.flags && typeof patch.flags === "object") {
        for (const [k, v] of Object.entries(patch.flags as Record<string, unknown>)) {
          // Canonical-key fallback for legacy aliases. The dashboard
          // schema uses `budget` and `timeout`; node-side config may
          // also carry the older `maxBudgetUsd` / `claudeTimeoutMs` /
          // `codexTimeoutMs` keys. agent-node's buildConfigSnapshot
          // only reports the canonical key, so we just compare on `k`.
          if (snapFlags[k] !== v) { matches = false; break; }
        }
      }
      // #260 P5 — channels field content-match. Without this the
      // node's very first startup report_status matches (patch.flags
      // is `{}` for a channels-only update, so the flags loop is
      // trivially satisfied) and hub prematurely marks the update
      // applied, deleting the pending row + bumping config_revision
      // BEFORE the doorbell reaches the child. Codex catch on PR #411.
      //
      // Set-equality is enough because the patch side comes from
      // narrowChannelsPatch → already deduped + case-folded + in
      // EDITABLE_CHANNELS iteration order; the snapshot side comes
      // from buildConfigSnapshot which mirrors the same shape.
      if (matches && Array.isArray(patch.channels)) {
        if (!snapChannelsPresent) {
          // Pre-#260-P5 agent-node — no channels field in snapshot,
          // so we can't prove the apply landed. Skip finalize; hub's
          // F-B reaper still supersedes this eventually.
          matches = false;
        } else {
          const wanted = new Set<string>(patch.channels);
          const have = new Set<string>(snapChannels);
          if (wanted.size !== have.size) {
            matches = false;
          } else {
            for (const w of wanted) {
              if (!have.has(w)) { matches = false; break; }
            }
          }
        }
      }
    }

    if (!matches) continue;

    // Promote nodes.config_revision atomically with the update row.
    const nextRev = (db.get<{ config_revision: number }>(
      "SELECT config_revision FROM nodes WHERE node_id = ?1",
      nodeId,
    )?.config_revision || 0) + 1;
    db.run(
      "UPDATE node_config_updates SET status = 'applied', acked_at = ?1, new_revision = ?2 WHERE update_id = ?3 AND status IN ('pending', 'restarting')",
      [Date.now(), nextRev, row.update_id],
    );
    db.run("UPDATE nodes SET config_revision = ?1 WHERE node_id = ?2", [nextRev, nodeId]);
    finalizedIds.push(row.update_id);
    console.log(
      `[commhub] ✓ finalize update ${row.update_id} via report_status content-match: node=${nodeId} new_revision=${nextRev} apply_mode=${row.apply_mode}`,
    );
  }

  return { finalizedCount: finalizedIds.length, finalizedIds };
}
