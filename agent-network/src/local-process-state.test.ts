import { describe, expect, it } from "bun:test";
import { describeLocalProcess, LOCAL_VS_HUB_NOTE } from "./local-process-state";

describe("doctor 的本机进程一列", () => {
  it("活着时把 pid 一起说出来 —— 好让人能自己去核", () => {
    expect(describeLocalProcess({ kind: "alive", pid: 892216 })).toContain("892216");
    expect(describeLocalProcess({ kind: "alive", pid: 892216 })).toContain("●");
  });

  it("🔴 有 .pid 但进程已死,要说清是**哪个 pid 不在了**,不能只说 stopped", () => {
    const m = describeLocalProcess({ kind: "stale", pid: 308103 });
    expect(m).toContain("308103");
    expect(m).toContain("已不在");
  });

  it("从来没有 .pid,和「有但死了」必须是两句不同的话", () => {
    const none = describeLocalProcess({ kind: "none" });
    const stale = describeLocalProcess({ kind: "stale", pid: 1 });
    expect(none).not.toBe(stale);
    expect(none).not.toContain("已不在");
  });

  it("三种情况都不说无限定的 running/stopped —— 那正是和 node ls 打架的措辞", () => {
    for (const s of [
      { kind: "alive", pid: 1 } as const,
      { kind: "stale", pid: 1 } as const,
      { kind: "none" } as const,
    ]) {
      const m = describeLocalProcess(s);
      expect(m).not.toContain("running");
      expect(m).not.toContain("stopped");
      expect(m).toContain("本机");   // 每一句都点名量的是本机
    }
  });

  it("那句说明必须同时点名两边和各自的去处", () => {
    expect(LOCAL_VS_HUB_NOTE).toContain("本机进程");
    expect(LOCAL_VS_HUB_NOTE).toContain("anet node ls");
    expect(LOCAL_VS_HUB_NOTE).toContain("不一致");
  });
});
