// Board #668 — task text limits shared by hub and node.
//
// This file is byte-identical in server/src/shared/task-content-limit.ts and
// agent-node/src/shared/task-content-limit.ts (task-content-limit-drift.test.ts
// fails the build on any difference).
//
// TASK_CONTENT_MAX is the cap every dispatch entry (send_task, REST /api/task,
// scheduled tasks) and report_status.task accept. The node reports the whole
// task text so the hub can match it against tasks.content and write
// started_at. If the dispatch cap grew without the node and report_status
// following, long tasks would silently stop matching again.
//
// SESSION_TASK_PREVIEW_MAX is what the hub keeps in sessions.task. That column
// is readable by get_all_status, the full /api/status and members who may see
// the agent but not its conversations, so only a short preview is stored —
// the full text is used for matching, never persisted on the session row.

export const TASK_CONTENT_MAX = 10_000;

export const SESSION_TASK_PREVIEW_MAX = 200;

/** The preview stored in sessions.task — same cut as the dispatch preview. */
export function sessionTaskPreview(task: string): string {
  return task.slice(0, SESSION_TASK_PREVIEW_MAX);
}
