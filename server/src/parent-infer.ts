// #669 —— 父任务**推断**的收窄：从「取最近一条 delivered」改成「候选唯一且在窗口内」。
//
// ## 为什么收窄，而不是取消
//
// 生产实测（近 7 天，`meta_json.parent_source`）：
//
//     inferred  795 条（78% 的有父任务派发靠推断）
//     explicit  222 条
//
//   inferred 非正常收尾 48/795 = **6.0%**（expired 43 + failed 17 + cancelled 5 里与 expired 合并计）
//   explicit 非正常收尾  1/222 = **0.5%**
//
// ⇒ 取消会让 795 条/周失去父链（不可接受）；但 12 倍的失败率说明它确实在挂错父任务
//   （子任务回复提前关掉那条还没开始的 delivered）。
//
// ## 收窄的两条约束
//
//   ① **候选必须唯一**：该节点名下 `delivered` 的条数 == 1。多于一条时无法判断
//      「你要接的是哪一条」，而挑最近一条正是挂错的来源。
//   ② **必须在窗口内**：那条 delivered 的 `created_at` 距今 ≤ INFER_WINDOW_MS。
//      太旧的 delivered 更可能是「排在后面还没轮到」的，而不是「刚派给我、我正在做」的。
//
// 两个常量都可改；改完的效果由 `inferred_rejected` 计数与 7 天后的失败率对比来读。
//
// ## 为什么每一条拒绝都要计数
//
// 收窄是**减少**推断，而「减少」在派发日志里不留痕：任务照常派出，只是没有父。
// 没有计数时，「收窄了多少」与「收窄没生效」同形——两者的 7 天失败率都会下降。

export const INFER_WINDOW_MS = 10 * 60_000;

export interface InferRejection {
  /** 被拒绝的原因：候选不唯一 / 候选太旧 */
  reason: "ambiguous_candidates" | "candidate_too_old";
  /** 候选条数（不唯一时 >1；太旧时 ==1） */
  candidates: number;
  /** 最近那条候选的年龄（毫秒，未知时 null） */
  age_ms: number | null;
}

const counters = {
  accepted: 0,
  rejected_ambiguous: 0,
  rejected_too_old: 0,
  since: new Date().toISOString(),
};

export function noteInferAccepted(): void {
  counters.accepted += 1;
}

export function noteInferRejected(r: InferRejection): void {
  if (r.reason === "ambiguous_candidates") counters.rejected_ambiguous += 1;
  else counters.rejected_too_old += 1;
}

export interface InferCounters {
  since: string;
  /** 推断成功挂上父任务的次数 */
  accepted: number;
  /** 因候选不唯一而放弃推断 */
  rejected_ambiguous: number;
  /** 因候选太旧而放弃推断 */
  rejected_too_old: number;
  window_ms: number;
}

export function parentInferCounters(): InferCounters {
  return {
    since: counters.since,
    accepted: counters.accepted,
    rejected_ambiguous: counters.rejected_ambiguous,
    rejected_too_old: counters.rejected_too_old,
    window_ms: INFER_WINDOW_MS,
  };
}

/** 裁定：候选列表（按 created_at DESC 排好）+ 现在的时间 ⇒ 是否推断、以及为什么。 */
export function decideParentInference(
  candidates: Array<{ task_id: string; created_at_ms: number | null }>,
  now: number,
  windowMs: number = INFER_WINDOW_MS,
): { ok: true; task_id: string } | { ok: false; rejection: InferRejection } {
  if (candidates.length === 0) {
    // 没有候选不是「拒绝」，是「本来就不该推断」—— 由调用方决定要不要记。
    return { ok: false, rejection: { reason: "ambiguous_candidates", candidates: 0, age_ms: null } };
  }
  if (candidates.length > 1) {
    const newest = candidates[0]?.created_at_ms ?? null;
    return { ok: false, rejection: {
      reason: "ambiguous_candidates", candidates: candidates.length,
      age_ms: newest === null ? null : Math.max(0, now - newest),
    } };
  }
  const only = candidates[0]!;
  const age = only.created_at_ms === null ? null : Math.max(0, now - only.created_at_ms);
  // 年龄未知时**不推断**：无法证明它「刚派不久」，而正是这个条件在防挂错。
  if (age === null || age > windowMs) {
    return { ok: false, rejection: { reason: "candidate_too_old", candidates: 1, age_ms: age } };
  }
  return { ok: true, task_id: only.task_id };
}

/** 只在测试里用。 */
export function __resetParentInferForTest(): void {
  counters.accepted = 0;
  counters.rejected_ambiguous = 0;
  counters.rejected_too_old = 0;
  counters.since = new Date().toISOString();
}
