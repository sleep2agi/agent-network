import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  decideWindowsManagedStop, ensureWindowsPrivateDirectory,
  probeWindowsCreationDate, taskkillWindowsProcessTree,
  type WindowsCopresenceRecord,
} from "./windows-codex-copresence";

const record: WindowsCopresenceRecord = {
  version: 1,
  nodeId: "n",
  createdAt: "2026-08-21T00:00:00Z",
  processes: [
    { role: "appsrv", pid: 101, creationDate: "20260821010101.000000+000", logPath: "a" },
    { role: "bridge", pid: 202, creationDate: "20260821010102.000000+000", logPath: "b" },
  ],
};

describe("Windows native Codex co-presence ownership", () => {
  test("matching PID plus CreationDate is safe to stop", () => {
    const d = decideWindowsManagedStop(record, (pid) => record.processes.find((p) => p.pid === pid)!.creationDate);
    expect(d.safe.map((p) => p.role)).toEqual(["appsrv", "bridge"]);
    expect(d.refused).toEqual([]);
  });

  test("PID reuse is refused rather than killing an unrelated process", () => {
    const d = decideWindowsManagedStop(record, (pid) => pid === 101 ? "different-generation" : null);
    expect(d.safe).toEqual([]);
    expect(d.refused.map((r) => [r.process.role, r.reason])).toEqual([
      ["appsrv", "pid-reused"], ["bridge", "missing"],
    ]);
  });
});

describe.skipIf(process.platform !== "win32")("Windows native process/ACL smoke", () => {
  const root = mkdtempSync(join(tmpdir(), "anet-win-copresence-"));
  const pids: number[] = [];
  afterAll(() => {
    for (const pid of pids) try { taskkillWindowsProcessTree(pid); } catch {}
    rmSync(root, { recursive: true, force: true });
  });

  test("CIM identity and taskkill manage a real Windows process tree", async () => {
    const child = spawn("powershell.exe", ["-NoProfile", "-Command", "Start-Sleep -Seconds 120"], {
      detached: true, windowsHide: true, stdio: "ignore",
    });
    expect(child.pid).toBeGreaterThan(0);
    pids.push(child.pid!);
    let created: string | null = null;
    for (let i = 0; i < 30 && !created; i++) {
      created = probeWindowsCreationDate(child.pid!);
      if (!created) await Bun.sleep(100);
    }
    expect(created).toBeTruthy();
    taskkillWindowsProcessTree(child.pid!);
    await Bun.sleep(200);
    expect(probeWindowsCreationDate(child.pid!)).toBeNull();
    pids.splice(pids.indexOf(child.pid!), 1);
  }, 15_000);

  test("credential directory gets protected native ACLs", () => {
    const dir = join(root, "credentials");
    mkdirSync(dir);
    ensureWindowsPrivateDirectory(dir);
    const quoted = dir.replace(/'/g, "''");
    const output = Bun.spawnSync(["powershell.exe", "-NoProfile", "-Command",
      `(Get-Acl -LiteralPath '${quoted}').AreAccessRulesProtected`], { stdout: "pipe" });
    expect(output.exitCode).toBe(0);
    expect(output.stdout.toString().trim()).toBe("True");
  });
});
