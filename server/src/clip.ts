/**
 * 按 UTF-16 长度截断，但**不切断代理对**。
 *
 * 2026-10-31 —— 外部复核（原话）：
 *   「量纲问题的后果不是『长度差 4 倍』，而是 `slice` 会切断代理对
 *     ⇒ 切在代理对中间 ⇒ 孤立 surrogate ⇒ JSON 合法但 UTF-8 非法
 *     ⇒ 后果不是『截短了』，是**审计行本身可能不是合法 UTF-8**，日志管道在那一行炸。」
 *
 * `s.slice(0, n)` 数的是 UTF-16 code unit，而一个 emoji（或任何 BMP 外字符）占两个。
 * 若第 n 个位置正好落在高代理与低代理之间，切出来的字符串含**孤立高代理**：
 *   · JSON.stringify 会把它写成 "\ud83d"（语法上合法）
 *   · 编码成 UTF-8 时被替换成 U+FFFD 或直接报错（取决于运行时）
 *   · 于是同一行日志在不同管道里长得不一样，而 join 用的正是这一串
 *
 * 本函数只在边界上处理：若切点落在代理对中间，就少取一个 code unit，保证输出始终是
 * 「合法 UTF-16 子串」。**它不改变长度上限的语义**（仍然是 ≤ max），只保证不产生孤立代理。
 */
export function clipSafe(value: string, max: number, ellipsis = "…"): string {
  if (!Number.isInteger(max) || max <= 0) return "";
  if (value.length <= max) return value;
  // 留出省略号的位置（省略号本身是 BMP 字符，占 1 个 code unit）
  let end = Math.max(0, max - (ellipsis ? 1 : 0));
  if (end > 0) {
    const last = value.charCodeAt(end - 1);
    const isHighSurrogate = last >= 0xd800 && last <= 0xdbff;
    if (isHighSurrogate) end -= 1;   // 丢掉高代理，避免留下孤立的一半
  }
  return value.slice(0, end) + (ellipsis ? ellipsis : "");
}

/** 判断一个字符串里有没有孤立代理 —— 测试与排障用。 */
export function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const isHigh = c >= 0xd800 && c <= 0xdbff;
    const isLow = c >= 0xdc00 && c <= 0xdfff;
    if (isHigh) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
      continue;
    }
    if (isLow) return true;   // 没有前置高代理的低代理
  }
  return false;
}
