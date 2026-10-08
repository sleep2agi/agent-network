// #478 —— tools/list 按调用者给:只列这个令牌真能用的工具。
//
// 以前每个调用者拿到同一份 ~71 KB 的 tools/list:Agent 节点看见只有人能用的工具(项目管理、浏览别的节点的文件 / 日志),
// 人看见只有节点能用的心跳和 agent-node / daemon 之间的协议工具。这些调用本来就会被拒,只是白白占模型的上下文。
//
// 🔴 只改「列出来的」,不改「能不能调」:工具照旧全部注册,tools/call 的结果逐字节不变(隐藏的工具照样回它今天回的那个错误)。
// 🔴 只藏「一定会被拒」的:判据是处理函数里**不看参数**的那道闸 —— 用户令牌调节点工具一律 network_token_required /
//    node_token_required / caller_not_a_daemon;节点令牌调人的工具一律 user_token_required / node_token_cannot_*;
//    #487 的节点权限只在「不看参数就必拒」时才藏(见 nodeHidden)。看参数才决定的(派活给谁、哪个网络)一律照列。
//    受限成员(只看授权 Agent)的拒绝取决于传的 network_id,所以不按它藏。
// 🔴 protocol 类(agent-node / anet daemon 和 Hub 之间的拉取 / 确认)节点令牌能调,但没有模型该调它们:默认不列,
//    客户端带 `X-Anet-Tools: all`(或 /mcp?tools=all)时照列 —— 调用不受影响,agent-node 本来就按名字直接调、从不 list。
// 新注册的工具必须在 TOOL_AUDIENCE 里归类(tool-audience-http.test.ts 钉住,漏了就红)。

import { NODE_TOOL_CLASS, nodeIdentity, nodePermissionsFlag, broadcastVerdict, humanOnlyVerdict, writeVerdict, type Verdict } from "./node-permissions.js";

/**
 * both     —— 人和节点都能调(按参数 / 网络再判的,也算这一类)。
 * node     —— 只有节点令牌(用户令牌一律 network_token_required):节点自己的心跳,模型会调,照列给节点。
 * protocol —— 只有节点令牌,而且是 agent-node / daemon 和 Hub 之间的协议(拉请求、确认、运行证据):默认不列,opt-in 才列。
 * user     —— 只有人(节点令牌一律被拒)。
 */
export type ToolAudience = "both" | "node" | "protocol" | "user";

export const TOOL_AUDIENCE: Readonly<Record<string, ToolAudience>> = {
  request_adopt_node: "user", unadopt_node: "user",
  get_adopt_request: "protocol", ack_adopt_request: "protocol",
  // ── 节点:用户令牌一律 network_token_required ──
  report_status: "node", org_whoami: "node",
  // #733 定时任务:节点工具(用户令牌一律 network_token_required;人走 REST /api/scheduled-tasks)
  schedule_list: "node", schedule_get: "node", schedule_create: "node", schedule_update: "node",
  schedule_cancel: "node", schedule_run_now: "node", schedule_runs: "node", schedule_batch_interval: "node",
  // ── 协议:用户令牌一律 network_token_required / node_token_required / caller_not_a_daemon ──
  mark_tasks_runtime_submitted: "protocol", mark_tasks_consumed: "protocol",
  get_config_update: "protocol", ack_config_update: "protocol",
  get_rules_file_request: "protocol", ack_rules_file_request: "protocol",
  list_my_pending_create_requests: "protocol", list_my_pending_lifecycle_requests: "protocol", list_my_children: "protocol",
  get_create_request: "protocol", ack_create_request: "protocol",
  get_stop_request: "protocol", ack_stop_request: "protocol",
  get_start_request: "protocol", ack_start_request: "protocol",
  get_probe_request: "protocol", ack_probe_request: "protocol",
  // ── 人:节点令牌一律 user_token_required(项目管理)/ node_token_cannot_browse_files / node_token_cannot_read_logs ──
  projects_create: "user", projects_update: "user",
  list_node_files: "user", read_node_file: "user", tail_node_logs: "user",
  // ── 两边都能调 ──
  submit_skill: "both", list_skills: "both", get_skill: "both", review_skill: "both",
  report_completion: "both", get_inbox: "both", ack_inbox: "both",
  get_all_status: "both", get_session_status: "both",
  send_task: "both", send_message: "both", send_reply: "both", send_peer_reply: "both", send_ack: "both",
  retry_task: "both", get_task: "both", list_tasks: "both", cancel_task: "both", reassign_task: "both",
  send_desktop_message: "both", broadcast: "both", get_completions: "both",
  update_node_config: "both", read_node_rules_file: "both", write_node_rules_file: "both",
  list_node_skills: "both", read_node_skill: "both", get_rules_file_result: "both",
  restart_node: "both", list_host_supervisors: "both", create_node: "both", stop_node: "both", delete_node: "both", start_node: "both",
  upsert_network_secret: "both", list_network_secrets: "both", upsert_provider: "both", update_provider: "both",
  list_providers: "both", probe_provider_model: "both", get_probe_results: "both",
  requirements_list: "both", requirements_people: "both", requirements_get: "both", requirements_create: "both",
  requirements_update: "both", requirements_checklist_toggle: "both", requirements_upsert_by_external_ref: "both",
  requirements_events: "both", requirements_comment: "both", projects_list: "both",
};

/** 调用者:节点令牌(绑定网络)/ 用户令牌 / 没有身份(旧的全局令牌、未开鉴权)—— 最后一种什么都不藏。 */
export type ToolCaller =
  | { kind: "node"; tokenId: string | null; networkId: string | null; includeProtocol: boolean }
  | { kind: "user"; includeProtocol: boolean }
  | { kind: "unknown" };

/** #487 的判定里「不看参数就必拒」的那几类;和 nodeDecide 同一规则(显式模式恒拒,其余看开关),只是不记日志。 */
function nodeHidden(name: string, verdictFor: (cls: string) => Verdict): boolean {
  const cls = NODE_TOOL_CLASS[name];
  if (cls !== "broadcast" && cls !== "node_write" && cls !== "human_only") return false;
  const v = verdictFor(cls);
  if (!v) return false;
  if (v.reason === "mode_readonly" || v.reason === "mode_restricted_not_assigned") return true;
  return nodePermissionsFlag() === "enforce";
}

/** 这个调用者的 tools/list 里留哪些。没归类的工具一律留下(宁可多列;测试保证不会有没归类的)。 */
export function listedToolFilter(caller: ToolCaller): (name: string) => boolean {
  if (caller.kind === "unknown") return () => true;
  if (caller.kind === "user") return name => { const a = TOOL_AUDIENCE[name]; return a !== "node" && a !== "protocol"; };
  const id = caller.tokenId && caller.networkId ? nodeIdentity(caller.tokenId, caller.networkId) : null;
  const verdictFor = (cls: string): Verdict => {
    if (!id) return null;
    if (cls === "broadcast") return broadcastVerdict(id);
    if (cls === "node_write") return writeVerdict(id);
    return humanOnlyVerdict(id);
  };
  return name => {
    const a = TOOL_AUDIENCE[name];
    if (a === "user") return false;
    if (a === "protocol" && !caller.includeProtocol) return false;
    return !nodeHidden(name, verdictFor);
  };
}

/**
 * 给一个已经注册完工具的 McpServer 换上按调用者过滤的 tools/list。只包 tools/list 的处理函数(先跑 SDK 原来的、
 * 再滤掉不列的),tools/call 不碰。SDK 的处理函数表是内部字段:取不到就不滤(宁可多列),测试会红。
 */
export function scopeToolsList(server: unknown, keep: (name: string) => boolean): void {
  const handlers = (server as { server?: { _requestHandlers?: Map<string, (req: unknown, extra: unknown) => unknown> } }).server?._requestHandlers;
  const inner = handlers?.get("tools/list");
  if (!handlers || !inner) return;
  handlers.set("tools/list", async (req: unknown, extra: unknown) => {
    const result = await inner(req, extra) as { tools?: Array<{ name: string }> };
    return Array.isArray(result?.tools) ? { ...result, tools: result.tools.filter(t => keep(t.name)) } : result;
  });
}

/** 客户端要不要看协议工具:`X-Anet-Tools: all` 或 /mcp?tools=all。 */
export function wantsAllTools(req: Request, url: URL): boolean {
  return (req.headers.get("x-anet-tools") ?? "").trim().toLowerCase() === "all" || url.searchParams.get("tools") === "all";
}
