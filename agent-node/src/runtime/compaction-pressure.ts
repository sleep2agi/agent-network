/**
 * #1645 —— 一次 codex turn 卡死 300s 的真因链里有这一段:
 *
 *   ERROR codex_core::compact_remote: remote compaction failed
 *     last_api_response_total_tokens=195436
 *   ERROR codex_core::session::turn: Failed to run pre-sampling compact
 *
 * 而我们**自己**在 CODEX_CONFIG 里设了 `model_auto_compact_token_limit: 200000`。
 * 195436 是它的 **97.7%** —— 也就是说「这条线程马上要触发 compaction」这件事,
 * 在**上一回合结束时就已经可知**,而实际的第一个信号是 300 秒之后的超时。
 *
 * 🔴 这里**只报压力,不预测失败**。compaction 会不会成功由上游决定,
 *    我们既不知道也不该猜。报的是一个纯事实:**距离我们自己设的那个上限还有多远**。
 *
 * 🔴 而且它必须打在**成功路径**上。一个只在失败时说话的仪表,
 *    警告不了任何人 —— 等它开口时,那 300 秒已经花掉了。
 */

export type CompactionPressure = {
  /** 占已配置上限的百分比,四舍五入到整数 */
  pct: number;
  /** 是否已越过提醒阈值 */
  warn: boolean;
  /** 越过阈值时的一行说明;未越过时为空串(调用方据此不打印) */
  text: string;
};

/**
 * 阈值取 85%。
 *
 * 🔴 这个数是**判断**,不是测量,所以写清它的依据和它不承诺什么:
 *   - 依据:实测那次失败发生在 97.7%;留出一段余量,让提醒出现在**还能做点什么**
 *     的时候(换新线程 / 缩小上下文),而不是在悬崖边上。
 *   - 不承诺:越过 85% **不表示**下一回合一定会失败,更多时候 compaction 会正常完成。
 *     所以它只是一行日志,**不改变任何行为、不影响任何返回值**。
 */
export const COMPACTION_WARN_RATIO = 0.85;

export function compactionPressure(
  inputTokens: unknown,
  limit: unknown,
  warnRatio: number = COMPACTION_WARN_RATIO,
): CompactionPressure {
  const t = typeof inputTokens === "number" && Number.isFinite(inputTokens) && inputTokens > 0 ? inputTokens : 0;
  const l = typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? limit : 0;
  // 🔴 上限拿不到时返回 pct=0 且不提醒 —— 不要拿一个猜的分母算出一个像样的百分比。
  if (l === 0) return { pct: 0, warn: false, text: "" };
  const pct = Math.round((t / l) * 100);
  const warn = t >= l * warnRatio;
  if (!warn) return { pct, warn, text: "" };
  return {
    pct,
    warn,
    text:
      `[codex] ⚠ 上下文压力 ${t}/${l} tokens (${pct}%) —— 越过 ${Math.round(warnRatio * 100)}% 提醒线。` +
      `下一回合可能触发 compaction;它**失败**时的表现是整回合卡到超时(见 #1645),` +
      `而不是一条报错。需要的话现在换条新线程比等超时便宜。`,
  };
}
