export type GoalRoutingRuntime = "claude" | "codex" | "grok" | "opencode" | "codex-app-server";

export interface ReplyMessageProvenance {
  messageType: string;
  interactiveDashboardTask: boolean;
}

const ANET_SCHEDULE_COMMAND_RE = /^\s*\/(?:agoal|aloop)\b/i;

export const LEGACY_ANET_SCHEDULE_NOTICE =
  "提示：/goal 和 /loop 仅在非 Dashboard 路径处于兼容期；Agent Network 定时请改用 /aloop <间隔> <任务>。";

export const DASHBOARD_NATIVE_SCHEDULE_NOTICE =
  "提示：此 /goal 或 /loop 已原样交给节点 runtime；如需 Agent Network 定时任务，请用 /aloop <间隔> <任务>。";

/**
 * Select the Agent Network scheduled-goal path.
 *
 * Authenticated Dashboard chat owns the unprefixed vendor command namespace:
 * `/goal` and `/loop` pass through to the target runtime for every runtime
 * bucket. Agent Network commands use `/agoal` and `/aloop` instead.
 *
 * `/goal` and `/loop` always belong to the target runtime, regardless of
 * transport provenance. Only the namespaced `/agoal` and `/aloop` commands
 * select Agent Network scheduling.
 */
export function shouldCreateScheduledGoal(
  content: string,
  _runtime: GoalRoutingRuntime,
  _interactiveDashboardTask: boolean,
): boolean {
  return ANET_SCHEDULE_COMMAND_RE.test(content || "");
}

/** Kept as a compatibility export; native slash replies are never rewritten. */
export function appendLegacyScheduledGoalNotice(
  replyText: string,
  _content: string,
  _interactiveDashboardTask: boolean,
): string {
  return replyText;
}

/**
 * Dashboard `/goal` + `/loop` are native pass-through commands. If an old
 * scheduler-shaped interval is present, say so explicitly after the native
 * turn instead of silently changing `/loop` from ANet scheduling to native
 * runtime behavior. Put the notice first so the outer reply cap retains it.
 */
export function appendDashboardNativeScheduleNotice(
  replyText: string,
  _content: string,
  _interactiveDashboardTask: boolean,
): string {
  return replyText;
}

/** Compose the Dashboard migration notice before ordinary reply filtering. */
export function prepareDashboardNativeSlashReply(
  replyText: string,
  content: string,
  provenance: ReplyMessageProvenance,
  failed: boolean,
  isLowValueReply: (text: string) => boolean,
): { text: string; shouldDeliver: boolean } {
  const { interactiveDashboardTask, messageType } = provenance;
  const text = appendDashboardNativeScheduleNotice(replyText, content, interactiveDashboardTask);
  // The Hub-stamped Dashboard provenance is the authorization fact here; an
  // agent alias or task type alone is not enough to bypass chatter filtering.
  const humanDashboardRequest = interactiveDashboardTask
    && (messageType === "task" || messageType === "broadcast");
  return { text, shouldDeliver: failed || humanDashboardRequest || !isLowValueReply(text) };
}
