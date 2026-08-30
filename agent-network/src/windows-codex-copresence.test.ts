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

describe("#1342 —— 探测耗时也要出现在成功路径", () => {
  const src = readFileSync(new URL("../bin/cli.ts", import.meta.url), "utf8");
  const winStart = src.indexOf("async function startWindowsCodexCopresence");
  const winEnd = src.indexOf("async function startCopresenceOrchestration");
  const win = src.slice(winStart, winEnd > winStart ? winEnd : undefined);

  test("成功那行带上 probes / probeMsLast / probeMsMax", () => {
    // 🔴 不能直接 indexOf("connection=pid-attributed") —— 它会先命中**注释里
    //    提到该子串的那一行**(本文件上游的说明注释就写着它)。
    //    必须锚在真正的 `console.log(` 那一行上。第一版我就是这么写的,
    //    这条测试自己把它抓了出来。
    const at = win.indexOf("console.log(`[anet] client-health role=tui");
    expect(at).toBeGreaterThan(-1);
    const line = win.slice(at, win.indexOf("\n", at));
    expect(line).toContain("probes=");
    expect(line).toContain("probeMsLast=");
    expect(line).toContain("probeMsMax=");
  });

  // 🔴 反向见证:失败路径的那份**不能因此被删掉**。两侧都要有样本,才谈得上前后对比。
  //
  //    ⚠️ 第一版我写的是 `expect(win).toContain("probeMsLast=…")` —— **它观察不到**:
  //    删掉失败侧之后,**成功侧仍含同一个子串**,`toContain` 照样命中,变异不红。
  //    必须锚在 `const looking =` 那一行本身。这个洞是双向见证抓出来的。
  test("失败诊断的 [looking] 串里仍带 probeMs", () => {
    const at = win.indexOf("const looking =");
    expect(at).toBeGreaterThan(-1);
    const line = win.slice(at, win.indexOf("\n", at));
    expect(line).toContain("probeMsLast=");
    expect(line).toContain("probeMsMax=");
    expect(line).toContain("probes=");
  });

  // 🔴 被测试用 indexOf 钉住的那个子串必须原样保留(追加在其后是安全的,替换不是)
  test("connection=pid-attributed 这个锚点子串没有被改动", () => {
    expect(win).toContain("connection=pid-attributed");
  });
});
