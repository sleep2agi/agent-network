import type { OwnedFollowUpReceiptEntry } from "./receipt-ledger";

export type FollowUpHubState = "pending" | "terminal" | "unknown";

/** A follow-up's input context stays on its owner turn even during answer shaping.
 * Never infer an explicit reply from the owner's final text or an inbox ACK.
 * The caller reads get_task through its existing node-authenticated Hub client.
 */
export function decideFollowUpHubState(
  entry: OwnedFollowUpReceiptEntry,
  payload: unknown,
  nodeId: string,
): FollowUpHubState {
  if (!nodeId || !payload || typeof payload !== "object") return "unknown";
  const response = payload as { ok?: unknown; task?: Record<string, unknown> };
  const task = response.task;
  if (response.ok !== true || !task || task.task_id !== entry.taskId ||
      task.to_node_id !== nodeId || task.thread_id !== entry.threadId ||
      task.turn_id !== entry.ownerTurnId || !task.consumed_at) return "unknown";
  if (["replied", "failed", "cancelled", "expired"].includes(String(task.status))) return "terminal";
  if (["created", "delivered", "acked", "running"].includes(String(task.status))) return "pending";
  return "unknown";
}
