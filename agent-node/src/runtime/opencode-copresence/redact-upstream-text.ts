// 2026-10-31 —— 上游自由文本进日志之前，先过一遍脱敏。
//
// 起因（对方指出）：把上报摘要改成 `<errName>/<code|unknown>` 是对的，
// 但**本地日志仍保留 message** —— 而 message 可能带上游原文（token、带参数的 URL、
// 内部主机名）。于是本地日志成了一个新的泄露面：
//   对外的出口收紧了，对内的出口没有 ⇒ **同一个策略只覆盖了一部分出口。**
// 这正是今晚反复出现的那格：洞的大小 = 出口数 − 走过脱敏的出口数。
//
// 判据（可机械检查）：任何来自上游/外部的自由文本，进入任何日志之前必须经过本函数；
// 判据不是“看起来没有密钥”，而是“长度有上限 + 已知形态被打码”。
//
// 🔴 这里用**黑名单**打码，而黑名单永远会漏掉下一种 token 形态。
//    所以它只降低泄露概率，不消除它；真正消除要靠“不记自由文本”。
//    这也是为什么只记 name+code 的那个摘要仍然是首选。

const MAX_LEN = 200;

const PATTERNS: Array<[RegExp, string]> = [
  // 常见密钥前缀（与 opencode-v2-catalog 的 SECRET 同源，但这里只用于日志打码）
  [/\b(sk-|gh[pousr]_|github_pat_|xox[baprs]-|AKIA|AIza|ya29\.|glpat-)[A-Za-z0-9_\-]{6,}/g, "$1***"],
  // Authorization 头里的凭据
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._\-+/=]{8,}/gi, "$1 ***"],
  // URL 查询参数里的敏感值
  [/([?&](?:token|access_token|api_key|apikey|key|secret|password|passwd|sig|signature)=)[^&\s"']+/gi, "$1***"],
  // user:pass@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@"],
  // 显式标出的诊断 ID 之类不算敏感，不处理（避免误伤关联键）。
];

/**
 * 截断 + 打码。控制字符替换为空格，避免伪造日志行。
 * 返回的一定是单行、≤ MAX_LEN 的字符串。
 */
export function redactUpstreamText(input: unknown, maxLen: number = MAX_LEN): string {
  const raw = typeof input === "string" ? input : String(input ?? "");
  let text = raw.replace(/[\u0000-\u001f\u007f]+/g, " ");
  for (const [re, replacement] of PATTERNS) text = text.replace(re, replacement);
  if (text.length > maxLen) text = `${text.slice(0, maxLen)}…(${raw.length} chars)`;
  return text;
}
