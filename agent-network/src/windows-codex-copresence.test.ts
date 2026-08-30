import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  decideWindowsManagedStop, ensureWindowsPrivateDirectory,
  probeWindowsCreationDate, probeWindowsOwnedLoopbackConnection, taskkillWindowsProcessTree,
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
  test("launcher waits for the real shared bridge before opening the TUI", () => {
    const cli = readFileSync(new URL("../bin/cli.ts", import.meta.url), "utf8");
    const windowsStart = cli.slice(
      cli.indexOf("async function startWindowsCodexCopresence("),
      cli.indexOf("async function startCopresenceOrchestration("),
    );
    const receiptAt = windowsStart.indexOf("bridgeClientHealthReceipt(wsUrl, threadId)");
    const readyAt = windowsStart.indexOf("waitForFileText(bridgeLog, bridgeReceipt", receiptAt);
    const tuiAt = windowsStart.indexOf('console.log(`[anet] ③ opening Codex TUI');
    expect(receiptAt).toBeGreaterThan(0);
    expect(readyAt).toBeGreaterThan(receiptAt);
    expect(tuiAt).toBeGreaterThan(readyAt);
    const birthAt = windowsStart.indexOf("const tuiCreationDate = tui.pid ? probeWindowsCreationDate(tui.pid) : null", tuiAt);
    const pidConnectionAt = windowsStart.indexOf("probeWindowsOwnedLoopbackConnection(tui.pid, tuiCreationDate, port)", tuiAt);
    const healthAt = windowsStart.indexOf("connection=pid-attributed", tuiAt);
    expect(birthAt).toBeGreaterThan(tuiAt);
    expect(pidConnectionAt).toBeGreaterThan(birthAt);
    expect(healthAt).toBeGreaterThan(pidConnectionAt);
    expect(windowsStart.slice(pidConnectionAt, healthAt)).toContain("if (!tuiConnected)");
  });

  test("PID-attributed socket snapshot binds the exact TUI birth before and after enumeration", () => {
    let script = "";
    expect(probeWindowsOwnedLoopbackConnection(303, "638000000000000000", 24700, (s) => {
      script = s;
      return "true\n";
    })).toBe(true);
    expect(script).toContain("$before-ne$birth");
    expect(script).toContain("$after-eq$birth");
    expect(script).toContain("Get-NetTCPConnection");
    expect(probeWindowsOwnedLoopbackConnection(303, "", 24700, () => "true")).toBe(false);
    expect(probeWindowsOwnedLoopbackConnection(303, "638000000000000000", 24700, () => "false")).toBe(false);
  });

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

  test(".NET process identity and taskkill manage a real Windows process tree", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], {
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
    const output = Bun.spawnSync(["icacls.exe", dir], { stdout: "pipe" });
    expect(output.exitCode).toBe(0);
    expect(output.stdout.toString()).not.toContain("(I)");
  });
});

describe("#1342 —— 整张进程表只枚举一次", () => {
  // 🔴 为什么值得一条测试:这是一次**性能**改动,而性能回归不会让任何断言变红。
  //    把 `Get-CimInstance Win32_Process` 挪回 `do{…}while` 里面,
  //    功能完全正确、所有现有测试照样绿 —— 只是每次探测又变回 ~10 秒。
  //    实测那 10 秒占了 `waited` 的 96%(#1628 的 probeMs 量到的)。
  const script = (() => {
    let captured = "";
    probeWindowsOwnedLoopbackConnection(303, "638000000000000000", 24700, (s) => {
      captured = s; return "true\n";
    });
    return captured;
  })();

  test("枚举被提到闭包循环之外", () => {
    expect(script).toContain("$procs=Get-CimInstance Win32_Process");
  });

  test("🔴 do{…}while 的**循环体里**不再有 Get-CimInstance", () => {
    const doStart = script.indexOf("do{");
    const whileEnd = script.indexOf("while($n-gt 0)");
    expect(doStart).toBeGreaterThan(-1);
    expect(whileEnd).toBeGreaterThan(doStart);
    expect(script.slice(doStart, whileEnd)).not.toContain("Get-CimInstance");
  });

  test("整个脚本里 Get-CimInstance 恰好出现一次", () => {
    expect(script.split("Get-CimInstance").length - 1).toBe(1);
  });

  // 反向见证:归属判定的三段仍在(提取不能把它们弄丢)
  test("birth 前后校验与 NetTCPConnection 归属都还在", () => {
    expect(script).toContain("$before-ne$birth");
    expect(script).toContain("$after-eq$birth");
    expect(script).toContain("Get-NetTCPConnection");
    expect(script).toContain("$ids.Contains([int]$_.OwningProcess)");
  });
});
