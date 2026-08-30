/**
 * #1645 —— `anet doctor` 原先对三个 runtime CLI **只检查「在不在」**:
 *
 *   try { execSync("codex --version", …); check("Codex CLI", true); } catch { … }
 *
 * 于是一个**装着、但太旧**的 CLI 会拿到一个 ✅。实测过一次:`codex-cli 0.149.1`
 * 解不动上游 models 响应(`unknown variant \`max\``,它只认到 `xhigh`),
 * rmcp worker 致命退出,用户看到的是 300s 超时 —— 而 doctor 说一切正常。
 *
 * 🔴 **这里只把版本摆出来,不做最低版本判定。**
 *    「多少版本才够」由上游返回什么决定,不是我们能钉死的常量;猜一个下限,
 *    会在别人升级 CLI、上游又改动之后变成误报。而一个会误报的检查,
 *    第一周就会被人关掉。摆出实际版本,让读的人自己对得上号,是这一格
 *    现在能诚实做到的全部。
 */
export function formatCliVersion(raw: unknown): string {
  if (typeof raw !== "string") return "版本未输出";
  // 各家格式不同:`codex-cli 0.149.1` / `1.4.0` / `2.0.1 (Claude Code)`。
  // 不解析、不比较 —— 原样取第一行非空内容。
  const first = raw.split("\n").map(l => l.trim()).find(l => l.length > 0);
  if (!first) return "版本未输出";
  return first.length > 60 ? `${first.slice(0, 57)}...` : first;
}
