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
