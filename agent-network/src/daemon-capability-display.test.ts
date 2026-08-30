// #1545 —— 显示层的合同。
//
// 这一层要解决的是 #1545 的第一个病灶:daemon 从 #1353 起就在上报「能不能建节点」,
// hub 也一路存到 /api/host-supervisors —— 但**全仓没有人读**。
//
// 🔴 所以这组测试的重点不是"能不能渲染出字",而是**几种不同的"不知道"必须说成
//    不同的话**。全渲染成 "blocked" 的实现能通过任何只检查"有没有输出"的测试。

import { describe, expect, test } from "bun:test";
import { describeCapability, describeFetchFailure, formatAge, type CapabilityFetchFailure, describeCreateRejection } from "./daemon-capability-display.js";

const NOW = 1_700_000_000_000;
const iso = (ms: number) => new Date(ms).toISOString();

describe("#1545 describeCapability —— 四种状态必须是四句不同的话", () => {
  const cases = {
    ready: { can_create_nodes: true, create_capability_observed_ms_ago: 0, last_seen_at: iso(NOW - 3_000) },
    blocked: { can_create_nodes: false, create_nodes_blocked_reason: "anet_bin_permission",
               create_capability_observed_ms_ago: 0, last_seen_at: iso(NOW - 3_000) },
    "ready-age-unknown": { can_create_nodes: true, last_seen_at: iso(NOW - 3_000) },
    "never-reported": { last_seen_at: iso(NOW - 3_000) },
  } as const;

  test("kind 各不相同", () => {
    const kinds = Object.values(cases).map(c => describeCapability(c, NOW).kind);
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  /* 🔴 这条才是重点:kind 不同不代表**人看到的字**不同。
   * 一个把四种都渲染成 "blocked" 的实现,kind 那条照样绿。 */
  test("🔴 渲染出来的 line 两两不同(不是只有 kind 不同)", () => {
    const lines = Object.values(cases).map(c => describeCapability(c, NOW).line);
    expect(new Set(lines).size).toBe(lines.length);
    for (const l of lines) expect(l.length).toBeGreaterThan(10);
  });

  test("🔴 「没报过」不得渲染成「不可用」—— 那会让人去修一台其实好好的机器", () => {
    const v = describeCapability(cases["never-reported"], NOW);
    expect(v.kind).toBe("never-reported");
    expect(v.line).toContain("未知");
    expect(v.line).not.toContain("不可用");
    // 正控:真正的 blocked 确实说"不可用",证明上一条不是恒真
    expect(describeCapability(cases.blocked, NOW).line).toContain("不可用");
  });

  test("年龄未知那两种必须说出**为什么**,而不只是说「未知」", () => {
    for (const k of ["ready-age-unknown", "never-reported"] as const) {
      const line = describeCapability(cases[k], NOW).line;
      expect(line).toMatch(/开机|版本/);   // 指出是 daemon 版本/开机只算一次导致的
    }
  });
});

describe("#1545 describeCapability —— 年龄", () => {
  test("年龄 = (now − last_seen_at) + daemon 自报的时长", () => {
    const v: any = describeCapability(
      { can_create_nodes: true, last_seen_at: iso(NOW - 60_000), create_capability_observed_ms_ago: 5_000 },
      NOW);
    expect(v.ageMs).toBe(65_000);
    expect(v.line).toContain("1m 前");
  });

  test("last_seen_at 拿不到 → 退回「年龄未知」,不猜 0", () => {
    const v = describeCapability({ can_create_nodes: true, create_capability_observed_ms_ago: 0 }, NOW);
    expect(v.kind).toBe("ready-age-unknown");
  });

  test("daemon 没报时长 → 退回「年龄未知」,即使 last_seen_at 是新的", () => {
    // 🔴 这一格正是缺陷本体:心跳是 3 秒前的,但那个 ready 可能是三周前算的。
    const v = describeCapability({ can_create_nodes: true, last_seen_at: iso(NOW - 3_000) }, NOW);
    expect(v.kind).toBe("ready-age-unknown");
  });

  test.each([
    [0, "0ms 前"], [999, "999ms 前"], [1_000, "1s 前"], [59_999, "59s 前"],
    [60_000, "1m 前"], [3_599_999, "59m 前"], [3_600_000, "1h 前"],
    [86_400_000, "1d 前"], [21 * 86_400_000, "21d 前"],
  ])("formatAge(%i) = %s", (ms, want) => {
    expect(formatAge(ms as number)).toBe(want as string);
  });

  test("🔴 三周和三秒必须渲染成不同的字(这一格的全部意义)", () => {
    const mk = (ms: number) => describeCapability(
      { can_create_nodes: false, create_nodes_blocked_reason: "anet_bin_source",
        last_seen_at: iso(NOW - ms), create_capability_observed_ms_ago: 0 }, NOW).line;
    expect(mk(3_000)).not.toBe(mk(21 * 86_400_000));
  });
});

describe("#1545 修法命令 —— 必须能整行粘贴", () => {
  const CODES = ["anet_bin_identity", "anet_bin_source", "anet_bin_permission",
                 "anet_bin_shape", "anet_bin_unknown", "anet_bin_pin_unresolved"];
  const fixOf = (code: string) => (describeCapability(
    { can_create_nodes: false, create_nodes_blocked_reason: code }, NOW) as any).fix;

  /* 🔴 这条把「照抄前先 bash -n」做成常驻检查,而不是一次性人工核对。
   * #1521 修过完全同一个形状:那条 Fix 串 `bash -n` rc=2,而它是用户唯一拿到的修法。 */
  test("🔴 每条 command 都过 bash -n", () => {
    let checked = 0;
    for (const code of CODES) {
      const cmd = fixOf(code)?.command;
      if (cmd == null) continue;
      const r = Bun.spawnSync(["bash", "-n", "/dev/stdin"], { stdin: Buffer.from(cmd) });
      expect({ code, ok: r.exitCode === 0 }).toEqual({ code, ok: true });
      checked += 1;
    }
    // 分母自证:确实检了几条,不是"全是 null 所以全绿"
    expect(checked).toBe(4);
  });

  test("正控:一条已知语法错的串必须被 bash -n 拒 ⇒ 上面不是恒绿", () => {
    const r = Bun.spawnSync(["bash", "-n", "/dev/stdin"], { stdin: Buffer.from("foo $( bar") });
    expect(r.exitCode).not.toBe(0);
  });

  test("没有单条命令能修的那两类 → command 为 null,**不硬凑一条**", () => {
    for (const code of ["anet_bin_unknown", "anet_bin_pin_unresolved"]) {
      expect(fixOf(code).command).toBeNull();
      expect(fixOf(code).explain.length).toBeGreaterThan(10);
    }
  });

  test("🔴 四类的修法两两不同 —— 混成一句会让人修错方向", () => {
    const four = ["anet_bin_identity", "anet_bin_source", "anet_bin_permission", "anet_bin_shape"];
    const explains = four.map(c => fixOf(c).explain);
    expect(new Set(explains).size).toBe(4);
    const cmds = four.map(c => fixOf(c).command);
    expect(new Set(cmds).size).toBe(4);
  });

  test("未知 code → 不套用任何一条已知修法(本 CLI 可能比那台机器旧)", () => {
    const f = fixOf("anet_bin_from_the_future");
    expect(f.command).toBeNull();
    expect(f.explain).toContain("anet_bin_from_the_future");
  });

  /* 🔴 通用修法里**不能有具体机器路径** —— 那正是 detail 不上报的原因。
   * 允许出现的只有 /etc/anet-daemon 这种全机器相同的系统路径。 */
  test("🔴 修法里不含任何 home 路径,用 $(command -v anet) 在目标机现解析", () => {
    for (const code of CODES) {
      const f = fixOf(code);
      const blob = `${f.explain}\n${f.command ?? ""}`;
      expect(blob).not.toContain("/home/");
      expect(blob).not.toContain("/Users/");
      expect(blob).not.toContain("node_modules");
    }
    // 正控:确实有命令引用了 anet 的位置 —— 只是用现解析的方式
    expect(fixOf("anet_bin_permission").command).toContain("command -v anet");
  });
});

/* 🔴 #1545 —— 这个模块是**跨仓共享**的:Dashboard(另一个仓)通过
 * `@sleep2agi/agent-network/daemon-capability-display` 子路径导入它,在**浏览器里**跑。
 *
 * 共享的不是文案,是**判据**:年龄算法 `(now − last_seen_at) + observed_ms_ago`,
 * 和 code →(explain, command)映射。两边各写一份就会分叉,而
 * 「CLI 说 ready、Dashboard 说 blocked」比两边都沉默更难查。
 *
 * 下面这组钉的是**让共享成立的那几个前提**。它们平时不会有人想起来,
 * 而破坏它们的改动看起来都完全正常(加一个 import、给 build 加一条混淆)。 */
describe("#1545 跨仓共享的前提(Dashboard 在浏览器里 import 这个模块)", () => {
  const pkg = require("../package.json");
  const SUBPATH = "./daemon-capability-display";

  test("package.json 暴露了这个子路径(Node 会按 exports 拦掉未声明的子路径)", () => {
    expect(pkg.exports[SUBPATH]).toBeTruthy();
    expect(pkg.exports[SUBPATH].import).toBe("./dist/src/daemon-capability-display.js");
    expect(pkg.exports[SUBPATH].types).toBe("./dist/src/daemon-capability-display.d.ts");
  });

  test("build 里有对应的独立入口(否则 exports 指向一个不存在的文件)", () => {
    expect(pkg.scripts.build).toContain("bun build src/daemon-capability-display.ts");
  });

  /* 🔴 它**不能**被混淆。同 build 里 client.js / cli.js / node-server.js 走
   * javascript-obfuscator --string-array;把一个给别的仓读的纯格式化函数塞进那条链,
   * 拿到的是一份连报错都难读的依赖。 */
  test("它不在 javascript-obfuscator 的目标列表里", () => {
    const targets = [...String(pkg.scripts.build).matchAll(/javascript-obfuscator (\S+)/g)].map(m => m[1]);
    expect(targets.length).toBeGreaterThan(0);          // 分母自证:确实抓到了目标列表
    expect(targets).not.toContain("dist/src/daemon-capability-display.js");
    // 正控:那三个确实在列 —— 证明上一条不是因为正则没匹配到东西才绿
    expect(targets).toContain("dist/src/client.js");
  });

  /* 🔴 最要紧的一条:这个模块**一个 import 都不能有**。
   * 它要在浏览器里跑;一旦有人加了 `node:fs` / `node:crypto`,
   * Dashboard 的构建**未必会报错**(打包器可能把它 external 掉),
   * 而是**运行时才炸** —— 那种错误离这行改动很远,几乎不可能被联想回来。 */
  test("🔴 源文件没有任何 import / require(它要在浏览器里跑)", () => {
    const src = require("node:fs").readFileSync(
      new URL("./daemon-capability-display.ts", import.meta.url), "utf-8") as string;
    const offenders = src.split("\n")
      .map((l, i) => [i + 1, l] as const)
      .filter(([, l]) => /^\s*import\s|require\s*\(/.test(l));
    expect(offenders).toEqual([]);
    // 正控:同一个模式在**本测试文件**上必须命中(它有 import),证明不是恒空
    const self = require("node:fs").readFileSync(
      new URL("./daemon-capability-display.test.ts", import.meta.url), "utf-8") as string;
    expect(self.split("\n").filter(l => /^\s*import\s|require\s*\(/.test(l)).length).toBeGreaterThan(0);
  });
});

/* 🔴 2026-08-30 macOS 真机验收(Mac打包牛)发现:合成的首行约 99 列,80 列终端折行,
 * 而折点落在句子中间。本模块其余细节本来就各占一行 —— 那一句是唯一的例外。
 * 这条测试把"每一行都要能塞进 80 列"变成常驻判据,而不是靠人再去数一次。
 * 宽度按**显示列**算:CJK 占 2 列,不是按字符数(按字符数会漏掉正好是这一类问题)。 */
function displayWidth(s: string): number {
  let n = 0;
  for (const ch of s) n += /[\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/.test(ch) ? 2 : 1;
  return n;
}

describe("#1545 输出宽度 —— 每一行都要塞进 80 列", () => {
  const NOW = 1_760_000_000_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  const rows: Array<[string, any]> = [
    ["blocked",             { can_create_nodes: false, create_nodes_blocked_reason: "anet_bin_permission", create_capability_observed_ms_ago: 0, last_seen_at: iso(NOW - 3000) }],
    ["blocked-age-unknown", { can_create_nodes: false, create_nodes_blocked_reason: "anet_bin_permission" }],
    ["ready",               { can_create_nodes: true, create_capability_observed_ms_ago: 0, last_seen_at: iso(NOW - 3000) }],
    ["ready-age-unknown",   { can_create_nodes: true }],
    ["never-reported",      {}],
  ];

  // 🔴 分母自证:这 5 行必须真的产出 5 个**不同**的 kind。
  //    少一个,下面的宽度检查会不知不觉少覆盖一种情况而仍然全绿。
  test("五种情况确实产出五个不同的 kind", () => {
    const kinds = new Set(rows.map(([, r]) => describeCapability(r, NOW).kind));
    expect(kinds.size).toBe(5);
  });

  test.each(rows)("%s 的每一行都 <= 80 显示列", (_name, row) => {
    const lines = describeCapability(row as any, NOW).line.split("\n");
    expect(lines.length).toBeGreaterThan(0);
    for (const L of lines) expect(displayWidth(L)).toBeLessThanOrEqual(80);
  });

  // 正控:证明 displayWidth 不是恒返回小值 —— 一个恒 0 的实现能让上面全绿。
  test("displayWidth 把 CJK 算成 2 列(否则上面的检查是空的)", () => {
    expect(displayWidth("abcd")).toBe(4);
    expect(displayWidth("中文")).toBe(4);
    expect(displayWidth("中a")).toBe(3);
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * 2026-08-30 —— 「升级」不是一条完整的修法:daemon 是**长驻进程**。
 *
 * 起因是一台真机。Mac mini 上 daemon 已经跑了很久,anet 是 preview.59,
 * 而这一格要 agent-node >= preview.55 才会上报。原文案说的是「升级它才能看到」——
 * 照着做完,`anet daemon list` **还是显示未知**,因为那个进程里跑的仍是它启动时
 * 载入的那份代码。`buildCapabilities()` 由常驻 daemon 在**进程内**调用
 * (config-apply.ts:555,createCapability 是传进去的实参,不是每次 spawn 出来的),
 * 所以磁盘上换了包,对一个已经在跑的进程**一点影响都没有**。
 *
 * 🔴 这条不能写成「凡是提到升级就必须提到重启」。同文件里
 * 「未知原因代码 …… 升级**本机 anet**」说的是**读的这一端**的 CLI 太旧,
 * 跟那台机器上的 daemon 重不重启毫无关系 —— 那条不该被罚。
 * 判别式落在**升级的是哪个包**上:agent-node = daemon 那一侧 ⇒ 必须重启。
 * ──────────────────────────────────────────────────────────────────────── */
describe("🔴 说了升级 agent-node 的文案,必须同时说重启", () => {
  /* 取集:不扫源码文本(那样会连注释一起收进来,而注释不是用户看到的字),
   * 而是把模块**真正返回**的每一串收齐 —— 和显示层用的是同一个分母。 */
  const collect = (): string[] => {
    const rows: any[] = [
      {},                                                          // never-reported
      { can_create_nodes: true },                                  // ready-age-unknown
      { can_create_nodes: true, create_capability_observed_ms_ago: 0, last_seen_at: iso(NOW - 3_000) },
      { can_create_nodes: false, create_capability_observed_ms_ago: 0, last_seen_at: iso(NOW - 3_000),
        create_nodes_blocked_reason: "anet_bin_permission" },
      { can_create_nodes: false, create_nodes_blocked_reason: "legacy_unknown" },
      { can_create_nodes: false, create_nodes_blocked_reason: "zzz_a_code_this_cli_is_too_old_to_know" },
    ];
    const out: string[] = [];
    for (const code of ["anet_bin_identity", "anet_bin_source", "anet_bin_permission",
                        "anet_bin_shape", "anet_bin_unknown", "anet_bin_pin_unresolved"]) {
      rows.push({ can_create_nodes: false, create_nodes_blocked_reason: code });
    }
    for (const r of rows) {
      const v: any = describeCapability(r, NOW);
      for (const s of [v.line, v.fix?.explain, v.fix?.command]) {
        if (typeof s === "string" && s.length > 0) out.push(s);
      }
    }
    return out;
  };

  /* 🔴 先证明分母不是 0。若哪天包改名或这些串挪走了,下面那条断言会**因为收不到东西**
   * 而恒绿 —— 那和「全都合规」逐字一样。这一条让它改为红。 */
  test("🔴 分母自证:确实收到了提到 agent-node 的文案", () => {
    const hits = collect().filter(s => s.includes("agent-node"));
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  test("🔴 升级 agent-node ⇒ 必须同时出现「重启」", () => {
    const offenders = collect().filter(
      s => s.includes("agent-node") && s.includes("升级") && !s.includes("重启"));
    expect(offenders).toEqual([]);
  });

  /* 正控:判别式要能把「升级本机 anet」放过去,否则这道门只是「凡升级必重启」,
   * 会逼着那条文案写上一句与它无关的重启指示。 */
  test("🔴 正控:「升级本机 anet」这条不提重启,且确实存在", () => {
    const local = collect().filter(s => s.includes("升级本机 anet"));
    expect(local.length).toBeGreaterThanOrEqual(1);
    expect(local.every(s => !s.includes("agent-node"))).toBe(true);
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * 2026-08-30 —— 「连不上 hub」这句话,当时说的不是实话。
 *
 * Mac mini 上 `anet daemon list` 印「连不上 hub」。同一台机器同一刻实测:
 *     GET /health                → 200,0.79s     ← hub 完全可达
 *     GET /api/host-supervisors  → 401
 * 真实原因是**这台机器的 CLI 没凭据**。而「连不上」会让人去查网络、查隧道、
 * 查 hub 死没死 —— 全是白查。**一句指错方向的报错,比不报错更贵。**
 * ──────────────────────────────────────────────────────────────────────── */
describe("🔴 取不到这一格的五种原因,必须说成五句不同的话", () => {
  const ALL: CapabilityFetchFailure[] = [
    { why: "no-hub" },
    { why: "unauthorized", status: 401 },
    { why: "http", status: 503 },
    { why: "bad-body" },
    { why: "unreachable", detail: "ECONNREFUSED" },
  ];

  test("五种各说各的(没有两种撞车)", () => {
    const lines = ALL.map(describeFetchFailure);
    expect(new Set(lines).size).toBe(ALL.length);
  });

  /* 🔴 本体。这条在修复前必红:那时五种全渲染成同一句「连不上 hub」。 */
  test("🔴 只有真连不上才配说「连不上」", () => {
    const saying = ALL.filter(f => describeFetchFailure(f).includes("连不上"));
    expect(saying.map(f => f.why)).toEqual(["unreachable"]);
  });

  /* 🔴 401 是实测那一例。它必须把人指向凭据,而不是网络。 */
  test("🔴 401 说凭据、给 anet login、且明说 hub 是通的", () => {
    const s = describeFetchFailure({ why: "unauthorized", status: 401 });
    expect(s).toContain("401");
    expect(s).toContain("凭据");
    expect(s).toContain("anet login");
    expect(s).toContain("hub 是通的");
    expect(s).not.toContain("连不上");
  });

  test("403 走同一条(也是凭据,不是 hub 挂了)", () => {
    expect(describeFetchFailure({ why: "unauthorized", status: 403 })).toContain("凭据");
  });

  /* 每一种都得让人知道下一步敲什么 —— 只说「查不到」等于没说。 */
  test("🔴 每一种都带一个可执行的下一步", () => {
    const NEXT = ["anet init", "anet login", "hub 日志", "升级 hub", "连不上"];
    for (const f of ALL) {
      const s = describeFetchFailure(f);
      expect(NEXT.some(n => s.includes(n))).toBe(true);
    }
  });

  /* 尾巴那句是这条命令没有整个失败的原因:用户看到「查不到」最先怕的
   * 就是"上面那些是不是也不可信了"。五种都必须留着它。 */
  test("五种都说明本地清单仍然有效", () => {
    for (const f of ALL) expect(describeFetchFailure(f)).toContain("仍然有效");
  });

  test("🔴 分母自证:确实枚举了 5 种 why,不是空跑", () => {
    expect(new Set(ALL.map(f => f.why)).size).toBe(5);
  });
});

/* #1545 —— hub 拒绝 create_node 时那条载荷的渲染。
 *
 * 缺口是实测的:代理路由 `app/api/anet/node-create/route.ts` **已经把 hub 的完整
 * `result` 透传出来**,而向导只渲染 `创建失败:${data.error}` ⇒ 用户看到的是裸的
 * `创建失败:daemon_cannot_create_nodes`,hub 辛苦算出来的 reason/年龄全被丢掉。 */
describe("#1545 describeCreateRejection —— 拒绝载荷的渲染", () => {
  const base = { error: "daemon_cannot_create_nodes", blocked_reason: "anet_bin_permission" };

  test("不是这类拒绝 → 返回 null(调用方走它自己的通用文案)", () => {
    expect(describeCreateRejection({ error: "node_name_conflict" })).toBeNull();
    expect(describeCreateRejection({})).toBeNull();
  });

  test("年龄已知 → kind=blocked,并把年龄写进句子", () => {
    const v = describeCreateRejection({ ...base, capability_age: "known", capability_observed_ms_ago: 65_000 })!;
    expect(v.kind).toBe("blocked");
    expect(v.line).toContain("1m 前");
    expect(v.line).toContain("anet_bin_permission");
  });

  /* 🔴 本组的重点:两种「给不出年龄」必须是**两句不同的话**,因为动作差一台机器。
   *   legacy       → 去升级/重启那台 daemon
   *   no-heartbeat → 它报了,是 hub 没有心跳时间 —— 别急着升级,先看它在不在线 */
  test("🔴 两种 unknown 的 line 逐字不同", () => {
    const legacy = describeCreateRejection({ ...base, capability_age: "unknown_legacy_daemon", capability_observed_ms_ago: null })!;
    const noHb = describeCreateRejection({ ...base, capability_age: "unknown_no_heartbeat_time", capability_observed_ms_ago: null })!;
    expect(legacy.line).not.toBe(noHb.line);
    expect(noHb.line).toContain("心跳");
    expect(noHb.line).toContain("别急着升级");
    expect(legacy.line).toContain("开机时算一次");
    // 反向锚:legacy 那句**不**该出现"心跳",否则上面的区分只是碰巧
    expect(legacy.line).not.toContain("心跳");
  });

  /* 两种 unknown 的 **kind 相同**是刻意的:kind 是呈现分桶(禁不禁用/什么色调),
   * 而这两种在 UI 上要的处理完全一样。区分放在 line 里(上一条已钉)。
   * 写成断言,是为了让下一个人知道这不是漏了,而是选的。 */
  test("两种 unknown 的 kind 相同(呈现分桶一致,语义差别在 line 里)", () => {
    const a = describeCreateRejection({ ...base, capability_age: "unknown_legacy_daemon" })!;
    const b = describeCreateRejection({ ...base, capability_age: "unknown_no_heartbeat_time" })!;
    expect(a.kind).toBe("blocked-age-unknown");
    expect(b.kind).toBe("blocked-age-unknown");
  });

  test("capability_age 说 known 但数字不合法 → 退回 age-unknown,不渲染成刚测的", () => {
    for (const bad of [null, undefined, Number.NaN, -1]) {
      const v = describeCreateRejection({ ...base, capability_age: "known", capability_observed_ms_ago: bad as number })!;
      expect(v.kind).toBe("blocked-age-unknown");
    }
    // 正控:合法值确实走 blocked —— 证明上面不是恒真
    expect(describeCreateRejection({ ...base, capability_age: "known", capability_observed_ms_ago: 0 })!.kind).toBe("blocked");
  });

  /* 🔴 「判据只有一个作者」的可执行断言:同一个 code,拒绝路径给出的修法
   * 必须和列 daemon 那条路径**逐字相同**。哪天有人只改了一处,这条会红。 */
  test("🔴 修法与 describeCapability 同源(同一个 code → 逐字相同的 fix)", () => {
    for (const code of ["anet_bin_identity", "anet_bin_source", "anet_bin_shape",
                        "anet_bin_permission", "anet_bin_unknown", "anet_bin_pin_unresolved"]) {
      const viaList: any = describeCapability(
        { can_create_nodes: false, create_nodes_blocked_reason: code }, NOW);
      const viaReject: any = describeCreateRejection(
        { error: "daemon_cannot_create_nodes", blocked_reason: code });
      expect(viaReject.fix).toEqual(viaList.fix);
    }
  });

  test("未知 code → 不套用任何已知修法(本端可能比那台机器旧)", () => {
    const v: any = describeCreateRejection({ error: "daemon_cannot_create_nodes", blocked_reason: "anet_bin_future" });
    expect(v.fix.command).toBeNull();
    expect(v.fix.explain).toContain("anet_bin_future");
  });

  test("🔴 渲染里不含任何机器路径", () => {
    for (const code of ["anet_bin_identity", "anet_bin_source", "anet_bin_shape", "anet_bin_permission"]) {
      const v = describeCreateRejection({ error: "daemon_cannot_create_nodes", blocked_reason: code })!;
      expect(v.line).not.toContain("/home/");
      expect(v.line).not.toContain("/Users/");
      expect(v.line).not.toContain("node_modules");
    }
    // 正控:上面不是恒真 —— 通用修法确实引用了 anet 的位置,只是现解析
    expect(describeCreateRejection({ error: "daemon_cannot_create_nodes", blocked_reason: "anet_bin_permission" })!
      .line).toContain("command -v anet");
  });

  test("没有 blocked_reason → 兜底到 anet_bin_unknown(不猜一个具体类别)", () => {
    const v: any = describeCreateRejection({ error: "daemon_cannot_create_nodes" });
    expect(v.line).toContain("anet_bin_unknown");
    expect(v.fix.command).toBeNull();
  });
});
