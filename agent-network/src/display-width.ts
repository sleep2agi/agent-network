/**
 * 终端里的**显示列宽** —— CJK 字符占 2 列,而 `String.length` / `padEnd` 只数码元。
 *
 * 🔴 这份知识仓里本来就有,但它只活在**一个测试文件**里
 * (`daemon-capability-display.test.ts` 的 `displayWidth`,2026-08-30 由 macOS 真机
 * 上「合成首行约 99 列、80 列终端折行且折点落在句子中间」催生)。
 * 生产代码没有它,于是所有用 `padEnd` 对齐的表在中文别名下都是歪的。
 *
 * 实测(2026-08-31,`anet node ls` 对着一支全中文别名的军团):
 *
 *   NAME                 RUNTIME        STATUS
 *   ──────────────────── ────────────── ────────
 *   通信工程马                claude-code-cli idle      ← RUNTIME 列起点
 *   通信IM马                claude-code-cli idle       ← 不一样
 *   通信SDK牛               codex-sdk      idle        ← 又不一样
 *
 * `通信工程马`.length 是 5,`padEnd(20)` 补 15 个空格 —— 但它渲染出来是 10 列,
 * 于是这一行实际占 25 列而不是 20。**别名里 CJK 越多,歪得越远。**
 */

// 与 daemon-capability-display.test.ts 里那份**逐字相同**的判据 —— 有意不"改进"它:
// 那份已经被一条 80 列的常驻断言用着,两处分头演化会让它们对同一个字符给出不同答案。
const WIDE = /[⺀-꓏가-힣豈-﫿︰-﹏＀-￯]/;

export function displayWidth(s: unknown): number {
  if (typeof s !== "string") return 0;
  let n = 0;
  for (const ch of s) n += WIDE.test(ch) ? 2 : 1;
  return n;
}

/**
 * 按**显示列**右补空格。已经不短于目标宽度时原样返回(与 `padEnd` 一致,不截断)。
 *
 * 🔴 不截断是有意的:截断会引出「截到一半的宽字符」这个新问题,
 *    而调用方要的只是对齐。**一个修对齐的改动不该顺手引入截断语义。**
 */
export function padDisplayEnd(s: unknown, width: number): string {
  const str = typeof s === "string" ? s : "";
  const w = Number.isFinite(width) && width > 0 ? Math.floor(width) : 0;
  const cur = displayWidth(str);
  return cur >= w ? str : str + " ".repeat(w - cur);
}
