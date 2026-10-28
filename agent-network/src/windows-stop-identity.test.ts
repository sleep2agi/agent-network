import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import {
  captureWindowsDescendantIdentities, orchestrateWindowsManagedStop, parseWindowsCapture, settleWindowsManagedStop, windowsCaptureScript, windowsProcessSnapshotScript, parseWindowsProcessSnapshot, findUnaccountedDescendants,
  probeWindowsIdentity, readWindowsIdentity, summarizeTaskkillStderr, isCompleteCimCreationDate,
  type TaskkillOutcome, type WindowsIdentityState, type WindowsManagedIdentity, type WindowsStopOrchestration,
} from "./windows-codex-copresence";

// #1335 见证。🔴 正负见证走 **CLI 实际使用的那一份编排**
// （`orchestrateWindowsManagedStop`，注入 runner/executor）并**观测 kill 调用**。
// 🔴 身份协议**分两种、不混用**：根 = .NET ticks；**后代 = 同一份 CIM 枚举快照里的 CreationDate**。

const root: WindowsManagedIdentity = { role: "bridge", pid: 8100, creationDate: "999" };
const DESC_BIRTH = "2026-10-16T02:41:37.1234560+00:00";
const OTHER_BIRTH = "2026-10-16T09:00:00.0000000+00:00";
const cap = (desc: string) => `CAP:RB=999;RA=999;D=${desc};G=`;

// 现场 run 38587525619 / job 115933379757 的 taskkill stderr 原文。status 数值是**代表值**。
const liveSampleStderr = [
  "ERROR: The process with PID 8744 (child process of PID 7656) could not be terminated.",
  "Reason: There is no running instance of the task.",
  "",
  "ERROR: The process with PID 7656 (child process of PID 8040) could not be terminated.",
  "Reason: There is no running instance of the task.",
].join("\r\n");
const { summary } = summarizeTaskkillStderr(liveSampleStderr);
const nonZeroKill = (): TaskkillOutcome => ({ status: 128, signal: null, stderrSummary: summary, stderrDroppedBytes: 0 });

/** 脚本化环境：按脚本形状路由，并记录**调用序列**与 kill 调用（控制流见证）。 */
function scriptedEnv(opts: { capture: string; probes: string[]; snapshot?: string | null }) {
  const calls: string[] = [];
  const killed: number[] = [];
  let probeIndex = 0;
  const runPowerShell = (script: string): string => {
    if (script.includes("CAP:RB=")) { calls.push("capture"); return opts.capture; }
    if (script.includes("SNAP:")) {
      calls.push("snapshot");
      if (opts.snapshot === null) throw new Error("snapshot failed");
      return opts.snapshot ?? "SNAP:1=0,4=1";   // 非空、与捕获树无关：证明正常退出竞态仍可判 stopped
    }
    const pid = Number(/GetProcessById\((\d+)\)|ProcessId = (\d+)/.exec(script)!.slice(1).filter(Boolean)[0]);
    calls.push(`probe:${pid}`);
    return opts.probes[probeIndex++];
  };
  const runTaskkill = (pid: number): TaskkillOutcome => { calls.push(`kill:${pid}`); killed.push(pid); return nonZeroKill(); };
  return { runPowerShell, runTaskkill, calls, killed };
}

describe("#1335 停止编排（CLI 共用实现）—— 正负见证", () => {
  test("正向：非零 taskkill + 原身份（含已捕获后代）均已 gone ⇒ stopped，且诊断保留", () => {
    const env = scriptedEnv({
      capture: cap(`8744=${DESC_BIRTH}`),
      probes: ["IDSTATE:TICKS=999", "IDSTATE:ABSENT", "CIMSTATE:ABSENT"],
    });
    const stop = orchestrateWindowsManagedStop([root], env);
    expect(stop.verdict.kind).toBe("stopped");
    expect(stop.mustKeepRecord).toBe(false);
    expect(stop.killedPids).toEqual([8100]);
    expect(stop.identities.map((i) => i.pid)).toEqual([8100, 8744]);
    expect(stop.identities[1].kind).toBe("creation");                     // 后代走 CIM 协议
    const diagnostics = stop.verdict.retainedDiagnostics.join("\n");
    expect(diagnostics).toContain("status=128");
    expect(diagnostics).toContain("There is no running instance of the task.");
    // 控制流见证：终止之前**先**重验根身份，且只发一次终止命令。
    // 非零 kill ⇒ 终止后必须取一次进程快照并做**遍历**，再进入裁决探针。
    expect(env.calls).toEqual(["capture", "probe:8100", "kill:8100", "snapshot", "probe:8100", "probe:8744"]);
  });

  test("负控：根 gone 但**已捕获同身份后代 alive** ⇒ 非零，且**不发**终止命令", () => {
    const env = scriptedEnv({
      capture: cap(`8744=${DESC_BIRTH}`),
      probes: ["IDSTATE:ABSENT", "IDSTATE:ABSENT", `CIMSTATE:CREATED=${DESC_BIRTH}`],
    });
    const stop = orchestrateWindowsManagedStop([root], env);
    expect(stop.killedPids).toEqual([]);
    expect(env.killed).toEqual([]);
    expect(stop.verdict.kind).toBe("survived");
    expect(stop.verdict.kind === "survived" && stop.verdict.alive).toEqual(["bridge:desc pid=8744"]);
    expect(stop.mustKeepRecord).toBe(true);
  });

  test("负控：后代 PID 被**无关进程复用**（出生身份变化）⇒ 视为已退出，不报残留、不触碰无关身份", () => {
    const env = scriptedEnv({
      capture: cap(`8744=${DESC_BIRTH}`),
      probes: ["IDSTATE:TICKS=999", "IDSTATE:ABSENT", `CIMSTATE:CREATED=${OTHER_BIRTH}`],
    });
    const stop = orchestrateWindowsManagedStop([root], env);
    expect(stop.verdict.kind).toBe("stopped");                            // 不是 survived
    expect(stop.verdict.retainedDiagnostics.join("\n")).toContain("pid reused; unrelated process left untouched");
  });

  // 🔴 对照见证 = 评审 6207108427 给出的确定性见证（逐字）：
  //     capture CAP:RB=999;RA=999;D=8744=2026-10-16T02:41:37.1234560+00:00;G=
  //     pre-kill IDSTATE:TICKS=999 ; root after IDSTATE:ABSENT ; child after CIMSTATE:CREATED=definitely-not-a-date
  //     旧实现（`CREATED=(.{8,64})` + 不相等即 pid-reused）⇒ verdict=stopped / mustKeepRecord=false（**误绿**）
  //     现实现 ⇒ verdict=unverifiable / mustKeepRecord=true（非法值一律 unknown）
  test("🔴 [评审 6207108427 对照见证] 非法 CreationDate ⇒ unknown（unverifiable + mustKeepRecord），**不得**当 pid-reused 放行", () => {
    const env = scriptedEnv({
      capture: cap(`8744=${DESC_BIRTH}`),
      probes: ["IDSTATE:TICKS=999", "IDSTATE:ABSENT", "CIMSTATE:CREATED=definitely-not-a-date"],
    });
    const stop = orchestrateWindowsManagedStop([root], env);
    expect(stop.verdict.kind).toBe("unverifiable");                 // 曾误判为 pid-reused ⇒ stopped（误绿）
    expect(stop.mustKeepRecord).toBe(true);
    expect(probeWindowsIdentity(8744, DESC_BIRTH, () => "CIMSTATE:CREATED=definitely-not-a-date", "creation")).toBe("unknown");
  });

  test("🔴 creation 分支对照：**合法**但不同的出生时间 ⇒ pid-reused（合法不同才可判复用）", () => {
    const env = scriptedEnv({
      capture: cap(`8744=${DESC_BIRTH}`),
      probes: ["IDSTATE:TICKS=999", "IDSTATE:ABSENT", `CIMSTATE:CREATED=${OTHER_BIRTH}`],
    });
    const stop = orchestrateWindowsManagedStop([root], env);
    expect(stop.verdict.kind).toBe("stopped");
    expect(probeWindowsIdentity(8744, DESC_BIRTH, () => `CIMSTATE:CREATED=${OTHER_BIRTH}`, "creation")).toBe("pid-reused");
  });

  test("🔴 [评审 6207883011 反例] 后代在自己的**死父进程**下仍存活（快照 SNAP:9999=8744）⇒ 必须 unknown，不得判 stopped", () => {
    const env = scriptedEnv({
      capture: cap(`8744=${DESC_BIRTH}`),
      probes: ["IDSTATE:TICKS=999", "IDSTATE:ABSENT", "CIMSTATE:ABSENT"],
      snapshot: "SNAP:9999=8744,8100=0",        // 8100 已不可达，但 8744(已捕获) 下仍有 9999 存活
    });
    const stop = orchestrateWindowsManagedStop([root], env);
    expect(stop.verdict.kind).toBe("unverifiable");     // 旧实现（只从 8100 BFS）会误判 stopped
    expect(stop.mustKeepRecord).toBe(true);
    expect(stop.verdict.retainedDiagnostics.join("\n")).toContain("unaccounted live descendants 9999");
  });

  test("🔴 [评审 2798 收尾] 全机快照**零行**不得证明全部退出 ⇒ 必须 unknown", () => {
    const env = scriptedEnv({ capture: cap(`8744=${DESC_BIRTH}`), probes: ["IDSTATE:TICKS=999", "IDSTATE:ABSENT", "CIMSTATE:ABSENT"], snapshot: "SNAP:" });
    const stop = orchestrateWindowsManagedStop([root], env);
    expect(stop.verdict.kind).toBe("unverifiable");     // 曾误判 stopped（把观测缺口当空集合）
    expect(stop.mustKeepRecord).toBe(true);
    expect(stop.verdict.retainedDiagnostics.join("\n")).toContain("snapshot was empty");
  });

  test("🔴 [Codex P1] 非零 kill 且快照**无法取得/不可解析** ⇒ 必须 unknown", () => {
    for (const snapshot of [null, "nonsense"]) {
      const env = scriptedEnv({ capture: cap(`8744=${DESC_BIRTH}`), probes: ["IDSTATE:TICKS=999", "IDSTATE:ABSENT", "CIMSTATE:ABSENT"], snapshot });
      const stop = orchestrateWindowsManagedStop([root], env);
      expect(stop.verdict.kind).toBe("unverifiable");
      expect(stop.verdict.retainedDiagnostics.join("\n")).toContain("tree not reconciled");
    }
  });

  test("🔴 **遍历本身**的见证（不看根是否可达）：种子＝全部已捕获身份", () => {
    // 他给的反例逐字：种子 {8100,8744}，快照只有 9999=8744 ⇒ 9999 未被记账
    expect(findUnaccountedDescendants([{ pid: 9999, ppid: 8744 }], [8100, 8744])).toEqual([9999]);
    // 旧实现只从根出发会得空 —— 同一快照下用 {8100} 作种子确实得空，正是那条断链
    expect(findUnaccountedDescendants([{ pid: 9999, ppid: 8744 }], [8100])).toEqual([]);
    // 全部退出 ⇒ 无可达者
    expect(findUnaccountedDescendants([], [8100, 8744])).toEqual([]);
    // 快照解析：合法/垃圾
    expect(parseWindowsProcessSnapshot("SNAP:9999=8744,1=0")).toEqual([{ pid: 9999, ppid: 8744 }, { pid: 1, ppid: 0 }]);
    expect(parseWindowsProcessSnapshot("SNAP:")).toEqual([]);
    expect(parseWindowsProcessSnapshot("garbage")).toBeNull();
    // 快照脚本**不**内建根种子（遍历在 JS 侧，种子由调用方给出）
    expect(windowsProcessSnapshotScript()).toContain("Select-Object ProcessId,ParentProcessId");
    expect(windowsProcessSnapshotScript()).not.toContain("8100");
  });

  test("回归：取证脚本的循环变量沿用 `$child`（**订正**：此前说的 `$id`≡只读 `$PID` 不成立——`$id` 与 `$pid` 是**不同**变量名，大小写不敏感只使 `$pid`=`$PID`）", () => {
    // 保留改名（可读性与避免与自动变量族混淆），但不再据此声称"旧脚本必有该碰撞"：
    // 新脚本绿**不能**证明旧脚本存在该碰撞。
    expect(windowsCaptureScript(8100, "999")).toContain("foreach($child in $ids)");
    expect(windowsCaptureScript(8100, "999")).not.toMatch(/foreach\(\$PID\b/);
  });

  test("（编排层）查询 unknown ⇒ verdict 非零且 mustKeepRecord=true（收尾调用由下方 spy 见证验证）", () => {
    const env = scriptedEnv({
      capture: cap(`8744=${DESC_BIRTH}`),
      probes: ["IDSTATE:TICKS=999", "IDSTATE:ABSENT", "garbage-not-a-protocol"],
    });
    const stop = orchestrateWindowsManagedStop([root], env);
    expect(stop.verdict.kind).toBe("unverifiable");
    expect(stop.mustKeepRecord).toBe(true);
    // 编排层断言 verdict/布尔；「是否真的没删记录、没通知离线」由下面的 spy 门控见证**实际观测**。
  });

  test("负控：初检匹配→**取证期间根复用** ⇒ kill 调用为 0，无关身份不被触碰", () => {
    const env = scriptedEnv({
      capture: "CAP:RB=999;RA=888;D=;G=",
      probes: ["IDSTATE:TICKS=888", "IDSTATE:TICKS=888"],
    });
    const stop = orchestrateWindowsManagedStop([root], env);
    expect(stop.killedPids).toEqual([]);
    expect(env.killed).toEqual([]);
    expect(stop.verdict.kind).toBe("unverifiable");
    const diagnostics = stop.verdict.retainedDiagnostics.join("\n");
    expect(diagnostics).toContain("root identity changed during capture");
    expect(diagnostics).toContain("pid reused; unrelated process left untouched");
  });

  test("（结构见证）CLI 使用共享 settle 门控副作用（删记录/通知离线只在 green 发生）", () => {
    const cli = readFileSync(new URL("../bin/cli.ts", import.meta.url), "utf8");
    const start = cli.indexOf("const stop = orchestrateWindowsManagedStop(");
    expect(start).toBeGreaterThan(0);
    const settleAt = cli.indexOf("await settleWindowsManagedStop(stop,", start);
    expect(settleAt).toBeGreaterThan(start);
    const slice = cli.slice(start, settleAt);
    expect(slice).toContain('if (stop.verdict.kind === "survived")');
    expect(slice).toContain('if (stop.verdict.kind === "unverifiable")');
    expect((slice.match(/process\.exit\(1\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(cli.slice(settleAt)).toContain("if (settle.kept)");
  });
});

describe("#1335 取证：后代出生身份必须来自**同一份枚举快照**", () => {
  test("（结构见证）快照同时给出父子关系与出生身份；后代不再二次读取", () => {
    const script = windowsCaptureScript(8100, "999");
    expect(script).toContain("Select-Object ProcessId,ParentProcessId,CreationDate");
    expect(script).toContain("$hit=$procs|?{[int]$_.ProcessId -eq $child}");
    expect(script).toContain("$hit.CreationDate.ToString('o')");
    // 旧形态（枚举 PID → 再逐 PID 读出生身份）必须**不再出现**：正是复审指出的窗口。
    expect(script.includes("ReadBirthTicks $id")).toBe(false);
    // 根仍走未改动的 ticks 协议。
    expect(script).toContain("function ReadBirthTicks([int]$p)");
    expect(script).toContain("ReadBirthTicks 8100");
  });

  test("根代际漂移 ⇒ unknown（不猜），且不返回后代；出生身份读不到/超上限/非法/抛错 ⇒ unknown", () => {
    const run = (out: string) => () => out;
    expect(captureWindowsDescendantIdentities(root, { runPowerShell: run("CAP:RB=888;RA=888;D=;G=") }).unknownReason).toContain("before capture");
    expect(captureWindowsDescendantIdentities(root, { runPowerShell: run("CAP:RB=999;RA=888;D=;G=") }).unknownReason).toContain("changed during capture");
    expect(captureWindowsDescendantIdentities(root, { runPowerShell: run(`CAP:RB=999;RA=999;D=;G=8744`) }).unknownReason).toContain("unreadable during capture");
    expect(captureWindowsDescendantIdentities(root, { runPowerShell: run(cap("1=2026-10-16T02:41:37.1000001+00:00,2=2026-10-16T02:41:37.2000002+00:00,3=2026-10-16T02:41:37.3000003+00:00")), cap: 2 }).unknownReason).toContain("exceeds cap");
    expect(captureWindowsDescendantIdentities(root, { runPowerShell: run("nonsense") }).unknownReason).toContain("not understood");
    expect(captureWindowsDescendantIdentities(root, { runPowerShell: () => { throw new Error("powershell missing"); } }).unknownReason).toContain("capture query failed");
  });

  test("#2869 默认上限必须容纳 CI 上出现过的 139 个后代；显式 cap 仍然生效", () => {
    // CI 现场：node stop windows-picker → descendant count 139 exceeds cap 16 → STOP_TIMEOUT。
    // 这里用同一形状的取证串直接验：默认上限不再误伤，而显式收紧仍然拦得住。
    // 出生身份必须是 7 位小数（与 DESC_BIRTH 同形），否则 parser 直接判 "not understood"
    const many = Array.from({ length: 139 }, (_, i) => `${8000 + i}=2026-10-16T02:41:37.${String(i).padStart(7, "0")}+00:00`).join(",");
    const out = cap(many);
    const byDefault = captureWindowsDescendantIdentities(root, { runPowerShell: () => out });
    expect(byDefault.unknownReason).toBeUndefined();
    expect(byDefault.identities).toHaveLength(139);
    const tightened = captureWindowsDescendantIdentities(root, { runPowerShell: () => out, cap: 16 });
    expect(tightened.unknownReason).toContain("exceeds cap 16");
  });

  test("合规取证：后代身份带 kind=creation 且出生身份取自枚举", () => {
    const captured = captureWindowsDescendantIdentities(root, { runPowerShell: () => cap(`8744=${DESC_BIRTH},7656=2026-10-16T02:41:37.5555555+00:00`) });
    expect(captured.unknownReason).toBeUndefined();
    expect(captured.identities).toEqual([
      { role: "bridge:desc", pid: 8744, creationDate: DESC_BIRTH, kind: "creation" },
      { role: "bridge:desc", pid: 7656, creationDate: "2026-10-16T02:41:37.5555555+00:00", kind: "creation" },
    ]);
    expect(parseWindowsCapture("CAP:RB=999;RA=SKIP;D=;G=")).toEqual({ rootBefore: "999", rootAfter: "SKIP", descendants: [], gaps: [] });
  });
});

describe("#1335 身份协议与受控诊断（纯函数，非 CLI/原生证据替身）", () => {
  test("creation 协议边界：非法秒/偏移/日期在共享编排中保持 unknown", () => {
    for (const bad of [
      "2026-10-16T02:41:60.1234560+00:00", "2026-10-16T02:41:37.1234560+99:99",
      "2026-10-16T02:41:37.1234560+14:01", "2026-10-16T02:41:37.123456+00:00",
      "2026-02-30T02:41:37.1234560+00:00",
    ]) {
      const env = scriptedEnv({ capture: cap(`8744=${DESC_BIRTH}`),
        probes: ["IDSTATE:TICKS=999", "IDSTATE:ABSENT", `CIMSTATE:CREATED=${bad}`] });
      const stop = orchestrateWindowsManagedStop([root], env);
      expect(stop.verdict.kind).toBe("unverifiable");
      expect(stop.mustKeepRecord).toBe(true);
    }
  });

  test("round-trip 格式均可精确往返，最后一位小数也不可丢失", () => {
    for (const birth of [DESC_BIRTH, "2024-02-29T01:02:03.1234567Z", "2024-02-29T01:02:03.1234567"]) {
      expect(probeWindowsIdentity(8744, birth, () => `CIMSTATE:CREATED=${birth}`, "creation")).toBe("alive");
    }
    const oneTickLater = DESC_BIRTH.replace("1234560", "1234561");
    expect(probeWindowsIdentity(8744, DESC_BIRTH, () => `CIMSTATE:CREATED=${oneTickLater}`, "creation")).toBe("pid-reused");
    expect(probeWindowsIdentity(8744, "not-a-date", () => "CIMSTATE:ABSENT", "creation")).toBe("unknown");
    expect(isCompleteCimCreationDate(DESC_BIRTH + "\n")).toBe(false);
  });

  const p = "IDSTATE:";
  test("双协议各自精确相等：ticks（根）/ CIM CreationDate（后代）；缺省/非法一律 unknown", () => {
    expect(probeWindowsIdentity(8100, "999", () => `${p}ABSENT`)).toBe("gone");
    expect(probeWindowsIdentity(8100, "999", () => `${p}TICKS=999`)).toBe("alive");
    expect(probeWindowsIdentity(8100, "999", () => `${p}TICKS=888`)).toBe("pid-reused");
    expect(probeWindowsIdentity(8744, DESC_BIRTH, () => `CIMSTATE:CREATED=${DESC_BIRTH}`, "creation")).toBe("alive");
    expect(probeWindowsIdentity(8744, DESC_BIRTH, () => `CIMSTATE:CREATED=${OTHER_BIRTH}`, "creation")).toBe("pid-reused");
    expect(probeWindowsIdentity(8744, DESC_BIRTH, () => "CIMSTATE:ABSENT", "creation")).toBe("gone");
    for (const bad of ["", `${p}TICKS=999\nnoise`, "not-a-protocol", "CIMSTATE:ERROR"]) {
      expect(probeWindowsIdentity(8100, "999", () => bad)).toBe("unknown");
    }
    // creation 分支的**非法值**必须是 unknown（曾误判 pid-reused）；期望值非法同样 unknown。
    for (const bad of ["CIMSTATE:CREATED=definitely-not-a-date", "CIMSTATE:CREATED=2026-13-45T99:99:99.1234567+00:00", "CIMSTATE:CREATED=", "CIMSTATE:CREATED=2026-10-16T02:41:37.1234567+00:00\nnoise"]) {
      expect(probeWindowsIdentity(8744, DESC_BIRTH, () => bad, "creation")).toBe("unknown");
    }
    expect(probeWindowsIdentity(8744, "not-a-date", () => `CIMSTATE:CREATED=${DESC_BIRTH}`, "creation")).toBe("unknown");
    expect(isCompleteCimCreationDate(DESC_BIRTH)).toBe(true);
    expect(isCompleteCimCreationDate("2026-02-30T00:00:00.1234567+00:00")).toBe(false);   // 非法日期
    expect(isCompleteCimCreationDate("")).toBe(false);
    expect(probeWindowsIdentity(8100, "999", () => { throw new Error("access denied"); })).toBe("unknown");
    expect(readWindowsIdentity(8100, () => `${p}ABSENT`)).toEqual({ kind: "absent" });
    const { summary: kept, droppedBytes } = summarizeTaskkillStderr(`${liveSampleStderr}\r\nunshaped-line-with=secret`);
    expect(kept).toContain("ERROR: The process with PID 8744");
    expect(kept).not.toContain("secret");
    expect(droppedBytes).toBeGreaterThan(0);
  });
});

describe("#1335 记录清理／本地节点停止回调门控（spy；真实文件／Hub 请求未验）", () => {
  const orchestrationWith = (kind: "stopped" | "survived" | "unverifiable"): WindowsStopOrchestration => ({
    verdict: kind === "stopped"
      ? { kind: "stopped", retainedDiagnostics: [] }
      : kind === "survived"
        ? { kind: "survived", alive: ["bridge:desc pid=8744"], retainedDiagnostics: [] }
        : { kind: "unverifiable", unknown: ["bridge:desc pid=8744"], retainedDiagnostics: [] },
    killedPids: [], identities: [], mustKeepRecord: kind !== "stopped",
  });

  test("survived / unverifiable ⇒ 删记录 0 次、stopNode 0 次（两种失败**确实没发生这些调用**）", async () => {
    for (const kind of ["survived", "unverifiable"] as const) {
      const calls: string[] = [];
      const settle = await settleWindowsManagedStop(orchestrationWith(kind), {
        removeRecord: () => { calls.push("removeRecord"); },
        stopNode: async () => { calls.push("stopNode"); return "stopped"; },
      });
      expect(calls).toEqual([]);
      expect(settle).toEqual({ kept: true, nodeStopInvoked: false });
    }
  });

  test("stopped ⇒ 删记录 1 次、stopNode 1 次，顺序为 删记录→stopNode（分辨力：同场景翻转 verdict 即翻转调用）", async () => {
    const calls: string[] = [];
    const settle = await settleWindowsManagedStop(orchestrationWith("stopped"), {
      removeRecord: () => { calls.push("removeRecord"); },
      stopNode: async () => { calls.push("stopNode"); return { status: "stopped", pid: 8100 }; },
    });
    expect(calls).toEqual(["removeRecord", "stopNode"]);
    expect(settle.kept).toBe(false);
    expect(settle.nodeStopInvoked).toBe(true);
    expect(settle.stopResult).toEqual({ status: "stopped", pid: 8100 });
  });

  test("（结构见证）CLI 的 stopNode 只可能在 settle 之后（非 green 提前退出）；Hub 通知在更后（本片未验）", () => {
    const cli = readFileSync(new URL("../bin/cli.ts", import.meta.url), "utf8");
    const settleAt = cli.indexOf("await settleWindowsManagedStop(stop,");
    expect(settleAt).toBeGreaterThan(0);
    expect(cli.slice(settleAt)).toContain("if (settle.kept)");
    // 真正的 Hub 离线通知（notifyServerOffline）在 settle **之外/之后** ⇒ 本片仍记欠项。
    const hubAt = cli.indexOf("notifyServerOffline(resolved.profile, resolved.id)", settleAt);
    expect(hubAt).toBeGreaterThan(settleAt);
  });
});

describe("#1335 原生验证：后代身份协议在真机上精确可往返（Windows runner 才跑）", () => {
  // Why an explicit timeout: the body spawns cmd.exe, then runs three PowerShell
  // invocations (birth ticks / capture / taskkill) plus a 1.5 s settle wait. On a
  // cold Windows runner that regularly costs 6–9 s, and bun's default per-test
  // timeout is 5 s — so this test failed on CI by timing out, not by asserting
  // anything (see the `timed out after 5000ms` on qa.yml run 40047991237, where the
  // same job passed on 11 of the previous 12 main runs). Each PowerShell call below
  // already allows 30 s, so the test-level budget must be at least that per call.
  test.skipIf(process.platform !== "win32")("（原生）**有真实子进程**时 capture 仍返回合法 CAP 并能枚举到后代", () => {
    const parent = spawn("cmd.exe", ["/c", "start /b ping -n 30 127.0.0.1 > nul & ping -n 30 127.0.0.1 > nul"], { windowsHide: true });
    const ps = (script: string) => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 30_000,
    }).trim();
    try {
      const birth = ps(`[Diagnostics.Process]::GetProcessById(${parent.pid}).StartTime.ToUniversalTime().Ticks.ToString()`);
      const wait = Date.now() + 1500;
      while (Date.now() < wait) { /* 让 cmd 把子进程拉起来 */ }
      const parsed = parseWindowsCapture(ps(windowsCaptureScript(parent.pid, birth)));
      expect(parsed).not.toBeNull();                       // 旧实现（$id）在此会抛错 ⇒ 取证失败
      expect(parsed!.rootBefore).toBe(birth);
      expect(parsed!.descendants.length).toBeGreaterThan(0); // 循环体确实执行过
    } finally {
      try { execFileSync("taskkill.exe", ["/PID", String(parent.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch {}
    }
  }, 60_000);

  test.skipIf(process.platform !== "win32")("CIM `CreationDate` 对同一进程两次读数**完全相同**（不截短／不近似），且与根的 ticks 协议不同域", () => {
    const child = spawn("cmd.exe", ["/c", "ping -n 30 127.0.0.1 > nul"], { windowsHide: true });
    const ps = (script: string) => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 30_000,
    }).trim();
    try {
      const readCreation = () => ps(`(Get-CimInstance Win32_Process -Filter "ProcessId = ${child.pid}").CreationDate.ToString('o')`);
      const first = readCreation();
      const second = readCreation();
      expect(first.length).toBeGreaterThan(8);
      // 🔴 精确相等：这正是后代身份协议 (`kind:"creation"`) 赖以判 alive/pid-reused 的依据。
      expect(second).toBe(first);
      // 与根的 `.NET ticks` 协议**不同域**（两者不混用、互不比较）。
      const ticks = ps(`[Diagnostics.Process]::GetProcessById(${child.pid}).StartTime.ToUniversalTime().Ticks.ToString()`);
      expect(ticks).toMatch(/^\d+$/);
      expect(first).not.toBe(ticks);
    } finally {
      try { execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch {}
    }
  }, 60_000);
});

// #1344: execute the CLI's actual private function against the strict SDK transport;
// source extraction avoids starting the CLI or adding a product-only test hook.
test("#1344 offline notification reaches a strict MCP transport and its target handler", async () => {
  const cli = readFileSync(new URL("../bin/cli.ts", import.meta.url), "utf8");
  const start = cli.indexOf("async function notifyServerOffline(");
  const end = cli.indexOf("// ── stop ──", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const source = new Bun.Transpiler({ loader: "ts" }).transformSync(cli.slice(start, end));
  const statuses: number[] = [];
  const received: unknown[] = [];
  const strictFetch = async (url: string, init: RequestInit) => {
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    transport.onmessage = async (message: any) => {
      if (message.method === "tools/call") received.push(message.params);
      const result = message.method === "initialize"
        ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "offline-fixture", version: "1" } }
        : { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
      await transport.send({ jsonrpc: "2.0", id: message.id, result });
    };
    await transport.start();
    try {
      const response = await transport.handleRequest(new Request(url, init));
      statuses.push(response.status);
      await response.text();
      return response;
    } finally { await transport.close(); }
  };
  const notify = new Function("loadGlobal", "nodeDisplayName", "authHeaders", "fetch", `${source}; return notifyServerOffline;`)(
    () => ({}), (id: string) => id, () => ({}), strictFetch,
  );
  await notify({ hub: "http://127.0.0.1:1", node_id: "n_1344" }, "offline-fixture");
  expect(statuses).toEqual([200, 200]);
  expect(received).toEqual([{ name: "report_status", arguments: { resume_id: "sdk-n_1344", alias: "offline-fixture", status: "offline" } }]);
});
