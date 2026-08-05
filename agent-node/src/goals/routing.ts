import { parseGoalCommand } from "./parser";

export type GoalRoutingRuntime = "claude" | "codex" | "grok" | "opencode" | "codex-app-server";

export const DASHBOARD_CODEX_GOAL_INTERVAL_NOTICE =
  "提示：已作为一次性目标处理；要定时请用 /loop <间隔> <任务>。";

/**
 * `/loop` is Agent Network's recurring scheduler command.
 *
 * `/goal` remains its backwards-compatible alias except for an authenticated
 * Dashboard chat targeting a shared Codex TUI. Codex owns `/goal` in that
 * interactive surface, so intercepting it here changes a persistent goal into
 * a recurring loop and rejects ordinary goal text that has no interval.
 */
export function shouldCreateScheduledGoal(
  content: string,
  runtime: GoalRoutingRuntime,
  interactiveDashboardTask: boolean,
): boolean {
  if (/^\s*\/loop\b/i.test(content || "")) return true;
  if (!/^\s*\/goal\b/i.test(content || "")) return false;
  return !(runtime === "codex-app-server" && interactiveDashboardTask);
}

/**
 * Make the narrow Dashboard/Codex semantic split visible when the goal text
 * also contains a scheduler interval. The model reply is preserved verbatim;
 * this deterministic suffix prevents a user from silently expecting a loop.
 */
export function appendDashboardCodexGoalNotice(
  replyText: string,
  content: string,
  runtime: GoalRoutingRuntime,
  interactiveDashboardTask: boolean,
  failed: boolean,
): string {
  if (failed || runtime !== "codex-app-server" || !interactiveDashboardTask) return replyText;
  if (!/^\s*\/goal\b/i.test(content || "")) return replyText;
  if (!parseGoalCommand(content).ok) return replyText;
  return `${replyText}\n\n${DASHBOARD_CODEX_GOAL_INTERVAL_NOTICE}`;
}
