// #1615 —— 「PATH 上的 grok 变了，而共存节点还跑着启动时那份」这件事，
// 在重启之前**没有任何信号**。
//
// 危险的形状（#1615 逐条量过）：
//   ① grok CLI 会**自我更新**，没有人主动升级它；
//   ② 升级不产生任何信号 —— 名册上节点仍 idle，因为跑的是老进程；
//   ③ 只有重启才暴露，而重启是升级 agent-node 之后**必须**做的动作。
// ⇒ 一台机器可能已经处于「下次重启就全挂」的状态，而现在看起来一切正常。
//
// 🔴 本模块判的是**漂移**，不是**合法性**。
//    「这个版本在不在验证清单里」需要 GROK_COPRESENCE_VERIFIED_BUILDS，
//    而那张表住在 **agent-node** 里，agent-network **不依赖** agent-node
//    （两者是运行时经 npx/全局二进制耦合，不是构建期依赖）。
//    把清单抄过来就是这个仓里的**第五份** runtime/版本白名单
//    （hub / CLI / agent-node / 桌面端已经各有一份），而抄来的表会静默漂掉。
//
//    所以这里换一个 **agent-network 自己就拥有**的判据：
//      节点日志里记着它启动时用的那串版本 vs 现在 PATH 上的那串。
//    不同 ⇒ 「下次重启会走一条与当前运行不同的 grok」。
//    这不需要知道哪个版本合法 —— 而 #1615 的危险恰恰是「变了但没人知道」。

/** grok 版本横幅的形状：`grok 1.0.5 (5115b46bc9)`，可选 ` [stable]` 后缀。
 *  与 agent-node 那张表的键**同形**（那张表按完整版本串精确匹配）。 */
const BUILD_RE = /\bgrok \d+\.\d+\.\d+ \([0-9a-f]{6,}\)(?: \[[a-z]+\])?/gi;

/** 从一段日志文本里取出**最后一次**出现的 grok 版本串。
 *  🔴 取最后一次，不是第一次：日志按时间追加，最后一次才是这个进程最近一次
 *     启动时用的那个。取第一次会在日志轮转/多次重启后指向历史。 */
export function parseGrokBuildFromLog(text: string): string | undefined {
  const all = String(text ?? "").match(BUILD_RE);
  return all && all.length ? all[all.length - 1].trim() : undefined;
}

/** 从 `grok --version` 的输出里取版本串（同一形状）。 */
export function parseGrokBuildFromVersionOutput(out: string): string | undefined {
  return parseGrokBuildFromLog(out);
}

/** 比较用的身份：**版本号 + 提交 hash**，剥掉尾部的频道标签（` [stable]` 等）。
 *
 *  🔴 2026-08-31 真机跑出来的假阳：同一台机器上，节点日志里是
 *  `grok 1.0.5 (5115b46bc9)`，而 `grok --version` 现在打的是
 *  `grok 1.0.5 (5115b46bc9) [stable]` —— **同一个 build**，只差一个频道标签，
 *  严格串比较判成 drift。18 条单元测试全绿，因为夹具是我自己造的
 *  （1.0.5 vs 1.0.13，两个真不同的版本），**真实输入的这种组合不在夹具里**。
 *
 *  假阳比漏报更致命：每次跑 doctor 都黄的告警，两周内会被训练成「忽略它」，
 *  那时真正的漂移出现也没人看。
 *
 *  🔴 剥后缀是**只对比较**做的，消息里仍打印两个原串 ——
 *  纯频道变化仍然看得见，只是不再判成 drift。
 *  （后缀不携带能力差异：agent-node 的验证表把带/不带后缀列为两个键，
 *   但同一 build 的两条 `autoLeader` 值相同。）
 */
function buildIdentity(v: string): string {
  return v.replace(/\s*\[[a-z]+\]\s*$/i, "").trim();
}

export type GrokBuildDriftKind =
  | "match"            // 两边都知道且相同
  | "drift"            // 两边都知道但不同 ← 这条就是 #1615 的地雷
  | "unknown-current"  // PATH 上问不出来（grok 不在 PATH / 输出不认识）
  | "unknown-started"; // 日志里没有横幅（日志轮转掉了 / 从没成功启动过）

export interface GrokBuildDrift {
  readonly kind: GrokBuildDriftKind;
  readonly started?: string;
  readonly current?: string;
  /** 一句人读的话。四种 kind 四句不同的话 —— 含糊化等于把这一格的功能删掉。 */
  readonly line: string;
}

export function describeGrokBuildDrift(
  started: string | undefined,
  current: string | undefined,
): GrokBuildDrift {
  const s = started?.trim() || undefined;
  const c = current?.trim() || undefined;
  if (!c) {
    return {
      kind: "unknown-current",
      started: s,
      line: "无法问出本机 PATH 上的 grok 版本（grok 不在 PATH，或 `grok --version` 的输出不是已知形状）。"
        + "共存节点重启时会用 PATH 上的那个，所以这一格问不出来就等于**不知道重启会发生什么**。",
    };
  }
  if (!s) {
    return {
      kind: "unknown-started",
      current: c,
      line: `本机 PATH 上是 ${c}；但节点日志里没有启动横幅，问不出它当初用的是哪个版本`
        + "（日志轮转掉了，或它从未成功启动过）。这一格**不能当成「没问题」**。",
    };
  }
  if (buildIdentity(s) === buildIdentity(c)) {
    return {
      kind: "match",
      started: s,
      current: c,
      // 原串不同（只差频道标签）时仍把两个都打出来 —— 判据放宽了，展示没有。
      line: s === c ? `${c}（与该节点启动时相同）`
                    : `${c}（与该节点启动时同一 build，仅频道标签不同：启动时 ${s}）`,
    };
  }
  return {
    kind: "drift",
    started: s,
    current: c,
    // 🔴 这句要说清「现在没坏、重启才坏」——否则读的人会去查一个当下并不存在的故障。
    line: `启动时 ${s} → 现在 PATH 上是 ${c}。`
      + "**当前运行不受影响**（它用的是启动时那份进程），但**下一次重启会用新的那个**；"
      + "若新版本不在 agent-node 的验证清单里，节点会拒绝启动（#1615）。"
      + "旧二进制通常还在 ~/.grok/downloads/，可用 GROK_BINARY=<旧二进制> anet node start <node> 先恢复。",
  };
}
