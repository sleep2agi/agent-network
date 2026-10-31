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
// 🔴 已知缺口 —— 写成**可数清单**，而不是一句“可能不全”（2026-10-31 实测）。
//
// 🔑 行键是 **位置**（谁在那里拒绝），不是「失败种类」。
//    理由：同一类失败会随实现搬家 —— `express.json()` 把 parser 放在中间件里 ⇒ 不计；
//    我们把 `await req.json()` 放在 handler 里 ⇒ 计。
//    **失败种类会漂，位置不会。** 分类键要选「不因重构而改变」的那个维度。
//
//     位置                        是否计数   失败种类（只作说明）
//     ────────────────────────────────────────────────────────────────────────────
//     鉴权中间件之前              ✗          401 在到达 /api/task 之前返回
//     路由表之前                  ✗          全局/路由 404（未匹配）
//     fetch() 之前（运行时层）    ✗          Bun maxRequestBodySize（请求体超限）
//     handler 内 · 解析           ✓          await req.json() 失败（本仓如此；Express 恰好相反）
//     handler 内 · 校验/权限      ✓          schema / 网络归属 等非 2xx
//     错误 hook（500 兜底）       ✗          buildServeErrorResponse
//
//   ⇒ **位置仪器化 2/6；但链路覆盖 = 0/6。**
//
// 🔴 「2/6」这个写法本身是错的（2026-10-31 修正）：
//    从上表可知被仪器化的是第 4、5 个位置 —— **不是前缀**。
//    而「要到达第 k 个位置，必须先经过前 k-1 个」⇒
//    一条能被判读的「链路覆盖」只能是 prefix(k)；
//    非前缀的覆盖数会**暗示测试绕过链路**，而不是测了链路。
//    ⇒ 所以按「首个未被观测的位置」算：**#1（鉴权中间件之前）就是那个洞 ⇒ 链覆盖 0/6**。
//    ⇒ 2/6 只能念成「有 2 个点装了表」，不能念成「链路有三分之一被覆盖」。
//    ⇒ 判据：**覆盖数必须是前缀**；非前缀时，报告要写「首个空洞在哪」，否则它是个自相矛盾的读数。
//   ⇒ 清单要能被一次坏输入打出来，而不是靠回想中间件有哪些：
//      `curl -X POST /api/task -H 'content-type: application/json' -d '{bad'` ⇒ 400，
//      看计数器动不动 ⇒ 动 ⇒ 这个位置被覆盖（本仓就是动的，见 health-redaction.test.ts）。
//   ⇒ 为什么必须写分母：一个有分母的缺口是可排期的；一个没有分母的缺口只会被当成注释。
//   ⇒ 补齐路径：把 +1 上移到中间件（401/404）或统一错误兜底（500），本次不做。
//
// 🔴 而下面的流程顺序也来自同一个教训：
//     ① 先写「怎么让它 +1」的具体注入（命令或测试）
//     ② 写不出 ⇒ **停下来先补出口** —— 此时暴露的往往是产品缺陷，不是测试缺陷
//     ③ 写得出 ⇒ 再写断言
//   ⇒ 形状断言写得再漂亮，也不要求「它能响」；而「能不能响」才是判据的入场券。
//
// 🔴 2026-10-31 补：窗口不能只给时长，要给**两个时刻**。
//    读者拿 counters.since（起点）与 /health.served_at（终点）相减才是窗口；
//    「我打算等 60 秒」是意图，不是读数 —— 而意图与读数在字段里同形。
//    ⇒ 判据：速率/窗口类字段，分子分母各要自己的时刻戳；**被声明的那个永远不算**。
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
/**
 * 2026-10-31 —— 加一个 `scope` 字段：让「这个数是进程生命期内的」无法被误读。
 *
 * null 有三个成因，而只有前两个被写进过文档：
 *   ① 真的没发生
 *   ② 记录随进程没了（进程内计数器）
 *   ③ **记录还在日志里，只是不在这个窗口里**
 * ⇒ 第三种最常见，而它与「没发生」在读数上同值。
 * ⇒ 与其在注释里提醒，不如让数据自己说明：`scope: "process_lifetime"`。
 */
export function taskRejectionCounters(): {
  scope: "process_lifetime";
  total: number;
  by_reason: Record<string, number>;
} {
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
  // ⚠️ `scope` 说的是**这个计数的生命期**，不是证据的生命期：
  //    进程没了 ⇒ 这里归零；但对应日志行仍在磁盘上 ⇒
  //    「计数器为 0 且日志里有拒绝」是正常的，不是矛盾。
  return { scope: "process_lifetime", total, by_reason: byReason };
}

/** 测试用：清空。生产路径不调用。 */
export function resetTaskRejectionCounters(): void {
  REJECTION_COUNTS.clear();
}/**
 * 2026-10-31 —— 出口清单**导出成数据**（外部复核 ②：「那张表的分母本身需要一个来源」）。
 *
 * 以前这六行只活在注释里：加一个中间件时，注释不会自己变，而「覆盖 2/6」这个比例
 * 也没人知道分母从哪来。⇒ 现在它是数据，测试会断言：
 *   · 行数恰好 6（有变化就必须改测试，而不是让注释漂）
 *   · 每个 `counted: true` 的位置都有 must-fire 用例覆盖
 *   · 每个 `counted: false` 的位置都有「已知缺口」用例钉住（防止它悄悄被修好而报告仍写 0/6）
 */
export const TASK_REJECTION_EXITS: ReadonlyArray<{
  /** 位置（谁在那里拒绝）——分类键选位置，不选失败种类（种类会漂，位置不会） */
  position: string;
  /** 这个位置拒绝时，task_rejections 计数器会不会 +1 */
  counted: boolean;
  /** 钉住这一行的测试名（空串 = 还没有测试，属于缺口） */
  pinned_by: string;
}> = [
  { position: "before_auth_middleware", counted: false, pinned_by: "KNOWN GAP: unauthenticated /api/task rejection is NOT counted" },
  { position: "before_route_table", counted: false, pinned_by: "" },
  { position: "before_fetch_runtime_body_limit", counted: false, pinned_by: "" },
  { position: "handler_parse", counted: true, pinned_by: "malformed JSON on /api/task IS counted" },
  { position: "handler_validate_or_permission", counted: true, pinned_by: "a real rejected /api/task actually bumps the counter" },
  { position: "error_hook_500", counted: false, pinned_by: "" },
];


