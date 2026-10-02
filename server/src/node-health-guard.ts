// #460(#448 的子项)—— 降级节点拒收新任务。
//
// 现场:节点在 Hub 上 idle / in_flight=0,实际 app-server 端口没人听、TUI 变成 `sleep infinity`、
// 或登录态 revoked —— 派过去的任务**静默排队**,谁都不知道它永远不会被执行。agent-node .94 起
// 把这几层报上来(report_status.health,node-health-store.ts 只存内存、10 分钟 TTL);这里在**派发**
// 那一刻读它:新鲜的健康报告说某一层坏了,就直接拒,带上是哪一层、怎么修。
//
// 🔴 只拒「确知坏了」的:没有报告(老 agent-node / claude-code 节点)、报告已过期(>TTL)、
//    或某层没报(比如非共存节点没有 tui)= 不知道 = 放行。宁可像以前一样排队,
//    也不能因为缺数据把一台正常的老节点挡在外面。
// 🔴 只管**新任务派发**(send_task / REST /api/task / 定时任务 / retry / reassign / broadcast)。
//    回复、send_message、ack 不经过这里 —— 降级节点发出的回复照常送达,发给它的普通消息也照常入库。
// 逃生口:用户(不是节点令牌)可以带 force=true 强制派发 —— 比如明知 TUI 不在、但 bridge 能干活。
//    节点令牌不能 force:不让 agent 绕过对另一个 agent 的健康判断。

import { readNodeHealth, type NodeHealth } from "./node-health-store.js";

export type DegradedLayer = {
  layer: "app_server" | "tui" | "model_auth";
  /** 机器可读的原因:app_server 的错误摘要 / tui 的 reason / model_auth 的状态。 */
  reason: string;
  /** 给人看的一句(中文,与 app 的「降级」徽标同一套措辞)。 */
  label: string;
  hint: string;
};

const TUI_LABEL: Record<string, string> = {
  "session-missing": "TUI 会话不在",
  "pane-dead": "TUI 已退出",
  "sleep-placeholder": "TUI 被占位(sleep)",
  "tmux-unavailable": "tmux 不可用",
};

/** 一份健康报告里确知坏掉的层;没报的层不算。 */
export function degradedLayers(health: NodeHealth | null | undefined): DegradedLayer[] {
  if (!health) return [];
  const out: DegradedLayer[] = [];
  if (health.app_server && health.app_server.ok === false) {
    out.push({
      layer: "app_server",
      reason: (health.app_server.last_error || "unreachable").slice(0, 200),
      label: "App Server 断开",
      hint: "节点的 codex app-server 端口没有响应:在节点所在机器上重启该节点(anet node restart <别名>)",
    });
  }
  if (health.tui && health.tui.ok === false) {
    out.push({
      layer: "tui",
      reason: health.tui.reason,
      label: TUI_LABEL[health.tui.reason] ?? "TUI 不可用",
      hint: "共存 TUI 不在运行:在节点所在机器上重新拉起该节点的 TUI(anet node restart <别名>)",
    });
  }
  if (health.model_auth === "revoked" || health.model_auth === "expired") {
    out.push({
      layer: "model_auth",
      reason: health.model_auth,
      label: health.model_auth === "revoked" ? "需要重新登录" : "登录已过期",
      hint: "该节点自己的 CODEX_HOME 需要重新登录(在那台机器上:CODEX_HOME=<节点目录>/codex-home codex login);不要拷别的节点的 auth.json",
    });
  }
  return out;
}

export type HealthGuardResult =
  | { ok: true; forced?: true }
  | {
    ok: false;
    error: "node_degraded";
    alias: string;
    layers: DegradedLayer[];
    message: string;
    hint: string;
    health_observed_ms_ago: number;
    /** 能不能用 force=true 绕过(只有用户令牌能)。 */
    force_allowed: boolean;
  };

/**
 * 派发前的健康门。networkId 用与 report_status 写入时同一个键(sessionNetId = 网络 id ?? "default")。
 * force 只在 forceAllowed(用户令牌)时生效。
 */
export function assertNodeHealthy(
  alias: string,
  networkId: string | null | undefined,
  opts: { force?: boolean; forceAllowed: boolean; now?: number },
): HealthGuardResult {
  if (!alias) return { ok: true };
  const hit = readNodeHealth(networkId ?? "default", alias, opts.now);
  if (!hit) return { ok: true };
  const layers = degradedLayers(hit.health);
  if (!layers.length) return { ok: true };
  if (opts.force && opts.forceAllowed) return { ok: true, forced: true };
  const labels = layers.map(l => l.label).join("、");
  return {
    ok: false,
    error: "node_degraded",
    alias,
    layers,
    message: `节点 ${alias} 处于降级状态(${labels}),任务不会被执行,已拒绝派发。`,
    hint: layers[0].hint + (opts.forceAllowed ? "。确需强制派发可带 force=true。" : ""),
    health_observed_ms_ago: hit.observed_ms_ago,
    force_allowed: opts.forceAllowed,
  };
}
