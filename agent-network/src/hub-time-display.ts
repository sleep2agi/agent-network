import { parseHubTimestamp } from "./offline-age";

/**
 * 把 hub 的 TEXT 时间戳显示给人看。
 *
 * 🔴 原先是**原样打印**:
 *
 *     updated:  2026-08-31 00:20:11
 *
 * 那是 UTC,**没有任何时区标记**。同一时刻本地是 `08:22:41 CST` ——
 * 于是一个 **2 分钟前**刚心跳过的节点,在 UTC+8 的用户眼里像是 **8 小时前**的。
 *
 * 这不是假想:2026-08-31 我自己就这么读错过一次,据此差点报出「舰队心跳陈旧
 * 8.3 小时」。**CLI 在主动制造这个误读。**
 *
 * 所以显示两样东西:
 *   - **相对时长**(人真正想知道的那个)
 *   - 绝对值,并**显式标 UTC**(便于和日志、issue 里的时间对齐)
 */
export function formatHubTime(raw: unknown, nowMs: number = Date.now()): string {
  if (typeof raw !== "string" || !raw.trim()) return "-";
  const ms = parseHubTimestamp(raw);
  // 🔴 解不出来就**原样回显**,不要编一个看起来合理的时间。
  //    但要让读的人知道我们没能解析它 —— 否则一个格式变了的字段会静默退化成
  //    「看起来正常的绝对时间」,而相对时长凭空消失。
  if (ms === null) return `${raw.trim()}（无法解析）`;
  return `${raw.trim()} UTC（${formatAgo(nowMs - ms)}）`;
}

/** 人读的时长。负数(时钟偏差/未来时间)如实说,不折成 0。 */
export function formatAgo(deltaMs: number): string {
  if (!Number.isFinite(deltaMs)) return "时长未知";
  if (deltaMs < 0) {
    const s = Math.round(-deltaMs / 1000);
    return s < 90 ? `${s} 秒后（时钟偏差？）` : `${Math.round(s / 60)} 分钟后（时钟偏差？）`;
  }
  const s = Math.round(deltaMs / 1000);
  if (s < 60) return `${s} 秒前`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}
