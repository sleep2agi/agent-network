// #213 — grok-build-acp resume hint.
//
// When a grok node resumes an existing session, the grok agent stdio
// session/load replays the whole prior context into the LLM — including
// any "已派 task <id> 等回复" lines from before the node was stopped.
// Critically, the replies for those out-flight tasks are NOT in the
// replayed context (they arrived after the node stopped, or were never
// produced before the stop), so the LLM sees a one-sided "I promised
// but never saw the result" view of the world. The natural LLM response
// is to re-dispatch — exactly the #212 storm shape, just driven from
// inside the LLM's own context window instead of from inbox replay.
//
// The server-side dedup guardrail (#212 commit 1f3ae1e) already catches
// the storm shape after it fires. This module is the upstream nudge:
// on resume's very first prompt, prepend a short note that lists the
// (top-N) out-flight outbound tasks and tells the LLM, in unambiguous
// wording, that it has ALREADY DISPATCHED them and must NOT re-send.
//
// Wording care, per 通信龙: the hint must read as a "do not redo" check
// list, NOT a "to-do" list. The LLM is good at pattern-completing "here
// are some tasks" into "let me redo them"; we have to be explicit that
// these are *outbound* tasks already sent, and the only legitimate
// follow-up is `send_message` (light status query), not `send_task`
// (re-dispatch).

export type OutboundTaskRow = {
  task_id: string;
  to_name: string;
  content: string;
  status?: string;
  created_at?: string;
};

export type ListTasksHook = (params: {
  from_name: string;
  limit: number;
}) => Promise<{ tasks?: OutboundTaskRow[] } | null | undefined>;

export type FetchOptions = {
  /**
   * Maximum entries to keep in the hint. The LLM context is precious
   * and a wall of out-flight tasks just makes the hint look like a
   * to-do list. 10 is more than enough — if a node really has > 10
   * un-resolved outbound dispatches on resume, you have a deeper
   * problem the hint can't fix.
   */
  topN?: number;
  /** Max rows to fetch from `list_tasks` before client-side filter. */
  limit?: number;
};

/**
 * Fetch the outbound tasks this node previously dispatched that are
 * still waiting on a reply (status ∈ {delivered, started}). Returns
 * the most recent first, capped at `topN`. NEVER throws — on any error
 * (timeout, hub unreachable, malformed response), returns an empty
 * array so the caller can safely prepend nothing and let the LLM turn
 * run normally.
 */
export async function fetchUnresolvedOutbound(
  selfAlias: string,
  listTasks: ListTasksHook,
  opts: FetchOptions = {},
): Promise<OutboundTaskRow[]> {
  const limit = Math.max(1, Math.min(100, opts.limit ?? 100));
  const topN = Math.max(1, Math.min(50, opts.topN ?? 10));
  try {
    const resp = await listTasks({ from_name: selfAlias, limit });
    const tasks = Array.isArray(resp?.tasks) ? resp!.tasks! : [];
    return tasks
      .filter(
        (t): t is OutboundTaskRow =>
          !!t &&
          typeof t.task_id === "string" &&
          typeof t.to_name === "string" &&
          (t.status === "delivered" || t.status === "started"),
      )
      .slice(0, topN);
  } catch {
    return [];
  }
}

/**
 * Build the prompt prefix the LLM sees on its first turn after resume.
 * Returns `null` when the list is empty so the caller can skip the
 * prepend (no noise in the typical "everything was settled before
 * shutdown" case).
 *
 * The text is deliberately structured to anchor the LLM on the right
 * semantics:
 *
 *   1. A boxed warning header that names the tasks as ALREADY DISPATCHED.
 *   2. A bulleted list with task id + target + content preview so the
 *      LLM can reason about which specific items are pending without
 *      drowning in detail.
 *   3. An explicit "do NOT re-send" instruction in two forms (Chinese +
 *      English keyword) so it survives prompt-paraphrase.
 *   4. A positive alternative: use `send_message` (cheap status query),
 *      NOT `send_task` (full re-dispatch). The LLM is much less likely
 *      to mis-handle a positive alternative than a bare negative.
 *   5. A reminder that the server has a dedup guardrail — framed as
 *      "do not rely on it", so the LLM doesn't try to "fix" a perceived
 *      dedup over-rejection by altering content slightly.
 */
export function buildResumeHint(outstanding: OutboundTaskRow[]): string | null {
  if (!outstanding.length) return null;

  const items = outstanding
    .map((t, i) => {
      const idShort = String(t.task_id || "?").slice(0, 8);
      const target = String(t.to_name || "?");
      const when = t.created_at ? `, sent ${t.created_at}` : "";
      const preview = previewContent(t.content);
      return `  ${i + 1}. → ${target} [task ${idShort}${when}]: ${preview}`;
    })
    .join("\n");

  return [
    `【⚠ 节点 resume 提醒 — 你停机前已派出但仍在等回复的任务】`,
    ``,
    items,
    ``,
    `重要约束 (do NOT re-dispatch):`,
    `- 上面这些任务 **已经发出去过**, 对方尚未回复。**不要再次** 用 commhub_send_task 发同样内容。`,
    `- 如果需要跟进进度, 用 commhub_send_message(alias=对方, message="任务 <task_id> 进度?") 发一条**轻问询**, **不是** send_task。`,
    `- server 端有自动去重护栏会拒绝重复 send_task, 但请不要靠它兜底 — 直接按上面规则处理。`,
    `- 如果用户现在派的新任务跟上面某条**实质相同**, 直接告诉用户 "task <id> 已派给 <对方>, 仍在等回复, 不重新派", 不要 send_task。`,
  ].join("\n");
}

function previewContent(raw: unknown): string {
  const s = String(raw ?? "")
    .replace(/```/g, "ʼʼʼ") // defang accidental code-fence injection in resumed task content
    .replace(/\s+/g, " ")
    .trim();
  const max = 120;
  return s.length > max ? s.slice(0, max - 3) + "..." : s || "(empty content)";
}
