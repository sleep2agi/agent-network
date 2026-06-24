// Pure helper — decide whether a goal-wake LLM response declares the goal
// complete.
//
// 2026-06-24 root-cause: the previous inline regex in cli.ts was
//   /目标已完成|goal completed|completed/i
// The bare `completed` branch fired on ANY occurrence of "completed" in
// the agent's progress report — including the structural "Completed: ..."
// or "X tasks completed" prose that Claude (agent-sdk) emits regularly
// under the wake-prompt requirement #3 ("已完成、进行中、风险、下一步").
// One match → g.status="complete" → the scheduler skips this goal
// forever and the loop stops after the first wake.
//
// Fix: only treat an explicit single-line sentinel as completion.
// Either:
//   - 中文 sentinel "目标已完成" alone on its own line, or
//   - English sentinel "GOAL_COMPLETE" / "GOAL COMPLETE" alone on its
//     own line (case-sensitive — the wake prompt asks for this literal).
//
// Whitespace-around-line is tolerated. The sentinel may appear at the
// very start of the text or after any newline; it may end the text or
// be followed by a newline. Surrounding lines (preamble / followup
// commentary) don't matter.

const COMPLETION_SENTINEL_RE =
  /(^|\n)\s*(目标已完成|GOAL_COMPLETE|GOAL COMPLETE)\s*(\n|$)/;

/**
 * Returns true when `text` contains an explicit goal-complete sentinel
 * on its own line. Returns false for normal progress reports — even
 * those containing "completed", "Completed:", "已完成 X 项", etc., as
 * long as no sentinel line appears.
 */
export function isGoalCompleteSentinel(text: string | null | undefined): boolean {
  if (!text) return false;
  return COMPLETION_SENTINEL_RE.test(text);
}
