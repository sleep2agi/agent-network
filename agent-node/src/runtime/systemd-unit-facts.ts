// 2026-10-31 —— systemd unit 事实的短 TTL 读取器（restart_supervised 重构的第一步）。
//
// 为什么需要它：判断「这台节点会不会被守护进程拉起」时，真正相关的是 unit 文件里的
// `Restart=` / `Type=` / `LoadState=`。但它们**不是启动期常量**：
//
//   `systemctl daemon-reload` 可以在进程**运行期间**改掉这些值 ——
//   进程不重启，而下一次退出时的处置已经变了。
//
// ⇒ 所以「静态」这个词不能绑进程，只能绑一个**短 TTL**：
//   判据不是「静态还是动态」，而是**「重读能不能看出来」** —— 能，就必须重读。
//   （对照：`exit75_refork` 由启动时的 env 决定，重读也看不出变化 ⇒ 那个才能绑进程。）
//
// 🔴 三态，不许折成布尔：
//     loaded + Type=service + Restart≠∅  ⇒ supervised
//     其它可读结果                          ⇒ not_supervised
//     **读不到 / 命令失败 / 无 systemd**     ⇒ unknown（绝不折成 false）
//   "unknown 折成 false" 的后果是：把「我不知道它会不会被拉起」说成「它不会被拉起」，
//   而这两件事在告警上要走完全不同的处置。
//
// 🔴 缓存本身也要可审计：`cacheBuiltAt()` 给出这份事实是什么时候读的。
//   判据：`age(cache) ≤ age(process)` —— 否则你无法区分「它没变」与「你很久没看」。

export interface UnitFacts {
  /** systemctl show 的 LoadState：loaded / not-found / masked / error 等。 */
  loadState: string;
  /** Type：service / oneshot / notify / … */
  type: string;
  /** Restart：no / always / on-failure / on-abnormal / on-success / on-abort / on-watchdog。空串 = 未设置。 */
  restart: string;
  /**
   * SuccessExitStatus：被视为「成功退出」的额外退出码/信号名列表（空格分隔）。
   * 🔴 2026-10-31 修正：决定 exit 75 会不会被重新拉起的，是 **Restart= 与 SuccessExitStatus=**，
   *    不是 RestartPreventExitStatus（后者只在「不重启的那些状态」上做例外）。
   *    而且未设置时 systemd 打印字面量 `[unprintable]`，**不是 `0`** ——
   *    任何把它当 0 解析的代码都会静默误判。
   */
  successExitStatus: string;
  readAt: number;
}

export type UnitFactsReader = (unit: string) => UnitFacts;

export type Supervision =
  | { kind: "supervised"; respawnsOnExit75: boolean | null; facts: UnitFacts }
  | { kind: "not_supervised"; reason: string; respawnsOnExit75: false; facts: UnitFacts }
  | { kind: "unknown"; reason: string };

/**
 * 2026-10-31 —— exit 75 会不会被重新拉起？
 *
 * `Restart=` 的语义按退出状态分类，而 75 属于「失败」还是「成功」由 `SuccessExitStatus=` 决定：
 *   always     ⇒ 无论成败都重启          ⇒ true
 *   no         ⇒ 从不重启                ⇒ false
 *   on-failure ⇒ 仅失败时重启 ⇒ 75 在 SuccessExitStatus 里（=被当成功）则不重启 ⇒ 取反
 *   on-success ⇒ 仅成功时重启 ⇒ 75 在列表里才重启
 *   其它（on-abnormal/on-abort/on-watchdog/on-abnormal…）⇒ 与 75 的常规退出无关 ⇒ null
 *
 * ⇒ 返回 null = 「我算不出来」，不是 false。**不知道不能折成「不会重启」。**
 */
export function respawnsOnExit75(restart: string, successExitStatus: string): boolean | null {
  const list = successExitStatus
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  // `[unprintable]` 是 systemd 对「未设置」的字面量输出，不能当数字解析。
  const seventyFiveIsSuccess = list.includes("75");
  switch (restart) {
    case "always":
      return true;
    case "no":
      return false;
    case "on-failure":
      return !seventyFiveIsSuccess;
    case "on-success":
      return seventyFiveIsSuccess;
    default:
      return null;
  }
}

export interface UnitFactsCache {
  /** 读一次（TTL 内命中缓存）。失败返回 null —— 由调用方决定是 unknown 还是重试。 */
  get(unit: string): UnitFacts | null;
  /** 这份缓存是什么时候建立的；从未成功过则 null。 */
  cacheBuiltAt(): number | null;
  /** 便于测试与日志：当前 TTL。 */
  readonly ttlMs: number;
}

/**
 * `ttlMs` 默认 30s：`daemon-reload` 之后到下一次心跳之间通常远小于这个数，
 * 而 30s 的 `systemctl show` 开销在多节点上是可接受的（每节点每 30s 一次）。
 * 设成 0 ⇒ 每次重读（最保守）；设成负数 ⇒ 视为 0。
 */
export function createUnitFactsCache(
  reader: UnitFactsReader,
  opts: { ttlMs?: number; now?: () => number } = {},
): UnitFactsCache {
  const ttlMs = Math.max(0, opts.ttlMs ?? 30_000);
  const now = opts.now ?? Date.now;
  let builtAt: number | null = null;
  let entry: { unit: string; facts: UnitFacts } | null = null;

  return {
    ttlMs,
    cacheBuiltAt: () => builtAt,
    get(unit: string): UnitFacts | null {
      const t = now();
      if (entry && entry.unit === unit && builtAt !== null && t - builtAt < ttlMs) {
        return entry.facts;
      }
      let facts: UnitFacts;
      try {
        facts = reader(unit);
      } catch {
        // 🔴 读失败**不写缓存**：写进去会让「暂时读不到」在 TTL 内看起来像「读到了」。
        //    这也保证下一次调用会立刻重试。
        return null;
      }
      entry = { unit, facts };
      builtAt = t;
      return facts;
    },
  };
}

/** 把 unit 事实归类成三态。**不在这里做任何“猜”**：缺字段就是 unknown。 */
export function classifySupervision(facts: UnitFacts | null): Supervision {
  if (!facts) return { kind: "unknown", reason: "unit_facts_unavailable" };
  if (!facts.loadState || !facts.type) {
    return { kind: "unknown", reason: "unit_facts_incomplete" };
  }
  if (facts.loadState !== "loaded") {
    return { kind: "not_supervised", reason: `load_state:${facts.loadState}`, respawnsOnExit75: false, facts };
  }
  if (facts.type !== "service") {
    return { kind: "not_supervised", reason: `type:${facts.type}`, respawnsOnExit75: false, facts };
  }
  if (!facts.restart) {
    return { kind: "not_supervised", reason: "restart_unset", respawnsOnExit75: false, facts };
  }
  if (facts.restart === "no") {
    return { kind: "not_supervised", reason: "restart_no", respawnsOnExit75: false, facts };
  }
  return {
    kind: "supervised",
    respawnsOnExit75: respawnsOnExit75(facts.restart, facts.successExitStatus),
    facts,
  };
}

/** 解析 `systemctl show -p LoadState,Type,Restart` 的输出（`K=V` 每行一条）。 */
export function parseSystemctlShow(stdout: string, readAt: number): UnitFacts {
  const map = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    map.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return {
    loadState: map.get("LoadState") ?? "",
    type: map.get("Type") ?? "",
    restart: map.get("Restart") ?? "",
    successExitStatus: map.get("SuccessExitStatus") ?? "",
    readAt,
  };
}
