/**
 * SQLite 里的时间戳列（sessions.last_seen_at、tasks.created_at 等）存的是
 * **无时区标记的 UTC 串**（`YYYY-MM-DD HH:MM:SS`，由 SQLite `datetime('now')` 写入）。
 *
 * 裸 `Date.parse("2026-08-27 11:23:54")` 会按**宿主机本地时区**解释这个串。
 * 生产机 TZ=CST+0800 时，它比真实 UTC 时刻早 8 小时——所以 `now - parsed`
 * 恒为 +480 分钟，任何「最近 N 秒内算在线」的判据都会恒判离线。
 * 在 TZ=UTC 的机器上两种写法结果相同，缺陷不会显形。
 */
export function parseDbTimestampMs(value: string): number {
  const s = String(value).trim();
  // 已带时区标记（ISO 的 Z / ±HH:MM）就原样交给 Date
  if (/[Zz]$|[+-]\d{2}:?\d{2}$/.test(s)) return Date.parse(s);
  return Date.parse(s.replace(" ", "T") + "Z");
}
