import { describe, test, expect } from "bun:test";
import { classifySessionStatus, summarizeSessions } from "./session-status-class";

describe("#1548 anet status 不能把「卡住」显示成「在干活」", () => {
  // 🔴 这一条是本次修的那个 bug 的红夹具:改之前 blocked/error 返回 "working"
  test("blocked / error 归入 attention,不是 working", () => {
    expect(classifySessionStatus("blocked")).toBe("attention");
    expect(classifySessionStatus("error")).toBe("attention");
  });

  test("真正在推进的仍是 working", () => {
    for (const s of ["working", "running", "busy", "waiting_input"]) {
      expect(classifySessionStatus(s)).toBe("working");
    }
  });

  test("offline 与 idle 不变", () => {
    expect(classifySessionStatus("offline")).toBe("offline");
    expect(classifySessionStatus("idle")).toBe("idle");
    expect(classifySessionStatus("")).toBe("idle");
    expect(classifySessionStatus(undefined)).toBe("idle");
    expect(classifySessionStatus(null)).toBe("idle");
  });

  // 🔴 分母自证:四个类别都必须真的被产出。少一个,上面的断言可能在测一个
  //    塌成两三类的实现而仍然全绿。
  test("四个类别都被产出(否则这组断言覆盖不全)", () => {
    const got = new Set(["idle", "working", "blocked", "offline"].map(classifySessionStatus));
    expect(got).toEqual(new Set(["idle", "working", "attention", "offline"]));
  });

  // 正控:大小写不会被静默归错
  test("大小写不敏感", () => {
    expect(classifySessionStatus("BLOCKED")).toBe("attention");
    expect(classifySessionStatus("Working")).toBe("working");
  });

  // 🔴 这一组是本文件从前**反向钉死**的那条:原先断言
  //    `classifySessionStatus("some-new-state")` 是 `"idle"`,注释还写着
  //    「未知值不会被静默归错」—— 而那一行做的正是静默归错。
  //    去修兜底的人会看到一条红测试,以为自己弄坏了有意的设计。
  test("未知状态归 attention —— 兜底不朝好的一侧", () => {
    expect(classifySessionStatus("some-new-state")).toBe("attention");
    // 服务端将来可能加的形状,举几个具体的:
    expect(classifySessionStatus("paused")).toBe("attention");
    expect(classifySessionStatus("stopped")).toBe("attention");
    expect(classifySessionStatus("degraded")).toBe("attention");
  });

  // 🔴 反向见证:把「缺失」和「有值但不认识」分开。
  //    缺失(没上报过 / null / 空串)不该报警 —— 它是 idle,这一条**没变**。
  //    如果有人把兜底改回 `return "idle"`,上面那组会红;
  //    如果有人图省事把整支都改成 attention,这一组会红。两个方向都有见证。
  test("缺失(空/null/undefined)仍是 idle,不是 attention", () => {
    expect(classifySessionStatus("")).toBe("idle");
    expect(classifySessionStatus(null)).toBe("idle");
    expect(classifySessionStatus(undefined)).toBe("idle");
    expect(classifySessionStatus("idle")).toBe("idle");
  });
});

describe("#1625 summarizeSessions —— 屏幕上那几个数字", () => {
  // 🔴 正控用**当前生产军团的真实构成**(2026-08-31 实测:271 个会话,
  //    127 idle / 143 offline / 1 blocked)。服务端那份分类会把这 1 个 blocked
  //    算进 working,于是它同时出现在 working 和 needs attention 两格。
  const fleet = [
    ...Array.from({ length: 127 }, () => ({ status: "idle" })),
    ...Array.from({ length: 143 }, () => ({ status: "offline" })),
    { status: "blocked" },
  ];

  test("blocked 只进 attention,不进 working", () => {
    const s = summarizeSessions(fleet);
    expect(s.working).toBe(0);
    expect(s.attention).toBe(1);
  });

  test("🔴 四个数加起来 == total(原先是 272 > 271)", () => {
    const s = summarizeSessions(fleet);
    expect(s.idle + s.working + s.attention + s.offline).toBe(s.total);
    expect(s.total).toBe(271);
  });

  // 🔴 这一条钉的是那个「从不执行、一执行就 NaN」的老兜底:
  //    累加器原先只有 {idle, working, offline, total},`acc["attention"]++`
  //    得到 NaN,而 `?? ` 不接 NaN ⇒ 屏幕印 `NaN needs attention`。
  test("attention 是数字,不是 NaN(累加器必须显式初始化它)", () => {
    const s = summarizeSessions([{ status: "blocked" }, { status: "error" }]);
    expect(Number.isNaN(s.attention)).toBe(false);
    expect(s.attention).toBe(2);
  });

  test("空输入给出全 0,不是 NaN 也不是空对象", () => {
    expect(summarizeSessions([])).toEqual({ idle: 0, working: 0, attention: 0, offline: 0, total: 0 });
  });

  test("未知状态进 attention(与 classifySessionStatus 同一套判据)", () => {
    const s = summarizeSessions([{ status: "some-new-state" }, { status: "" }]);
    expect(s.attention).toBe(1);
    expect(s.idle).toBe(1);
  });
});
