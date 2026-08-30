/**
 * #1645 — codex-sdk turn 超时时,「超时」本身说不出要查什么。
 *
 * 🔴 原先那句是 `检查 OPENAI_BASE_URL / vendor 负载` —— 一句**猜测**,不是这一刻
 *    拿得到的事实。2026-08-31 实测的一次 300s 超时,真因是上游 models 响应里带了
 *    本机 codex 不认识的推理档位(`unknown variant \`max\``),rmcp worker 因此致命
 *    退出;`OPENAI_BASE_URL` 和 vendor 负载**一个都没被牵涉**。按那句话去查的人,
 *    查的是两个和故障无关的东西。
 *
 * 这一刻**真正拿得到**的只有一个数:超时窗口里有没有事件流过。它恰好是
 * 「连接/握手层就没通」和「turn 中途停住」之间唯一的判别项,而这两种要查的
 * 东西完全不同 —— 前者查传输/版本,后者查那条 turn 自己(工具卡住、compaction)。
 */
export function codexTimeoutDetail(evSeen: number, msSinceLastEvent: number): string {
  if (evSeen === 0) return "期间 0 个事件(连接/握手层就没通)";
  return `期间 ${evSeen} 个事件,最后一个在 ${Math.round(msSinceLastEvent / 1000)}s 前(turn 中途停住)`;
}


/**
 * claude-agent-sdk 那条是同一形状的兄弟:原文是
 *   `… — vendor 长时间未响应, 检查 ANTHROPIC_BASE_URL endpoint 或 vendor 负载`
 *
 * 它比 codex 那条好一些 —— auth 错误和限流/配额在上面已经被分流走了,
 * 所以走到这里确实排除了那两种。但「vendor 长时间未响应」和「检查 BASE_URL」
 * 仍然是**没测的**。
 *
 * 这一刻真正拿得到的是:**每次尝试各花了多久、是超时还是报错**。
 * 它是「真的一直没响应」和「很快就失败、只是最后一次撞上超时」之间的判别项 ——
 * 前者查网络/vendor,后者查那个错误本身,两者要查的东西完全不同。
 */
export function claudeAttemptsDetail(
  attempts: ReadonlyArray<{ ms: number; timedOut: boolean }>,
  timeoutMs: number,
): string {
  if (attempts.length === 0) return "没有记录到任何一次尝试";
  const parts = attempts.map(a => `${Math.round(a.ms / 1000)}s ${a.timedOut ? "超时" : "报错"}`);
  // 「跑满」判据放宽 5%:超时是靠定时器触发的,实测值总是略大于阈值。
  const allFull = attempts.every(a => a.timedOut && a.ms >= timeoutMs * 0.95);
  const tail = allFull
    ? "每次都跑满了超时,期间没有任何响应"
    : "并非每次都跑满超时 —— 说明不只是「vendor 没响应」";
  return `各次 ${parts.join(" / ")};${tail}`;
}
