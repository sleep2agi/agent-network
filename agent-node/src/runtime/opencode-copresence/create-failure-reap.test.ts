// #1625 — a create request that fails post-spawn validation must not leave a
// live generation behind. These cases pin the reaper's decisions; the end-to-end
// doorbell case (a real spawned launcher) lives in node-name-652.test.ts.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reapFailedOpencodeCreate } from "../create-node-daemon.js";
import { LAUNCH_HEALTH_FILE, liveLaunchResidue, readLiveProcess } from "./launcher-health.js";

const base = {
  alias: "v2-child",
  childWorkDir: "/tmp/t1625/daemon",
  childDir: "/tmp/t1625/daemon/.anet/nodes/v2-child",
  childConfigPath: "/tmp/t1625/daemon/.anet/nodes/v2-child/config.json",
  log: () => {},
  warn: () => {},
};

describe("#1625 failed create reaper", () => {
  test("stops the launcher it spawned through the child handle", async () => {
    const killed: string[] = [];
    let launcherAlive = true;
    const reap = await reapFailedOpencodeCreate({
      ...base,
      launcherPid: 4242,
      launcher: { kill: (signal) => { killed.push(String(signal)); launcherAlive = false; return true; } },
      alive: (pid) => (pid === 4242 ? launcherAlive : false),
      stopChild: async () => ({ ok: true, detail: "stopped" }),
      residueOf: () => ({ borrowed: false, alive: [] }),
      sleep: async () => {},
    });
    expect(killed).toEqual(["SIGTERM"]);
    expect(reap.status).toBe("reaped");
    expect(reap.residue).toEqual([]);
  });

  test("escalates recorded generation pids to SIGKILL and stays honest about the outcome", async () => {
    const killed: string[] = [];
    const alive = new Set([101, 102]);
    const reap = await reapFailedOpencodeCreate({
      ...base,
      launcherPid: -1,
      stopChild: async () => ({ ok: false, detail: "anet node stop exit=1: cannot prove stopped" }),
      residueOf: () => ({
        borrowed: false,
        alive: [...alive].map((pid) => ({ pid, role: "bridge", ticks: "t1" })),
      }),
      readLive: () => ({ ticks: "t1" }),
      kill: (pid, signal) => {
        killed.push(`${pid}:${signal}`);
        if (signal === "SIGKILL") alive.delete(pid);
      },
      residueGraceMs: 100,
      sleep: async () => {},
    });
    expect(killed).toEqual(["101:SIGTERM", "102:SIGTERM", "101:SIGKILL", "102:SIGKILL"]);
    expect(reap.status).toBe("reaped");
  });

  test("reports residue pids instead of acking a clean failure", async () => {
    const warns: string[] = [];
    const reap = await reapFailedOpencodeCreate({
      ...base,
      launcherPid: -1,
      warn: (m) => { warns.push(m); },
      stopChild: async () => ({ ok: false, detail: "boom" }),
      residueOf: () => ({ borrowed: false, alive: [{ pid: 777, role: "bridge", ticks: "t9" }] }),
      readLive: () => ({ ticks: "t9" }),
      kill: () => {},
      residueGraceMs: 50,
      sleep: async () => {},
    });
    expect(reap.status).toBe("residue");
    expect(reap.residue).toEqual([777]);
    expect(warns.join("\n")).toContain("pids=777");
  });

  test("never signals a pid whose start ticks moved (pid reuse)", async () => {
    const killed: number[] = [];
    const reap = await reapFailedOpencodeCreate({
      ...base,
      launcherPid: -1,
      stopChild: async () => ({ ok: true, detail: "stopped" }),
      residueOf: () => ({ borrowed: false, alive: [{ pid: 555, role: "tui", ticks: "recorded" }] }),
      readLive: () => ({ ticks: "reused-by-someone-else" }),
      kill: (pid) => { killed.push(pid); },
      residueGraceMs: 50,
      sleep: async () => {},
    });
    expect(killed).toEqual([]);
    expect(reap.status).toBe("residue");
    expect(reap.residue).toEqual([555]);
  });

  test("a borrowed V1 host generation is handed back, not killed", async () => {
    const killed: number[] = [];
    const reap = await reapFailedOpencodeCreate({
      ...base,
      launcherPid: -1,
      stopChild: async () => ({ ok: false, detail: "BORROWED_V1_STOP_OWNER_UNAVAILABLE" }),
      residueOf: () => ({ borrowed: true, alive: [] }),
      kill: (pid) => { killed.push(pid); },
      sleep: async () => {},
    });
    expect(killed).toEqual([]);
    expect(reap.status).toBe("handed_to_host");
  });
});

describe("#1625 liveLaunchResidue", () => {
  test("only enumerates records whose pid + start ticks still match", () => {
    const dir = mkdtempSync(join(tmpdir(), "t1625-health-"));
    try {
      const self = readLiveProcess(process.pid);
      expect(self).toBeDefined();
      const configPath = join(dir, "config.json");
      writeFileSync(configPath, "{}", { mode: 0o600 });
      writeFileSync(join(dir, LAUNCH_HEALTH_FILE), JSON.stringify({
        version: 1,
        generation: "ses_t1625",
        writtenAt: 1,
        bridge: { pid: process.pid, ticks: self!.ticks, parent: 1, state: "S" },
        // Same pid, stale ticks: a reused pid must never be enumerated.
        serve: { pid: process.pid, ticks: "0", parent: 1, state: "S" },
      }), { mode: 0o600 });
      writeFileSync(join(dir, "opencode-attach.json"), JSON.stringify({
        pid: process.pid, startTicks: self!.ticks, pane: "%1", gen: "ses_t1625",
      }), { mode: 0o600 });

      expect(liveLaunchResidue(dir, configPath)).toEqual({
        borrowed: false,
        alive: [
          { pid: process.pid, role: "bridge", ticks: self!.ticks },
          { pid: process.pid, role: "tui", ticks: self!.ticks },
        ],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no records means nothing provable is alive", () => {
    const dir = mkdtempSync(join(tmpdir(), "t1625-empty-"));
    try {
      const configPath = join(dir, "config.json");
      writeFileSync(configPath, "{}", { mode: 0o600 });
      expect(liveLaunchResidue(dir, configPath)).toEqual({ borrowed: false, alive: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
