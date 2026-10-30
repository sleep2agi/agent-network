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
 * 打码 + 截断。控制字符替换为空格，避免伪造日志行。
 *
 * 🔴 顺序是**承重**的：必须**先在全量原文上打码，再截断**。
 *    反过来（先截断到 200 再匹配）会让跨过边界的密钥「前缀还在、后半没了」⇒
 *    模式匹配不上 ⇒ **密钥前缀原样泄露**。
 *    而顺序写反时**测试照样绿**，因为样本通常很短 ⇒
 *    所以测试里必须有一条：密钥跨越截断边界。
 *
 * 返回的一定是单行、≤ maxLen + 后缀 的字符串。
 */
export function redactUpstreamText(input: unknown, maxLen: number = MAX_LEN): string {
  const raw = typeof input === "string" ? input : String(input ?? "");
  let text = raw.replace(/[\u0000-\u001f\u007f]+/g, " ");
  for (const [re, replacement] of PATTERNS) text = text.replace(re, replacement);
  if (text.length > maxLen) {
    // 🔴 截断点不许落在打码标记内部。
    //    否则 `sk-***` 会被切成 `sk-` —— 前缀留下来了、标记没了，
    //    而这条日志的作用正是「让人知道这里曾有凭据」。
    //    ⇒ 若切点落在某个 `***` 内部，就把整个标记退掉（宁可少几个字节）。
    let cut = maxLen;
    for (let i = text.indexOf("***"); i >= 0; i = text.indexOf("***", i + 1)) {
      if (i < cut && cut < i + 3) {
        cut = i;   // 退到标记起点；其前缀（如 `sk-`）属于标记的一部分，一并退掉
        break;
      }
    }
    text = `${text.slice(0, cut)}…(${raw.length} chars)`;
  }
  return text;
}
