// #519 — an inbox row that agent-node decides NOT to answer must still leave
// the Hub task in a terminal state. Before this, two paths acked the inbox row
// and stopped there, so the task sat in `acked` forever (no patrol touches
// acked) and the record never said why:
//
//   1. inbound filter "self" / "own-prefix" (reply-loop guard) — the turn never
//      ran and nobody could tell;
//   2. a turn that ran but produced a low-value reply ("done.", "✅") — the
//      reply is withheld so two agents don't ping-pong acknowledgements.
//
// Decision (#519): the reply-loop guard stays. A self-sent task is still NOT
// run (see SELF_TASK_CLOSE_REASON for why), but it is now closed as
// `cancelled` with an explicit reason. A low-value reply is closed as
// `replied` through `report_completion`, which writes the result onto the task
// row without inserting an inbox reply — so the sender is not woken, which is
// exactly what the low-value filter exists to avoid.

/** Tool caller: `(tool, args) => parsed JSON payload`. Throws on transport/app error. */
export type HubToolCall = (tool: string, args: Record<string, unknown>) => Promise<any>;

/** Message types that carry a Hub task row (same set the #1900 terminal guard checks). */
export function messageCarriesTask(msgType: string | undefined): boolean {
  const type = msgType || "task";
  return type === "task" || type === "broadcast";
}

export interface InboundSkipInput {
  alias: string;
  from: string;
  content: string;
  msgType?: string;
  /** Feishu bridge rows are sent under the node's own alias on purpose. */
  imBridge: boolean;
  /** Last time this node replied to `from` (ms), for the chatter cooldown. */
  lastReplyAt?: number;
  now: number;
  cooldownMs: number;
  isLowValue: (text: string) => boolean;
}

/**
 * Inbound filter. Returns the skip reason, or null when the row must reach
 * the runtime.
 *
 * "self" / "own-prefix" are the reply-loop guard that has existed since the
 * initial release: a node that answers its own rows answers its own answers.
 */
export function classifyInboundSkip(input: InboundSkipInput): string | null {
  const { alias, from, content, msgType } = input;
  if (from === alias && !input.imBridge) return "self";
  if (content.startsWith(`[${alias}]`)) return "own-prefix";
  const actionable = msgType === "task" || msgType === "broadcast" || msgType === "reply";
  // Don't cooldown explicit tasks — humans often send rapid follow-ups from
  // Dashboard, and terminal peer replies must reach the runtime even when
  // short or rapid. Apply cooldown only to non-actionable chatter.
  if (!actionable && from !== "hub" && from !== "api") {
    if (input.lastReplyAt && input.now - input.lastReplyAt < input.cooldownMs) return "cooldown";
  }
  // Only apply low-value/agent-chatter filter to non-task types. Tasks are
  // explicit human or system requests and must always be processed.
  if (!actionable && input.isLowValue(content)) return "low-value-inbound";
  return null;
}

export const SELF_TASK_CLOSE_REASON =
  "skipped by agent-node: self-sent task (sender is this node; reply-loop guard), no turn ran. "
  + "To wake a node later, use a Hub scheduled task or /aloop instead of send_task to yourself. (#519)";

export const OWN_PREFIX_CLOSE_REASON =
  "skipped by agent-node: task text starts with this node's own reply prefix (echo of its own reply; reply-loop guard), no turn ran. (#519)";

/** Close reason for a filter verdict, or null when the verdict does not close a task. */
export function skipCloseReason(reason: string): string | null {
  if (reason === "self") return SELF_TASK_CLOSE_REASON;
  if (reason === "own-prefix") return OWN_PREFIX_CLOSE_REASON;
  return null;
}

export type CloseOutcome =
  | { kind: "closed"; tool: "cancel_task" | "report_completion" }
  | { kind: "not-closed"; tool: "cancel_task" | "report_completion"; detail: string }
  | { kind: "not-applicable"; detail: string }
  | { kind: "error"; tool: "cancel_task" | "report_completion"; detail: string };

/**
 * Terminalize a task the inbound filter refused to run. `cancelled` (not
 * `failed`): nothing went wrong, the node declined it on purpose. cancel_task
 * writes no inbox row, so this cannot wake anyone — including this node.
 */
export async function closeSkippedTask(
  call: HubToolCall,
  input: { taskId: string; msgType?: string; reason: string },
): Promise<CloseOutcome> {
  const closeReason = skipCloseReason(input.reason);
  if (!closeReason) return { kind: "not-applicable", detail: `reason ${input.reason} does not close a task` };
  if (!messageCarriesTask(input.msgType)) return { kind: "not-applicable", detail: `type ${input.msgType} carries no task` };
  if (!input.taskId) return { kind: "not-applicable", detail: "no task id" };
  try {
    const res = await call("cancel_task", { task_id: input.taskId, reason: closeReason });
    if (res && typeof res === "object" && res.ok === true) return { kind: "closed", tool: "cancel_task" };
    // ok:false = the row was already terminal (or not visible); nothing left open by us.
    return { kind: "not-closed", tool: "cancel_task", detail: JSON.stringify(res ?? null).slice(0, 200) };
  } catch (e: any) {
    return { kind: "error", tool: "cancel_task", detail: String(e?.message ?? e).slice(0, 200) };
  }
}

/**
 * Terminalize a task whose turn ran but whose reply was withheld as low-value.
 * report_completion moves the task to `replied` with the result text and does
 * NOT insert an inbox reply, so the sender is not woken by an acknowledgement.
 */
export async function closeLowValueTask(
  call: HubToolCall,
  input: { alias: string; taskId: string; msgType?: string; result: string },
): Promise<CloseOutcome> {
  if (!messageCarriesTask(input.msgType)) return { kind: "not-applicable", detail: `type ${input.msgType} carries no task` };
  if (!input.taskId) return { kind: "not-applicable", detail: "no task id" };
  const trimmed = input.result.trim();
  const result = `${trimmed || "(empty reply)"} [low-value reply withheld from sender by agent-node (#519)]`.slice(0, 4000);
  try {
    await call("report_completion", { alias: input.alias, task: input.taskId, result });
    return { kind: "closed", tool: "report_completion" };
  } catch (e: any) {
    return { kind: "error", tool: "report_completion", detail: String(e?.message ?? e).slice(0, 200) };
  }
}

export function formatCloseOutcome(taskId: string, outcome: CloseOutcome): string {
  switch (outcome.kind) {
    case "closed": return `closed task ${taskId} via ${outcome.tool} (#519)`;
    case "not-closed": return `task ${taskId} not closed by ${outcome.tool} (already terminal?): ${outcome.detail}`;
    case "not-applicable": return `task ${taskId} left as-is: ${outcome.detail}`;
    case "error": return `failed to close task ${taskId} via ${outcome.tool}: ${outcome.detail}`;
  }
}
