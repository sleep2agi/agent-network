// 2026-10-31 —— **「这条任务到死都没被取走」要有计数**（#3271 的直接产物）。
//
// 现场：一台节点上有 4 条任务，一次又一次「等满 60 分钟 ⇒ expired」，而**积压数两次读数都是 4**。
// 「又过期了一条」是可见的（Hub 会发通知），但「这台节点连续 N 次一次都没取走」没有任何读数 ——
// 于是派单方只能靠人记住「这台不行」。
//
// 与 rejection-counters.ts 同一套约束：
//   ① 按**节点**分桶，不是只有一个总数（要回答「是哪一台」）
//   ② 窗口必须与 startedAt 一起读（进程重启归零，而「归零」与「没发生」同值）
//   ③ 键必须有限：node id 来自我们自己的节点表，不随请求内容膨胀
//
// 🔴 最要紧的一条区分：**「过期时已经被取走过」不算「never picked up」**。
//    server.ts 的 patrol 里那条注释（#500）已经写过：consumed_at < expires_at 的任务
//    只是「还没回报完成」，不是「没人取」。把它们算进来，计数就变成「过期了多少条」，
//    而那是另一个（更没用的）数。
//
// 本计数器属于「只有异常路径能让它 +1」那一类 ⇒ 必须有 must-fire：
// 注入一条真实过期（未消费）看它跳没跳，且**再注入一条已消费后过期的看它跳不跳**（负数用例）。
export type NeverConsumedExpiryCounters = {
  /** 统计窗口左端（进程启动时刻，ISO）。与「归零」区分必需。 */
  since: string;
  /** 累计「过期且从未被取走」的任务数（所有节点）。 */
  total: number;
  /** 按节点分桶；键是 node alias（可读），值是计数。空桶不出现。 */
  by_node: Record<string, number>;
};

const counters = new Map<string, number>();
let since = new Date().toISOString();

/** 记一次「过期且从未取走」。node 名用别名（人读），没有别名时退回 node id。 */
export function noteNeverConsumedExpiry(node: string): void {
  const key = node || "(unknown)";
  counters.set(key, (counters.get(key) ?? 0) + 1);
}

export function neverConsumedExpiryCounters(): NeverConsumedExpiryCounters {
  let total = 0;
  const by_node: Record<string, number> = {};
  for (const [k, v] of [...counters.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    by_node[k] = v;
    total += v;
  }
  return { since, total, by_node };
}

/** 仅测试用：清零并重置窗口。 */
export function resetNeverConsumedExpiryCountersForTest(now = new Date()): void {
  counters.clear();
  since = now.toISOString();
}
