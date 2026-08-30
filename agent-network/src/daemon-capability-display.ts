// #1545 —— 把 hub 上那几格「这台 daemon 现在能不能建节点」渲染成人能读的话。
//
// 这是 #1545 的第一个病灶(「**没有人读**」)的收尾:daemon 从 #1353 起就在上报
// `can_create_nodes` / `create_nodes_blocked_reason`,hub 也一路存到
// `/api/host-supervisors` —— 但 `agent-network/` 和 `dashboard/` 全仓 0 命中。
// 数据走到 API 就停在那里。**不是没人算,是没人念。**
//
// 🔴 这里的全部难点是「**别把几种不同的不知道挤成同一个词**」。
//    一个 3 秒前测出来的 blocked、一个三周前测出来的 blocked、一个从来没报过的,
//    如果都渲染成 "blocked",人就只能靠发探针去问 —— 那正是 #1545 抱怨的处境。

/** hub `/api/host-supervisors` 里与本主题相关的那几格。全部可缺席。 */
export type DaemonCapabilityRow = {
  readonly alias?: string;
  readonly online?: boolean;
  /** hub 侧的最后一次心跳(ISO 串或 epoch ms)。缺席则年龄无法计算。 */
  readonly last_seen_at?: string | number | null;
  readonly can_create_nodes?: boolean;
  readonly create_nodes_blocked_reason?: string;
  /** #1545 —— 上面那一格是**这份 report 发出前多少毫秒**测的。 */
  readonly create_capability_observed_ms_ago?: number;
};

export type CapabilityView =
  /** hub 上根本没有这一格 —— 旧 daemon(agent-node ≤ 2.5.0-preview.54)不上报。 */
  | { readonly kind: "never-reported"; readonly line: string }
  /** 报了 ready/blocked,且知道是多久以前测的。 */
  | { readonly kind: "ready" | "blocked"; readonly ageMs: number; readonly line: string; readonly fix?: CapabilityFix }
  /** 报了 ready/blocked,但**不知道是什么时候测的**(旧 daemon 开机只算一次)。 */
  | { readonly kind: "ready-age-unknown" | "blocked-age-unknown"; readonly line: string; readonly fix?: CapabilityFix };

/** 🔴 修法**按 code 给,不按上游的 detail 给**。
 *
 *  上游 `unsafePathHelp()` 生成的 `Fix:` 那半带完整机器路径,而它**按设计不上报**
 *  (那条会一路走到 Dashboard,「哪台机器的哪个路径缺什么」本身就是一张地图)。
 *  所以跨机器读到的只有 code,这里给的必然是**不含机器路径的通用修法**。
 *
 *  🔴 四类的修法完全不同,混成一句会让人修错方向 —— 2026-08-28 有人一天里撞到
 *     其中两类,看到的是同一条错误,第一反应跑去建 /etc/anet-daemon/path.conf,
 *     而那次实际只要 chmod。
 *
 *  想要**带真实路径的那一份**,只能在那台机器上看它自己的 daemon 日志 ——
 *  下面每条都会把人指过去。 */
export type CapabilityFix = {
  /** 人读的一句话:这一类是什么、为什么会这样。 */
  readonly explain: string;
  /** 🔴 **可以整行粘进终端**的命令,或 null(这一类没有单条命令能修)。
   *
   *  分成两格而不是拼成一句,是因为拼起来之后**没有一条能通过 `bash -n`** ——
   *  中文说明和括号注释会被 shell 当成语法。#1521 修过完全同一个形状:
   *  当时 anet_bin_source 的 Fix 串 `bash -n` rc=2(`$( )` 里的 `\"` 是语法错),
   *  用户粘进去只看到 `syntax error near unexpected token '('`。
   *  **一条"看起来是命令"的说明,比没有命令更糟。** */
  readonly command: string | null;
};

/** 🔴 修法**按 code 给,不按上游的 detail 给**。
 *
 *  上游 `unsafePathHelp()` 生成的 `Fix:` 那半带完整机器路径,而它**按设计不上报**
 *  (那条会一路走到 Dashboard,「哪台机器的哪个路径缺什么」本身就是一张地图)。
 *  所以跨机器读到的只有 code,这里给的必然是**不含机器路径的通用修法** ——
 *  用 `$(command -v anet)` 在目标机器上现解析,而不是把路径搬过来。
 *
 *  🔴 四类的修法完全不同,混成一句会让人修错方向 —— 2026-08-28 有人一天里撞到
 *     其中两类,看到的是同一条错误,第一反应跑去建 /etc/anet-daemon/path.conf,
 *     而那次实际只要一行 chmod。
 *
 *  想要**带真实路径的那一份**,只能在那台机器上看它自己的 daemon 日志。 */
const FIX_BY_REASON: Record<string, CapabilityFix> = Object.freeze({
  anet_bin_identity: {
    explain: "该路径不是 anet 的包内 bin(若设过 ANET_BIN_ABS,先 unset 再重装)",
    command: "npm i -g @sleep2agi/agent-network",
  },
  anet_bin_source: {
    explain: "pin 没有可信来源。在该机器上写信任根 —— 两段都要 sudo,少一个 && 就会断链",
    command:
      "sudo install -d -m 755 /etc/anet-daemon && "
      + "printf 'ANET_BIN_ABS=%s\n' \"$(command -v anet)\" | sudo tee /etc/anet-daemon/path.conf",
  },
  anet_bin_permission: {
    explain: "该二进制 group/other 可写。一行就能修",
    command: "chmod go-w \"$(command -v anet)\"",
  },
  anet_bin_shape: {
    explain: "pin 的路径形态不合法(相对路径,或路径里含软链)。取它的 realpath 重新写进 path.conf",
    command: "readlink -f \"$(command -v anet)\"",
  },
  anet_bin_unknown: {
    // 🔴 没有命令就给 null,**不硬凑一条**。这一类恰恰是"类别拿不到"
    //    (例如安装后二进制被换掉导致校验和不符),硬给一条会让人修错方向。
    explain: "daemon 没能给出类别(例如安装后二进制被换过、校验和不符)。只能看该机器的 daemon 日志取原文",
    command: null,
  },
  anet_bin_pin_unresolved: {
    explain: "旧版 daemon(agent-node 2.5.0-preview.40 及更早)只报这一个笼统原因。升级该机器的 agent-node 并重启 daemon 后才能拿到具体类别",
    command: null,
  },
});

/** 把毫秒渲染成人读的相对时间。**不做四舍五入到"刚刚"** ——
 *  这一格存在的意义就是分辨新鲜和陈旧,含糊化等于把它的功能删掉。 */
export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  if (ms < 1000) return `${Math.round(ms)}ms 前`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s 前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m 前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h 前`;
  return `${Math.floor(h / 24)}d 前`;
}

function parseLastSeen(v: string | number | null | undefined): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return undefined;
}

export function describeCapability(row: DaemonCapabilityRow, nowMs: number): CapabilityView {
  // ── 情况一:这台 daemon 从来没报过这项能力 ────────────────────────────
  // 🔴 **不能当成 false**。#1353 定的规矩是「known-blocked,不是 unknown-treated-as-blocked」:
  //    把没升级的 daemon 一律渲染成"不能建节点",会让人去修一台其实好好的机器。
  if (typeof row.can_create_nodes !== "boolean") {
    return {
      kind: "never-reported",
      line: ("创建能力:未知 —— 这台 daemon 没报过这一格。\n" +
        "    (agent-node 版本早于 preview.55;升级后必须重启 daemon 才生效)"),
    };
  }

  // ── 年龄:hub 的 last_seen_at 加上 daemon 自报的「测完到发出」那段 ────
  // 🔴 绝对时间全部由本地/hub 的钟出,daemon 只提供一个**时长**;
  //    它自己的钟偏移不会污染这个数(见 hub schema 里的说明)。
  const lastSeen = parseLastSeen(row.last_seen_at);
  const observed = row.create_capability_observed_ms_ago;
  const ageKnown = lastSeen !== undefined && typeof observed === "number" && Number.isFinite(observed);
  const ageMs = ageKnown ? Math.max(0, nowMs - lastSeen!) + observed! : undefined;

  if (row.can_create_nodes) {
    if (ageMs === undefined) {
      return {
        kind: "ready-age-unknown",
        // 🔴 这句必须说清「不知道什么时候测的」**以及为什么**。
        //    **agent-node ≤ 2.5.0-preview.54** 的 daemon 在开机时算一次就永久缓存
        //    —— 也就是说这个 ready 可能是几周前的事,而二进制早被换掉了。
        //
        // 🔴 这个版本号原先写的是「preview.67」,**指向一个不存在的版本**:
        //    agent-node 已发布的最高 preview 是 2.5.0-preview.56(.67 是
        //    **agent-network** 的号,两个包的序列被串了)。
        //    实测边界:agent-node 2.5.0-preview.54 的产物里没有
        //    `create_capability_observed_ms_ago`,.55 有。
        //    **所以以后写代际边界一律带包名 + 完整版本号** ——
        //    裸的 `preview.NN` 在一个有三个包各自独立编号的仓里,不指向任何东西。
        line: ("创建能力:可用\n" +
        "    ⚠ 不知道是什么时候测的 —— 该版本开机只算一次。重启它,或升级。"),
      };
    }
    return { kind: "ready", ageMs, line: `创建能力:可用(${formatAge(ageMs)}测)` };
  }

  const reason = row.create_nodes_blocked_reason || "anet_bin_unknown";
  // 🔴 未知 code 不套用任何一条已知修法。本 CLI 可能比那台 daemon 旧,
  //    而"猜一个最像的类别"正是这四类要避免的事。
  const fix: CapabilityFix = FIX_BY_REASON[reason] ?? {
    explain: `未知原因代码 ${reason} —— 本 CLI 可能比那台机器的 anet 旧,升级本机 anet 或看它的 daemon 日志`,
    command: null,
  };
  // 实测 83 列,80 列终端会折一下;拆成两句,每句都在 80 以内。
  const where = "完整原文只在那台机器的 daemon 日志里。\n    (它带真实机器路径,按设计不上报)";
  const body = [
    `    原因:${fix.explain}`,
    fix.command ? `    修法(可整行粘贴):${fix.command}` : "    修法:没有单条命令能修,见上。",
    `    ${where}`,
  ].join("\n");
  if (ageMs === undefined) {
    return {
      kind: "blocked-age-unknown",
      // 🔴 首行只放「状态 + 原因码」,把「不知道什么时候测的」挪到缩进行。
      //    2026-08-30 macOS 真机验收(Mac打包牛)实测:合成一行约 **99 列**,
      //    80 列终端会折行,而折点落在句子中间。本模块其余细节本来就各占一行,
      //    这一句原先是唯一的例外。
      line: `创建能力:**不可用**(${reason})\n    ⚠ 不知道是什么时候测的 —— 该 daemon 版本开机只算一次,之后不再重测。\n${body}`,
      fix,
    };
  }
  return {
    kind: "blocked",
    ageMs,
    line: `创建能力:**不可用**(${reason},${formatAge(ageMs)}测)\n${body}`,
    fix,
  };
}

/* ════════════════════════════════════════════════════════════════════════
 * 2026-08-30 实测催生 —— 「取不到这一格」有五种原因,以前全说成「连不上 hub」。
 *
 * Mac mini 上跑 `anet daemon list`,它印的是「连不上 hub」。同一台机器同一刻:
 *
 *     GET /health                 → 200,0.79s      ← hub 完全可达
 *     GET /api/host-supervisors   → 401 unauthorized
 *
 * hub 好得很,是**这台机器的 CLI 没有凭据**(daemon 自己带 token 所以注册成功了,
 * CLI 没有)。而「连不上」会把人支去查网络、查隧道、查 hub 死没死 —— 全是白查,
 * 要跑的是 `anet login`。**一句指错方向的报错,比不报错更贵。**
 *
 * 🔴 这与 #473 给 SSE 明细定的规矩是同一条,那条注释就在本仓 cli.ts 里:
 *    「非 admin 拿到 403,把它渲染成 `0 connected` 是个 LIE,读起来像 hub 死了」。
 *    同一个错误形状,在同一个仓里,已经被解决过一次。
 * ════════════════════════════════════════════════════════════════════════ */

/** 取 `/api/host-supervisors` 失败时的**原因**。以前这五种共用一个 `null`。 */
export type CapabilityFetchFailure =
  | { readonly why: "no-hub" }
  | { readonly why: "unauthorized"; readonly status: number }
  | { readonly why: "http"; readonly status: number }
  | { readonly why: "bad-body" }
  | { readonly why: "unreachable"; readonly detail?: string };

/** 每一种都必须说出**两件事**:到底是什么挡住了,以及下一步该敲什么。
 *  尾巴统一带上「本地清单不需要网络」—— 那是这条命令没有整个失败的原因,
 *  用户看到「查不到」时最先怕的就是"上面那些是不是也不可信了"。 */
export function describeFetchFailure(f: CapabilityFetchFailure): string {
  const TAIL = "\n    (本地清单不需要网络,上面那些信息仍然有效)";
  switch (f.why) {
    case "no-hub":
      return "创建能力:查不到 —— 本机还没配 hub 地址。\n"
        + "    跑 anet init,或这次带上 --hub <url>" + TAIL;
    case "unauthorized":
      /* 🔴 这一句是整块的重点:必须明说 hub 是通的,否则读的人还是会去查网络。 */
      return `创建能力:查不到 —— hub 拒绝了本机的身份(HTTP ${f.status})。\n`
        + "    hub 是通的,要修的是**凭据**不是网络:跑 anet login" + TAIL;
    case "http":
      return `创建能力:查不到 —— hub 返回 HTTP ${f.status}。\n`
        + "    hub 在,但这个接口没给出结果;看 hub 日志" + TAIL;
    case "bad-body":
      return "创建能力:查不到 —— hub 的应答读不懂。\n"
        + "    多半是 hub 比本机 CLI 旧,升级 hub 或降本机 anet" + TAIL;
    case "unreachable":
      return "创建能力:查不到 —— 连不上 hub"
        + (f.detail ? `(${f.detail})` : "") + "。" + TAIL;
  }
}

// ── #1545 —— hub 拒绝 create_node 时那条载荷的渲染 ────────────────────────

/**
 * `create_node` 被拒时 hub 返回的形状(`server/src/tools.ts` 的
 * `daemon_cannot_create_nodes` 分支)。
 *
 * 🔴 它和 `DaemonCapabilityRow` **不是同一个形状**,所以单独一个入口 ——
 *    在调用方做一次字段映射,等于开出**第二个理解这些字段含义的地方**。
 */
export type CreateRejectionPayload = {
  readonly error?: string;
  readonly blocked_reason?: string;
  /** 🔴 已经是**到现在为止**的绝对年龄(hub 在拒绝时把心跳那一段补上了)。
   *  null = 补不出来 —— 见 `capability_age`。 */
  readonly capability_observed_ms_ago?: number | null;
  readonly capability_age?: string;
};

/**
 * 把拒绝载荷渲染成人能读的一段。不是这类拒绝就返回 null,调用方走它原来的通用文案。
 *
 * 🔴 **这里没有第二份年龄公式。** `describeCapability` 里那段
 * `(now − last_seen_at) + observed` 是给「列 daemon」那条路用的;
 * 拒绝这条路上,**hub 已经算好了绝对年龄**(它手里有心跳时间)。
 * 所以这里只做格式化,复用同一个 `formatAge`。
 * 两份年龄算法一旦并排存在,出现分歧时不会有任何东西红。
 *
 * 🔴 **没有新增第六种 kind**,这是刻意的:
 *   `kind` 是**呈现分桶**(禁不禁用、什么色调),不是完整语义。
 *   「daemon 没报年龄」和「hub 没有它的心跳时间」在 UI 上要的处理**完全一样**
 *   (都是 blocked、都给不出年龄),差别在**说哪句话** —— 那放在 `line` 里。
 *   反过来,给共享联合加第六个值,会让所有既有消费者的映射多一个
 *   它们没写过的分支,而**落进 default 的那一支通常是"看起来最正常"的那个**。
 *   区分没有丢:两种 unknown 的 `line` 逐字不同,并有测试钉住。
 */
export function describeCreateRejection(
  payload: CreateRejectionPayload,
): CapabilityView | null {
  if (payload?.error !== "daemon_cannot_create_nodes") return null;

  const reason = payload.blocked_reason || "anet_bin_unknown";
  const fix: CapabilityFix = FIX_BY_REASON[reason] ?? {
    explain: `未知原因代码 ${reason} —— 本端可能比那台机器的 anet 旧,升级本端或看它的 daemon 日志`,
    command: null,
  };
  const where = "完整原文(含真实路径)只在那台机器的 daemon 日志里 —— 它带机器路径,按设计不上报。";
  const body = [
    `原因:${fix.explain}`,
    fix.command ? `修法(可整行粘贴):${fix.command}` : "修法:没有单条命令能修,见上。",
    where,
  ].join("\n");

  const age = payload.capability_observed_ms_ago;
  const ageKnown = payload.capability_age === "known"
    && typeof age === "number" && Number.isFinite(age) && age >= 0;

  if (ageKnown) {
    return {
      kind: "blocked",
      ageMs: age as number,
      line: `这台 daemon 报告它现在**建不了节点**(${reason},${formatAge(age as number)}测)\n${body}`,
      fix,
    };
  }

  // 🔴 两种"给不出年龄",必须说成两句不同的话:动作差一台机器。
  //    legacy       → 去**升级/重启那台 daemon**(它的版本只在开机时算一次)
  //    no-heartbeat → 那台 daemon **报了**,是 hub 这边没有它的心跳时间;
  //                   别去升级它,先看它还在不在线
  const why = payload.capability_age === "unknown_no_heartbeat_time"
    ? "**它报了这个判断,但 hub 这边没有它的心跳时间**,所以算不出是多久以前的 —— 先看这台 daemon 是否还在线,别急着升级它"
    : "**不知道是多久以前测的** —— 该 daemon 版本在开机时算一次就不再重测,这个结论可能早就过期了。重启或升级它";
  return {
    kind: "blocked-age-unknown",
    line: `这台 daemon 报告它现在**建不了节点**(${reason});${why}\n${body}`,
    fix,
  };
}
