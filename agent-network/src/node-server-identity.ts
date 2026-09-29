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
