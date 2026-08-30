import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { atomicWritePrivateJson, ensurePrivateDirectory } from "./private-state";

export type WindowsCopresenceRole = "appsrv" | "bridge";

export interface WindowsManagedProcess {
  role: WindowsCopresenceRole;
  pid: number;
  creationDate: string;
  logPath: string;
}

export interface WindowsCopresenceRecord {
  version: 1 | 2;
  nodeId: string;
  createdAt: string;
  marker?: string;
  processes: WindowsManagedProcess[];
}

export function windowsCopresenceRecordPath(nodesDir: string, nodeId: string): string {
  return join(nodesDir, nodeId, "windows-copresence.json");
}

export function windowsCopresenceLogPath(nodesDir: string, nodeId: string, role: WindowsCopresenceRole): string {
  return join(nodesDir, nodeId, `windows-${role}.log`);
}

export function openPrivateAppendLog(path: string): number {
  return openSync(path, "a", 0o600);
}

/** Protect credential-bearing state with native Windows ACLs. */
export function ensureWindowsPrivateDirectory(path: string): void {
  ensurePrivateDirectory(path);
}

export function closeLog(fd: number): void {
  closeSync(fd);
}

export type CreationDateProbe = (pid: number) => string | null;

/** Uses CIM instead of locale-dependent tasklist output. */
export function probeWindowsCreationDate(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const script = `[Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().Ticks`;
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
    }).trim();
    return out || null;
  } catch { return null; }
}

/**
 * Attribute an ESTABLISHED loopback connection to the launched TUI process
 * tree. This is deliberately stronger than counting listeners/connections:
 * an unrelated local client cannot satisfy it.
 */
export function probeWindowsOwnedLoopbackConnection(
  rootPid: number,
  expectedCreationDate: string,
  port: number,
  runPowerShell: (script: string) => string = (script) => execFileSync(
    "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
  ),
): boolean {
  if (!Number.isInteger(rootPid) || rootPid <= 0 || !/^\d+$/.test(expectedCreationDate)
    || !Number.isInteger(port) || port < 1 || port > 65535) return false;
  try {
    const script = [
      `$birth='${expectedCreationDate}'`,
      `$before=try{[Diagnostics.Process]::GetProcessById(${rootPid}).StartTime.ToUniversalTime().Ticks.ToString()}catch{''}`,
      "if($before-ne$birth){'false';exit 0}",
      `$ids=[Collections.Generic.HashSet[int]]::new();[void]$ids.Add(${rootPid})`,
      // 🔴 #1342 —— 整张进程表**只枚举一次**,提到闭包循环之外。
      //
      //    原先 `Get-CimInstance Win32_Process` 写在 `do{…}while` **里面**,
      //    于是每一轮都重新枚举一次整张进程表(至少 2 轮:一轮找到子孙、
      //    一轮确认不再增长)。这是这次探测的主要成本。
      //
      //    实测(2026-08-31,main @ 82820594 的一次真实失败,由 #1628 加的
      //    `probeMs` 量到):**单次探测 9963ms,占 `waited=10363ms` 的 96%**,
      //    而那一跑的 job 本身只用了 106 秒 —— **不是机器慢,是这次调用本来就慢**。
      //    按 ~10 秒/次,`TUI_HEALTH_MS = 25_000` 实际只够 2 次多一点的探测,
      //    而调用方按 400ms 间隔写的循环期望的是几十次。
      //
      //    ⚠️ 语义上有一处**有意的**改变:原先每轮重读进程表,因此循环期间
      //    **新产生**的子孙会被看见;现在用的是一份快照。对这个用途这是更好的
      //    性质 —— 它是一次**归属判定**,一份一致的快照比跨轮拼接的视图更难被
      //    时序戏弄(root 的身份本来就由前后两次 birth 校验夹住)。
      "$procs=Get-CimInstance Win32_Process|Select-Object ProcessId,ParentProcessId",
      "do{$n=0;$procs|%{if($ids.Contains([int]$_.ParentProcessId)-and $ids.Add([int]$_.ProcessId)){$n++}}}while($n-gt 0)",
      `$hit=Get-NetTCPConnection -State Established -RemoteAddress 127.0.0.1 -RemotePort ${port} -ErrorAction SilentlyContinue|?{$ids.Contains([int]$_.OwningProcess)}`,
      `$after=try{[Diagnostics.Process]::GetProcessById(${rootPid}).StartTime.ToUniversalTime().Ticks.ToString()}catch{''}`,
      "if($hit-and$after-eq$birth){'true'}else{'false'}",
    ].join(";");
    return runPowerShell(script).trim() === "true";
  } catch { return false; }
}

/**
 * #1342 —— 只在健康检查**即将失败**时跑一次,用来回答一个此前没人量过的问题:
 * 那 10.5 秒到底花在 **PowerShell 启动**上,还是花在 `Get-CimInstance Win32_Process`
 * 这个全表查询上?
 *
 * 实测背景(由 #1628/#1637 加的 probeMs 量到,2026-08-31):
 *   probes=1  waited=10897ms  probeMsLast=10490   ← 单次探测吃掉 96% 的预算
 * 而 #1636 把全表枚举提到循环外之后这个数**没有变小**(9963 → 10490),
 * 说明成本不在"重复枚举",而在那一次调用本身。但"那一次调用"包含两段:
 * 起一个 powershell 进程,和在里面跑 CIM 查询。**这两段要查的东西完全不同** ——
 * 前者是 runner/镜像的问题,后者是查询写法的问题。
 *
 * 🔴 这里跑的是一个**什么都不做**的脚本(`'x'`),所以它测到的就是启动那一段的下界。
 *    只在失败路径调用一次,不进探测循环 —— 不给正常路径增加任何成本,
 *    也**不可能**改变探测的返回值。
 *
 * 拿不到就返回 null(未知),不返回 0 —— 0 会被读成「启动不花时间」。
 */
export function measurePowerShellStartupMs(): number | null {
  try {
    const t0 = Date.now();
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "'x'"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    });
    return Date.now() - t0;
  } catch {
    return null;
  }
}

export function writeWindowsCopresenceRecord(
  nodesDir: string,
  nodeId: string,
  processes: WindowsManagedProcess[],
  marker?: string,
): void {
  atomicWritePrivateJson(windowsCopresenceRecordPath(nodesDir, nodeId), {
    version: marker ? 2 : 1,
    nodeId,
    createdAt: new Date().toISOString(),
    ...(marker ? { marker } : {}),
    processes,
  } satisfies WindowsCopresenceRecord);
}

export function readWindowsCopresenceRecord(nodesDir: string, nodeId: string): WindowsCopresenceRecord | null {
  const path = windowsCopresenceRecordPath(nodesDir, nodeId);
  if (!existsSync(path)) return null;
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<WindowsCopresenceRecord>;
  if (![1, 2].includes(value.version as number) || value.nodeId !== nodeId || !Array.isArray(value.processes)
    || (value.version === 2 && (typeof value.marker !== "string" || !value.marker))) {
    throw new Error(`invalid Windows co-presence record: ${path}`);
  }
  for (const p of value.processes) {
    if (!p || !["appsrv", "bridge"].includes(p.role) || !Number.isInteger(p.pid) || p.pid <= 0
      || typeof p.creationDate !== "string" || !p.creationDate || typeof p.logPath !== "string") {
      throw new Error(`invalid managed process in Windows co-presence record: ${path}`);
    }
  }
  return value as WindowsCopresenceRecord;
}

export interface WindowsStopDecision {
  safe: WindowsManagedProcess[];
  refused: Array<{ process: WindowsManagedProcess; reason: "missing" | "pid-reused" }>;
}

/** PID alone is never authority: Windows reuses PIDs, so CreationDate must match. */
export function decideWindowsManagedStop(record: WindowsCopresenceRecord, probe: CreationDateProbe): WindowsStopDecision {
  const safe: WindowsManagedProcess[] = [];
  const refused: WindowsStopDecision["refused"] = [];
  for (const process of record.processes) {
    const current = probe(process.pid);
    if (!current) refused.push({ process, reason: "missing" });
    else if (current !== process.creationDate) refused.push({ process, reason: "pid-reused" });
    else safe.push(process);
  }
  return { safe, refused };
}

export function taskkillWindowsProcessTree(pid: number): void {
  execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
}
