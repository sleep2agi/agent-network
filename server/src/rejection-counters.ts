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
// 🔴 这一类的第四问（2026-10-31 补）：**它在正常运行时会不会动？**
//    本模块的计数器属于「只有异常路径能让它 +1」那一类 ⇒ 正常运行时恒为 0，
//    而「0」读起来像「从没出过错」。它与「死计数器」在读数上完全一样，
//    但处置相反：死计数器该删，这一种**必须配一个 must-fire**（注入一次真实拒绝，看它跳不跳）。
//    ⇒ 光有 by_reason 的形状断言不够：形状对、接线错，读数照样是 0。
//    ⇒ 已有一处 must-fire：health-redaction.test.ts 里真实 POST /api/task 触发非 2xx 后读 /health。
//
// 🔴 已知缺口 —— 写成**可数清单**，而不是一句“可能不全”（2026-10-31 实测）：
//
//     出口                                 是否计数    说明
//     ─────────────────────────────────────────────────────────────
//     鉴权中间件 401                        ✗          在到达 /api/task 之前返回，不调用 logTaskRejection
//     全局/路由 404（未匹配）               ✗          同上，不进 handler
//     handler 内拒绝（非 2xx）              ✓          ← **唯一被覆盖的**
//     未捕获异常 → 500 兜底                 ✗          由上层兜底，不经 logTaskRejection
//
//   ⇒ **覆盖 1/4 类出口。**
//   ⇒ 为什么必须写分母：一个有分母的缺口是可排期的；一个没有分母的缺口只会被当成注释。
//   ⇒ 补齐路径：把 +1 上移到中间件（401/404）或统一错误兜底（500），本次不做。
//
// 🔴 而下面的流程顺序也来自同一个教训：
//     ① 先写「怎么让它 +1」的具体注入（命令或测试）
//     ② 写不出 ⇒ **停下来先补出口** —— 此时暴露的往往是产品缺陷，不是测试缺陷
//     ③ 写得出 ⇒ 再写断言
//   ⇒ 形状断言写得再漂亮，也不要求「它能响」；而「能不能响」才是判据的入场券。
//
// 字段注释的三行格式（本模块的对外承诺）：
//   由拒绝日志同一位置 +1；不由读它的人 +1；**只有非 2xx 的 /api/task 才会让它 >0**。
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
