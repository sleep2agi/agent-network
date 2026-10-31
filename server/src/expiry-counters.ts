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
  /** 每个节点最近一次「从未取走」的时刻（ISO）。**光有计数会永久拉黑一台恢复了的节点。** */
  last_at: Record<string, string>;
};

type Bucket = { count: number; lastAt: number };
const counters = new Map<string, Bucket>();
let since = new Date().toISOString();

/** 记一次「过期且从未取走」。node 名用别名（人读），没有别名时退回 node id。 */
export function noteNeverConsumedExpiry(node: string, now = Date.now()): void {
  const key = node || "(unknown)";
  const prev = counters.get(key);
  counters.set(key, { count: (prev?.count ?? 0) + 1, lastAt: now });
}

export function neverConsumedExpiryCounters(): NeverConsumedExpiryCounters {
  let total = 0;
  const by_node: Record<string, number> = {};
  const last_at: Record<string, string> = {};
  for (const [k, v] of [...counters.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    by_node[k] = v.count;
    last_at[k] = new Date(v.lastAt).toISOString();
    total += v.count;
  }
  return { since, total, by_node, last_at };
}

/** 仅测试用：清零并重置窗口。 */
export function resetNeverConsumedExpiryCountersForTest(now = new Date()): void {
  counters.clear();
  since = now.toISOString();
}

/**
 * #3271 —— 派单侧的**硬闸**判据（纯函数，便于单测）。
 *
 * 起因：一台节点连续 9 次「等满 60 分钟未取走」，而每一次都只是「又过期了一条」的通知。
 * 派单方只能靠人记住。⇒ 这里把它变成一个**在派单那一刻就拒绝**的判据，并留一个显式出口。
 *
 * 三条设计选择：
 *   ① 阈值取「本进程窗口内 ≥3 次」——一次两次可能是宿主重启，三次已经是形态。
 *   ② 出口是 `force`，且**只有人**能用（节点令牌不能自己给自己放行）——与既有的
 *      `assertNodeHealthy(force, forceAllowed)` 同一条规矩。
 *   ③ 拒绝体给全：alias / expiries / window_since / 下一步。只说 "refused" 会让调用方去猜。
 */
export const NEVER_CONSUME_LIMIT = 3;
/** 「最近一次从未取走」超过这个时长 ⇒ 不再拒发（节点可能已经恢复；计数仍留在读数里）。 */
export const NEVER_CONSUME_STALE_MS = 2 * 60 * 60_000;

/**
 * #3271 🔴 2026-10-31 修 —— 这道闸原来**只读进程内计数器**，而计数器随部署归零。
 *
 * 实测打脸：`.254` 部署（22:39）之后我给 TM官网运维 派了一条自检任务，
 * 它明明已经 10 次「到死没被取走」，闸却 `ok:true` 放行了 —— 因为计数器在重启时被清空。
 * ⇒ **证据的生命期比故障短**：故障以「周」计，计数器以「本次进程」计。
 *    一条只在本次进程内有效的判据，会被每一次发版重置，而发版比故障频繁得多。
 *
 * 所以判据必须有一个**持久**来源：tasks 表里已经写着每一条过期的 `status='expired'` 与
 * `consumed_at IS NULL` —— 那是过期发生时就落库的事实，不随重启消失。
 *
 * 两个来源**取并集**（不是二选一）：
 *   · 进程内计数器：本次进程内发生的最新鲜的那几条（可能在 tasks 行写之前就有）
 *   · tasks 表：跨重启的历史（窗口由调用方给，默认 7 天 —— 与「节点可能恢复」同一个取舍）
 */
export interface PersistentExpiryEvidence {
  /** 「最后一次成功回复之后」仍过期且无回复的条数。 */
  expiries: number;
  /** 这些过期里最近的一条（用于读数，不用于时效判断）。 */
  last_at: string | null;
  /** 该节点最后一次成功回复的时间；null = 从来没有回复过（那才是真正的「从未消费」）。 */
  last_reply_at: string | null;
}

export const NEVER_CONSUME_LOOKBACK_MS = 7 * 24 * 60 * 60_000;

/**
 * #3271 🔴 2026-10-31 第二次修正 —— 判据的**语义**错了，不只是寿命。
 *
 * 第一次修正（内存 ∪ tasks 表）解决的是「部署清空计数器」，但生产实测仍然放行，查库后发现：
 *
 *     tasks WHERE to_name='TM官网运维'
 *       replied            252 条   ← 它其实会干活
 *       status='expired'    37 条   且 consumed_at 全为 NULL
 *       全库 consumed_at 非空 83,332 条（这个字段是被正常使用的）
 *
 * ⇒ **`consumed_at IS NULL` 不等于「从未取走」**：这台节点回复过 252 条，只是从不写这个字段。
 *    计数器叫「从未取走」，量的却是「没写 consumed_at」—— 我把字段名当成了行为名。
 *
 * 所以判据改为**以「最后一次成功回复」为界**：
 *   「在你最后一次回复之后，又有多少条过期且没人回」= 它到底还在不在服务。
 *   之后已经回复过 ⇒ 放行（它是活的，只是某几条没接）。
 *
 * 这也让固定 TTL 变得不必要：DB 这条路自带边界（回复时间），
 * 而固定 TTL 是凭直觉定的 —— 实测那台节点的故障节律是「天」，我给的是「2 小时」。
 */
export function persistentNeverConsumedExpiries(
  db: { get<T = any>(sql: string, ...params: any[]): T | null },
  alias: string,
  networkId: string | null,
  opts: { now?: number; lookbackMs?: number } = {},
): PersistentExpiryEvidence {
  const since = new Date((opts.now ?? Date.now()) - (opts.lookbackMs ?? NEVER_CONSUME_LOOKBACK_MS))
    .toISOString().replace("T", " ").slice(0, 19);

  // ① 最后一次成功回复（replied / completed 都算「还活着」的证据）
  const reply = networkId
    ? db.get<{ last: string | null }>(
        `SELECT MAX(COALESCE(completed_at, created_at)) AS last FROM tasks
          WHERE to_name = ?1 AND network_id = ?2 AND status IN ('replied','completed')`,
        alias, networkId)
    : db.get<{ last: string | null }>(
        `SELECT MAX(COALESCE(completed_at, created_at)) AS last FROM tasks
          WHERE to_name = ?1 AND status IN ('replied','completed')`,
        alias);
  const lastReplyAt = reply?.last ?? null;

  // ② 它之后仍「过期且无回复」的条数
  const boundary = lastReplyAt && lastReplyAt > since ? lastReplyAt : since;
  const row = networkId
    ? db.get<{ n: number; last: string | null }>(
        `SELECT COUNT(*) AS n, MAX(created_at) AS last FROM tasks
          WHERE to_name = ?1 AND network_id = ?2 AND status = 'expired' AND result IS NULL
            AND created_at > ?3`,
        alias, networkId, boundary)
    : db.get<{ n: number; last: string | null }>(
        `SELECT COUNT(*) AS n, MAX(created_at) AS last FROM tasks
          WHERE to_name = ?1 AND status = 'expired' AND result IS NULL
            AND created_at > ?2`,
        alias, boundary);

  return {
    expiries: Number(row?.n ?? 0),
    last_at: row?.last ?? null,
    last_reply_at: lastReplyAt,
  };
}

export type NeverConsumeGate =
  | { ok: true }
  | { ok: false; error: "target_never_consumes"; alias: string; expiries: number; window_since: string; message: string };

export function neverConsumeGate(input: {
  alias: string;
  counters: NeverConsumedExpiryCounters;
  force: boolean;
  /** 人令牌才能用 force；节点令牌传 false。 */
  forceAllowed: boolean;
  limit?: number;
  /** 「最近一次」的时效：超过它就不再拒发（节点可能已经恢复）。 */
  staleAfterMs?: number;
  now?: number;
  /** tasks 表里的历史（跨重启）。与进程内计数器**取并集**，见 persistentNeverConsumedExpiries 的注释。 */
  persistent?: PersistentExpiryEvidence;
}): NeverConsumeGate {
  const limit = input.limit ?? NEVER_CONSUME_LIMIT;
  const fromMemory = input.counters.by_node[input.alias] ?? 0;
  const fromDb = input.persistent?.expiries ?? 0;
  const expiries = Math.max(fromMemory, fromDb);
  if (expiries < limit) return { ok: true };
  // DB 证据**自带边界**（「最后一次回复之后」），所以它不需要固定 TTL —— 那个 TTL 是我拍的。
  // 只有「纯内存计数」这条路才需要时效：它没有回复时间可比，只能靠时长兜底。
  if (fromDb >= limit) {
    if (input.force && input.forceAllowed) return { ok: true };
    return {
      ok: false,
      error: "target_never_consumes",
      alias: input.alias,
      expiries,
      window_since: input.counters.since,
      message:
        `this target has ${fromDb} expired task(s) with no reply since its last reply`
        + `${input.persistent?.last_reply_at ? ` (${input.persistent.last_reply_at})` : " (it has never replied)"}; `
        + `nothing will queue correctly here until it replies again — pass force:true (user tokens) if you know it recovered`,
    };
  }
  // 2026-10-31 —— **只数不衰减会把恢复了的节点永久拉黑**。
  // 实测的教训来自另一台机（TM中转运维）：连「抑制了多少」这个数本身都在被环缓冲淘汰，
  // 所以任何「累计」都只在它的窗口内可引用；这里把窗口写进判据：最近一次过期超过 TTL ⇒ 放行。
  const lastAt = [input.counters.last_at?.[input.alias], input.persistent?.last_at ?? undefined]
    .filter((x): x is string => typeof x === "string")
    .sort()
    .pop();
  if (lastAt) {
    const age = (input.now ?? Date.now()) - Date.parse(lastAt);
    if (Number.isFinite(age) && age > (input.staleAfterMs ?? NEVER_CONSUME_STALE_MS)) return { ok: true };
  }
  if (input.force && input.forceAllowed) return { ok: true };
  return {
    ok: false,
    error: "target_never_consumes",
    alias: input.alias,
    expiries,
    window_since: input.counters.since,
    message:
      `this target has expired ${expiries} task(s) without ever taking one (window since ${input.counters.since}); `
      + `nothing will queue correctly here until it consumes again — pass force:true (user tokens) if you know it recovered`,
  };
}
