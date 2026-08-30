/**
 * #1650 — hub 的 TEXT 时间戳列是 SQLite `datetime('now')` 写的，
 * 形如 `2026-08-30 21:11:24`：**UTC，但不带任何时区标记**。
 *
 * 🔴 `new Date(raw)` / `Date.parse(raw)` 对这种串按**本地时间**解析（ES 规范：
 *    带时间的形式无偏移时视为本地时间），误差恰好等于主机时区偏移，**而且不报错**：
 *
 *      TZ=UTC                   误差  0h
 *      TZ=Asia/Shanghai         误差 -8h   （看起来更陈旧）
 *      TZ=America/Los_Angeles   误差 +7h   （看起来更新鲜 ← 朝好的一侧错）
 *
 * 🔴 **只对 TEXT 列用它。** 同一个字段名在不同表里可能是不同类型：
 *      sessions.last_seen_at / licenses.expires_at   → TEXT（要用本函数）
 *      external_schedule_edits.expires_at 等 4 列     → INTEGER（epoch 毫秒，直接 new Date 就对）
 *    按字段名判会判错 —— 见 #1650 里的更正。
 *
 * 与 agent-network 侧的同名函数是**有意的重复**：server 包不依赖 agent-network，
 * 仓里也没有共享 lib。两边各自带测试。
 */
export function parseHubTimestamp(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(t)) return null;
  const hasZone = /([Zz]|[+-]\d{2}:?\d{2})$/.test(t);
  const ms = Date.parse(t.replace(" ", "T") + (hasZone ? "" : "Z"));
  return Number.isFinite(ms) ? ms : null;
}
