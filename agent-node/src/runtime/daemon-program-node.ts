// agent-node/src/runtime/daemon-program-node.ts
//
// #1417 — A daemon (role=host_supervisor) is a pure-program node. Its whole
// job is deterministic node lifecycle — create / stop / restart / delete /
// probe — driven by structured SSE doorbells (RFC-026 create_node, RFC-027
// stop_node, RFC-028 probe_provider) that never touch a model.
//
// Two paths could still drag a model into the daemon; both are gated on this
// same predicate in cli.ts:
//   1. The inbox: a *free-text* task (someone messaged the daemon as if it were
//      an agent) would otherwise run an LLM turn (processTask → processWithClaude
//      → `await import("@anthropic-ai/claude-agent-sdk")`). The inbox guard
//      short-circuits it before processTask.
//   2. The goal scheduler: a goal wake also calls processTask. runGoalSchedulerTick
//      early-returns for a daemon, and the tick is not armed at boot for one —
//      so even a node hot-promoted agent→host_supervisor (RFC-024) with
//      pre-existing active goals stops running LLM turns from promotion onward.
// The claude-agent-sdk import is lazy, so with both paths gated a node born and
// kept as host_supervisor never loads or runs an LLM.
//
// Kept as a small, unit-tested module rather than an inline check inside the
// big CLI script so the "a daemon never invokes the runtime" guarantee has a
// name and a test, and so the role check is an exact-value match (not a shape
// or case-insensitive match that a stray role string could slip through).

export const HOST_SUPERVISOR_ROLE = "host_supervisor";

/**
 * True when a node must NOT run an LLM turn for free-text inbox tasks.
 * Only an exact `host_supervisor` role qualifies; every other role (agent,
 * leader, empty, undefined, differently-cased) falls through to the normal
 * runtime path unchanged.
 */
export function isDaemonPureProgramNode(role: string | undefined | null): boolean {
  return role === HOST_SUPERVISOR_ROLE;
}

/**
 * Deterministic, model-free reply for a free-text task sent to a daemon.
 * Explains what the daemon actually does and where AI help lives, so the
 * sender is not left waiting on a turn that will never run. Pure function of
 * the alias — no clock, no randomness — so it is stable and testable.
 */
export function daemonProgramReply(alias: string): string {
  return [
    `[${alias}] 我是 daemon（host_supervisor 守护进程节点），不运行大模型。`,
    `我只执行结构化的节点生命周期命令：创建 / 停止 / 重启 / 删除 / 探测节点（由 Hub 下发的门铃事件驱动，全程无 AI）。`,
    `自由文本任务我不会调用 AI 去理解。需要 AI 协助，请把任务发给一个 agent 节点，或使用 anet CLI / 客户端里的 AI 助手。`,
  ].join("\n");
}
