/**
 * CLI 里那几张对齐表(`anet status` 的 needs-attention / working,以及 Recent Tasks
 * 和 `anet tasks`)把**用户提供的文本**直接 `slice(0, N)` 塞进一行。
 *
 * 🔴 任务正文里有换行时,截出来的那段会**把整张表打断**。实测(2026-08-31,
 *    真跑 `anet status` 才看见,读代码看不出来):
 *
 *      grok-v1          blocked  【把你自己的名册状态修正过来 —— 两步，别做别的】
 *
 *      你今天两次在 22 秒内答了我的探测（G
 *
 *    第二行完全脱离了对齐,而且读起来像另一个节点的输出。
 *
 * 这里把所有空白(含 \n \r \t 和连续空格)折成单个空格再截。
 *
 * 🔴 **有意不加省略号**:加了会改变列宽,而列宽是这几张表现有的对齐依据。
 *    「截断了却看不出来」是另一个问题(先存在于这里,本次不动),
 *    不要顺手在一个修显示错位的改动里改掉它。
 */
export function oneLineCell(text: unknown, max: number): string {
  const s = typeof text === "string" ? text : "";
  const n = Number.isFinite(max) && max > 0 ? Math.floor(max) : 0;
  // \s 覆盖 \n \r \t \f \v 和普通空格;U+00A0 等不间断空格另加。
  return s.replace(/[\s ]+/g, " ").trim().slice(0, n);
}
