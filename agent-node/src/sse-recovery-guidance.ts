/**
 * Build the operator guidance emitted when the SSE supervisor gives up.
 *
 * Important lifecycle fact: abandoning the SSE retry loop does not terminate
 * agent-node. The current process (and, for co-presence, its sibling TUI and
 * app-server) remains alive. Telling the operator to run a second generic
 * `anet node start <alias>` therefore creates a duplicate inbox consumer and
 * can also replace a co-presence runtime with a plain runtime.
 *
 * There is no universally correct executable recovery command here: legacy
 * co-presence nodes may have been launched with a dedicated config, while
 * managed nodes may be owned by tmux, systemd, a daemon, or another
 * supervisor. The only safe generic instruction is stop-and-replace through
 * the original owner/launch path.
 */
export function sseAbandonGuidance(alias: string, hubUrl: string): string {
  return [
    `SSE 连续 >1h 连不上 hub (${hubUrl}) — 已停止自动重连。`,
    `当前 agent-node 实例（alias=${alias}）仍在运行；不要另起同 alias 实例，否则会产生重复消费者。`,
    "请先停止当前实例，再通过原 supervisor/service 或本实例的原始启动命令做替换式重启。",
    "共存节点必须保留原 --copresence / 专用 config 启动方式，不能改用通用 node start。",
  ].join(" ");
}
