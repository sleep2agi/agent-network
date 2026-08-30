import { describe, test, expect } from "bun:test";
import { classifySessionStatus } from "./session-status-class";

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

  // 正控:大小写与未知值不会被静默归错
  test("大小写不敏感;未知值归 idle 而不是抛错", () => {
    expect(classifySessionStatus("BLOCKED")).toBe("attention");
    expect(classifySessionStatus("Working")).toBe("working");
    expect(classifySessionStatus("some-new-state")).toBe("idle");
  });
});
