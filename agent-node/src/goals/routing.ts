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
 * also contains a scheduler interval. Put the deterministic notice first so
 * the outer 2000-character reply cap cannot truncate it from a long model
 * response.
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
  return `${DASHBOARD_CODEX_GOAL_INTERVAL_NOTICE}\n\n${replyText}`;
}

/** Compose the visible goal notice before applying the ordinary reply filter. */
export function prepareDashboardCodexGoalReply(
  replyText: string,
  content: string,
  runtime: GoalRoutingRuntime,
  interactiveDashboardTask: boolean,
  failed: boolean,
  isLowValueReply: (text: string) => boolean,
): { text: string; shouldDeliver: boolean } {
  const text = appendDashboardCodexGoalNotice(
    replyText,
    content,
    runtime,
    interactiveDashboardTask,
    failed,
  );
  return { text, shouldDeliver: failed || !isLowValueReply(text) };
}
