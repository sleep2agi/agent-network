/**
 * #3001 —— 「等子任务」时的轮询纪律。
 *
 * 为什么单独立成模块：这段文字以前散落在 cli.ts 的两个提示模板里，只有一句
 * 「用 get_task 轮询子任务直到 replied/failed」，**没有任何间隔约定**。
 * agent 于是把它理解成「一轮接一轮地打」。
 *
 * 实测（2026-10-29 16:00Z → 10-30 01:00Z，TMW微软欧）：
 *
 *     每小时 get_task：256 / 565 / 647 / 703 / 770 / 855 / 893 / 972 / 736
 *     ⇒ 约 13 次/分钟、连续 8 小时、合计约 6000 次
 *
 * 而每次 `get_task` 都是一整轮 LLM 调用 —— 这 6000 次没有推进任何工作，
 * 只是在问「好没好」。子任务的最终结果本来就会通过 parent_task_id 自动 chain 回上游，
 * 所以「不盯着」不会丢结果。
 *
 * 抽出来的目的和 sse-recovery-guidance 一样：**提示词也要能被断言钉住**，
 * 否则改回一句「轮询直到完成」，测试全绿而行为退回原样。
 */
export const POLL_DISCIPLINE_HEADING = "【轮询纪律】";

export const POLL_DISCIPLINE_LINES: readonly string[] = [
  POLL_DISCIPLINE_HEADING,
  "- 等子任务时不要连环调 get_task。实测（2026-10-29/30）：一个节点在空闲等待里以约 13 次/分钟",
  "  连续拉了 8 小时 get_task（约 6000 次），每次都是一轮 LLM —— 成本全花在「看有没有好」。",
  "- 间隔至少 60 秒；子任务要跑很久时，可以隔几分钟看一次。你不需要盯着它。",
  "- 子任务的最终结果本来就会自动 chain 回上游（parent_task_id），所以「没盯着」不会丢结果。",
];

/** 工具清单里那一行的措辞（与正文同源，避免一处改了另一处没改）。 */
export const GET_TASK_TOOL_LINE =
  "- mcp__commhub__get_task(task_id) — 查子任务状态；**两次之间至少隔 60 秒**（见下方【轮询纪律】）。";

/** 协作流程第 3 步的两行。 */
export const POLL_STEP_LINES: readonly string[] = [
  "3. 用 get_task 查子任务状态，直到 status=replied/failed —— **但两次之间至少隔 60 秒**，",
  "   见下方【轮询纪律】：每次 get_task 都是一整轮 LLM 调用，连续打等于把一个等待烧成几百轮推理。",
];
