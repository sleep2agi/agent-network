// #1650 — codex 共存失败路径的收尸判据(单元级)。
//
// 门级证据在 codex-create-failure-cleanup.test.ts;这里钉的是两个纯逻辑:
//  1. 归属门关闭时,收尸器一次都不许碰 `anet node stop`;
//  2. 会话探针只在「本代认领」时读,而且只读、不提供直接 kill 能力。

import { describe, expect, test } from "bun:test";
import { reapFailedCodexCreate } from "./create-node-daemon.js";
import { copresenceSessionNames, copresenceSessionResidue } from "./codex-copresence-session-residue.js";

const base = {
  alias: "codex-node",
  childWorkDir: "/tmp/t1650/daemon",
  childDirName: "codex-node",
  childNodeId: "node_t1650",
  launcherPid: -1,
  log: () => {},
  warn: () => {},
  sleep: async () => {},
};

describe("#1650 codex 会话探针", () => {
  test("拼不出确定名字的 alias 一律不探", () => {
    for (const alias of ["", "  ", ".", "..", "=x", "a\nb"]) {
      expect(copresenceSessionNames(alias)).toBeUndefined();
      let probed = false;
      expect(copresenceSessionResidue(alias, true, () => { probed = true; return true; }))
        .toEqual({ borrowed: false, alive: [] });
      expect(probed).toBe(false);
    }
  });

  test("只有本代认领时才读会话,读的是三个确切名字", () => {
    const seen: string[] = [];
    const probe = (name: string) => { seen.push(name); return name === `${base.alias}-桥`; };

    expect(copresenceSessionResidue(base.alias, false, probe)).toEqual({ borrowed: false, alive: [] });
    expect(seen).toEqual([]);

    expect(copresenceSessionResidue(base.alias, true, probe)).toEqual({
      borrowed: false,
      alive: [{ id: "codex-node-桥", role: "bridge" }],
    });
    expect(seen).toEqual(["codex-node", "codex-node-appsrv", "codex-node-桥"]);
  });
});

describe("#1650 codex 收尸器", () => {
  test("归属门关闭:一次 stop 都不调,也不认领同名会话", async () => {
    const stops: string[] = [];
    let probed = false;
    const reap = await reapFailedCodexCreate({
      ...base,
      teardownGate: () => false,
      stopChild: async (alias) => { stops.push(alias); return { ok: true, detail: "stopped" }; },
      probeSession: () => { probed = true; return true; },
    });
    expect(stops).toEqual([]);
    expect(probed).toBe(false);
    expect(reap.status).toBe("no_live_generation");
    expect(reap.residue).toEqual([]);
    expect(reap.detail).toContain("not proven owned");
  });

  test("归属门放行 + 会话已清:reaped", async () => {
    const stops: string[] = [];
    const reap = await reapFailedCodexCreate({
      ...base,
      teardownGate: () => true,
      stopChild: async (alias) => { stops.push(alias); return { ok: true, detail: "anet node stop ok" }; },
      probeSession: () => false,
    });
    expect(stops).toEqual(["codex-node"]);
    expect(reap.status).toBe("reaped");
    expect(reap.residueKind).toBe("sessions");
  });

  test("会话仍在:报 residue_sessions,不自己 kill-session", async () => {
    const warns: string[] = [];
    const reap = await reapFailedCodexCreate({
      ...base,
      teardownGate: () => true,
      warn: (m) => { warns.push(m); },
      stopChild: async () => ({ ok: false, detail: "anet node stop exit=1: cannot prove stopped" }),
      probeSession: (name) => name === "codex-node-appsrv",
    });
    expect(reap.status).toBe("residue");
    expect(reap.residue).toEqual(["codex-node-appsrv"]);
    expect(warns.join("\n")).toContain("residue sessions=codex-node-appsrv");
    expect(warns.join("\n")).toContain("no direct-kill authority");
  });

  test("stop 失败但没有可证明的残留:如实报 no_live_generation", async () => {
    const reap = await reapFailedCodexCreate({
      ...base,
      teardownGate: () => true,
      stopChild: async () => ({ ok: false, detail: "anet node stop exit=1" }),
      probeSession: () => false,
    });
    expect(reap.status).toBe("no_live_generation");
    expect(reap.detail).toContain("anet node stop failed");
  });
});
