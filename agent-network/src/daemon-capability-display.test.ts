// #1545 —— 显示层的合同。
//
// 这一层要解决的是 #1545 的第一个病灶:daemon 从 #1353 起就在上报「能不能建节点」,
// hub 也一路存到 /api/host-supervisors —— 但**全仓没有人读**。
//
// 🔴 所以这组测试的重点不是"能不能渲染出字",而是**几种不同的"不知道"必须说成
//    不同的话**。全渲染成 "blocked" 的实现能通过任何只检查"有没有输出"的测试。

import { describe, expect, test } from "bun:test";
import { describeCapability, formatAge } from "./daemon-capability-display.js";

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
