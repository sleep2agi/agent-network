// hub 的 `*_at` 列是 **UTC 且不带时区标记**（`'YYYY-MM-DD HH:MM:SS'`）。
//
// `new Date(ts)` / `Date.parse(ts)` 对这种形式的解释在引擎之间不一致（有的按本机时区），
// 于是同一行数据在东八区机器上会差 8 小时 —— 而差 8 小时在「冷却期」「下一次唤醒」
// 这类判据上会安静地把行为改掉：不是报错，是算错。
//
// 这个模块是 agent-node 侧的唯一解析入口。server 侧有同名实现（server/src/hub-timestamp.ts），
// 两个包不能互相 import，所以这条口径**故意写两遍**，两边各有一条棘轮看着。
export function parseHubTimestamp(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(t)) return null;
  const hasZone = /([Zz]|[+-]\d{2}:?\d{2})$/.test(t);
  const ms = Date.parse(t.replace(" ", "T") + (hasZone ? "" : "Z"));
  return Number.isFinite(ms) ? ms : null;
}
