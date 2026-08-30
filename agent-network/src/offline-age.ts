/**
 * #1648 — 名册上「刚停的节点」和「掉了三天没人发现的节点」渲染成同一个数字。
 *
 * `anet status` 原先只印 `N offline`。实测（2026-08-31，84 台 TM 相关节点）:
 * 45 台 offline 里 27 台 >3 天、18 台 1–3 天、**近 6 小时内 0 台** ——
 * 「当前没有活故障」和「有 45 台掉了」是完全不同的两个结论，而屏幕上只有后者。
 */

/**
 * 🔴 hub 存的 `last_seen_at` 是 **UTC**，但字符串里**没有时区标记**
 * （形如 `2026-08-30 21:11:24`）。直接 `new Date(raw)` 会被当成**本地时间**：
 * 在 UTC+8 上就是整整 8 小时的偏差，而且它**不会报错** —— 只会把「4 分钟前」
 * 读成「8 小时前」。这个错本人在 2026-08-31 亲自犯过一次，差点把
 * 「舰队心跳陈旧」报出去。
 */
export function parseHubTimestamp(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(t)) return null;
  const hasZone = /([Zz]|[+-]\d{2}:?\d{2})$/.test(t);
  const ms = Date.parse(t.replace(" ", "T") + (hasZone ? "" : "Z"));
  return Number.isFinite(ms) ? ms : null;
}

export type OfflineAges = {
  under1h: number; h1to24: number; d1to3: number; over3d: number;
  /** 🔴 没有可用时间戳的那些必须单独一格,不能并进任何一档 —— 见下 */
  unknown: number;
  total: number;
};

const H = 3600_000;

export function summarizeOfflineAges(
  offline: ReadonlyArray<{ last_seen_at?: unknown }>,
  nowMs: number,
): OfflineAges {
  const a: OfflineAges = { under1h: 0, h1to24: 0, d1to3: 0, over3d: 0, unknown: 0, total: 0 };
  for (const s of offline) {
    a.total++;
    const ms = parseHubTimestamp(s?.last_seen_at);
    // 🔴 兜底必须落在 `unknown`,不能落在任何一个具体档位。「我不知道它掉了多久」
    //    和「它刚掉」是两件事,把前者算进 under1h 会让一台失联很久的节点看起来最新鲜。
    if (ms === null) { a.unknown++; continue; }
    const h = (nowMs - ms) / H;
    if (h < 1) a.under1h++;
    else if (h < 24) a.h1to24++;
    else if (h < 72) a.d1to3++;
    else a.over3d++;
  }
  return a;
}

/** 返回空串表示「没有值得多说一句的东西」，调用方据此决定印不印。 */
export function formatOfflineAges(a: OfflineAges): string {
  if (a.total === 0) return "";
  const parts: string[] = [];
  if (a.under1h) parts.push(`${a.under1h} 掉线不到 1 小时`);
  if (a.h1to24) parts.push(`${a.h1to24} 掉线 1-24 小时`);
  if (a.d1to3) parts.push(`${a.d1to3} 掉线 1-3 天`);
  if (a.over3d) parts.push(`${a.over3d} 掉线超过 3 天`);
  if (a.unknown) parts.push(`${a.unknown} 无时间戳(不知道掉了多久)`);
  return parts.join(", ");
}
