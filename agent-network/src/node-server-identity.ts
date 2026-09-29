// 节点配置(`.anet/nodes/<ALIAS>/config.json`)里 node-server 要报给 hub 的那几格。
//
// 🔴 claude-code-cli 节点在名册里 node_id 全空:`anet node create` 早就把 node_id 写进了
//    节点配置,但 node-server(这一族唯一长期存活的自有进程)的 report_status 从没带它。
//    hub 只有在 report_status 带 node_id 时才写 nodes 表(`if (node_id) upsertNodeWithSec1Guard`),
//    而定时任务 / 桌面端「选择执行节点」都按 nodes 表选目标 —— 于是这一族在线也选不到。
//    agent-node(codex/opencode/grok/claude-agent-sdk)一直报,来源同样是节点配置。
//
// 只读配置,**不读 COMMHUB_NODE_ID 环境变量**:claude 进程常从别的节点的 shell 里起,
// 继承来的旧值会让这个会话去认领别人的 nodes 行(agent-node 那边也只把 env 当配置缺失时的兜底,#532)。
// 配置里没有就不发这个字段(照旧为空),不编一个。

import { readFileSync } from "node:fs";

export interface NodeIdentityFromConfig {
  node_id?: string;
  node_name?: string;
  model?: string;
}

// 与 hub report_status 的 schema 同一个上限(`node_id: z.string().max(200)`)。
const MAX_LEN = 200;

const field = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s && s.length <= MAX_LEN ? s : undefined;
};

export function nodeIdentityFromConfig(path: string | undefined): NodeIdentityFromConfig {
  if (!path) return {};
  let cfg: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    cfg = parsed as Record<string, unknown>;
  } catch {
    return {};
  }
  const out: NodeIdentityFromConfig = {};
  const nodeId = field(cfg.node_id);
  const nodeName = field(cfg.node_name);
  const model = field(cfg.model);
  if (nodeId) out.node_id = nodeId;
  if (nodeName) out.node_name = nodeName;
  if (model) out.model = model;
  return out;
}

// ── 认领前先看一眼 hub 上这个 node_id 现在是谁的 ──────────────────────────
//
// 🔴 生产实测:一个 claude-code 节点配置里的 node_id,在 hub 上已经是**另一个节点**的行
//    (别名、config_path、runtime 全是那个节点的 —— 配置被拷过 / 手工回填的 id 撞了)。
//    hub 的 upsert 对 alias 是 COALESCE(新值优先),一报就把别人的行改成自己的名字。
//    所以:行存在且别名不是自己 ⇒ 不认领、大声告警(粘住,不每次心跳都刷屏);
//    查不到结论(网络 / hub 出错)⇒ 这一次不报,下一次上报再查 —— 宁可晚几分钟可选,不能改错别人的行。
//    正当的改名由 rename.ts 直接改 nodes.alias,所以「别名不同」从来不是同一个节点要报的形状。

export interface NodeRowLike {
  node_id?: string | null;
  alias?: string | null;
  runtime?: string | null;
  config_path?: string | null;
}

export type NodeIdClaimVerdict =
  | { claim: true }
  | { claim: false; owner: string; runtime: string | null; config_path: string | null };

export function nodeIdClaimVerdict(nodeId: string, rows: readonly NodeRowLike[], alias: string): NodeIdClaimVerdict {
  // 旧 hub 不认 ?node_id= 会回整张表:按 node_id 自己再筛一遍。
  const mine = rows.filter(r => r && r.node_id === nodeId);
  if (mine.length === 0) return { claim: true };
  const other = mine.find(r => (r.alias ?? "") !== "" && r.alias !== alias);
  if (!other) return { claim: true };
  return { claim: false, owner: String(other.alias), runtime: other.runtime ?? null, config_path: other.config_path ?? null };
}

export type NodeIdClaimState = "ok" | "conflict" | "unknown";

/** 取 hub 上这个 node_id 的行并下结论;任何失败都是 "unknown"(调用方这次不报 node_id)。 */
export async function checkNodeIdClaim(opts: {
  hubUrl: string;
  token: string;
  nodeId: string;
  alias: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<{ state: NodeIdClaimState; verdict?: NodeIdClaimVerdict; error?: string }> {
  const f = opts.fetchImpl ?? fetch;
  try {
    const res = await f(`${opts.hubUrl.replace(/\/+$/, "")}/api/nodes?node_id=${encodeURIComponent(opts.nodeId)}`, {
      headers: opts.token ? { Authorization: `Bearer ${opts.token}` } : {},
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
    });
    if (!res.ok) return { state: "unknown", error: `HTTP ${res.status}` };
    const body = await res.json() as { nodes?: unknown };
    if (!body || !Array.isArray(body.nodes)) return { state: "unknown", error: "no nodes array" };
    const verdict = nodeIdClaimVerdict(opts.nodeId, body.nodes as NodeRowLike[], opts.alias);
    return { state: verdict.claim ? "ok" : "conflict", verdict };
  } catch (e: any) {
    return { state: "unknown", error: String(e?.message || e) };
  }
}
