// 2026-10-31 —— 拒绝原因不止要有日志，还要有**计数**。
//
// 背景：同一条路由的失败可以有很多原因（TM 侧那条是 401/400/403 三种「1 键」出口），
// 而日志只回答「有没有发生过」：要回答「今天拒了多少次、分别为什么」，
// 得去翻文件、还要考虑轮转与压缩 —— 而轮转后的 .gz 用 grep 读是**静默 0**。
//
// ⇒ **日志是事后取证，计数器是随时可读。**
//
// 🔴 三条设计约束（每条都对应一个我们已经踩过的坑）：
//   ① **按 reason 分桶，不是只有一个总数。**
//      一个总数会数出频率、看不出原因 —— 而「为什么」才是排查要的东西。
//   ② **窗口必须显式给出。** 计数器随进程重启归零，
//      而「归零」与「没有发生」在读数上同值 ⇒ 必须与 startedAt 一起读。
//      （历史教训：拿累计值除以 uptime 当速率 ⇒ 分母与分子不独立 ⇒ 刚重启必假阳性。）
//   ③ **键必须有限且可枚举。** reason 由 (status, code) 组成，两者都来自
//      我们自己的出口 ⇒ 不会随请求内容膨胀（不做「按 URL 分桶」那种事）。
//
// 为什么不做成 Prometheus 指标：本仓没有指标管道，而 /health 已经是
// 「随手可读」的那个面。放这里能被 agent-node、dashboard、人都读到。

const REJECTION_COUNTS = new Map<string, number>();

/** 桶键：`<status>:<code>`。code 缺失时用 `unknown`，绝不省略 —— 省略会让两种原因并桶。 */
function bucketKey(status: number, code: unknown): string {
  const raw = typeof code === "string" && code ? code : "unknown";
  // 只保留可打印的短标识，防客户端塞长串把键空间撑爆。
  const safe = raw.replace(/[^\w.:-]+/g, "_").slice(0, 48) || "unknown";
  return `${status}:${safe}`;
}

/** 记一次拒绝。调用点：logTaskRejection —— 与那一行日志同一个位置，不会漏记。 */
export function recordTaskRejection(status: number, code: unknown): void {
  const key = bucketKey(status, code);
  REJECTION_COUNTS.set(key, (REJECTION_COUNTS.get(key) ?? 0) + 1);
}

/**
 * 快照。**只读、已排序、键有限**：
 *   - 排序是为了让两次读数可比（无序 Map 会让「同一个计数器」看起来在变）
 *   - 上限 64 个桶，超出的合并进 `other` —— 计数器的价值在「为什么」，不在「穷举」
 */
export function taskRejectionCounters(): { total: number; by_reason: Record<string, number> } {
  let total = 0;
  const entries = [...REJECTION_COUNTS.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const byReason: Record<string, number> = {};
  let other = 0;
  for (const [key, count] of entries) {
    total += count;
    if (Object.keys(byReason).length < 64) byReason[key] = count;
    else other += count;
  }
  if (other > 0) byReason.other = other;
  return { total, by_reason: byReason };
}

/** 测试用：清空。生产路径不调用。 */
export function resetTaskRejectionCounters(): void {
  REJECTION_COUNTS.clear();
}
