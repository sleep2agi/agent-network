import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
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
  const outcome = runTaskkillWindowsProcessTree(pid);
  if (outcome.status === 0) return;
  const detail = [
    outcome.status !== null ? `status=${outcome.status}` : null,
    outcome.signal ? `signal=${outcome.signal}` : null,
    outcome.stderrSummary ? `stderr=${outcome.stderrSummary}` : null,
    outcome.stderrDroppedBytes > 0 ? `stderrOmitted=${outcome.stderrDroppedBytes}B` : null,
  ].filter(Boolean).join(" ");
  throw new Error(`taskkill.exe /PID ${pid} /T /F did not report success${detail ? ` (${detail})` : ""}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// #1335 —— taskkill 非零之后：保留诊断，按**精确身份**裁决 gone / alive / unknown
//
// 现场（run 38587525619 / job 115933379757）：`taskkill.exe /PID 8100 /T /F` 非零，
// 自报 `Reason: There is no running instance of the task.`——它**只**报告「被枚举到的后代
// 此刻已不在」，**不**证明所有原身份都已退出（历史红不改写）。
//
// 旧代码把**退出码**放在身份判据之前（非零即 exit(1)），使按 PID+CreationDate 的残留判据
// 不可达，良性竞态被当成硬失败。本段：① 非零保留 status/signal 与**受控** stderr 摘要；
// ② 取证与终止都**绑定精确根身份**；③ 由身份裁决 —— **不**解析本地化文案、**不**按 PID 裸杀。
// ─────────────────────────────────────────────────────────────────────────────
export interface TaskkillOutcome {
  status: number | null;
  signal: string | null;
  /** 受控摘要：仅保留 taskkill 自身固定形状的行，≤4 行 / 400 字符。 */
  stderrSummary: string;
  /** 被丢弃的 stderr 字节数——保留「有输出但形状不识别」这一事实，不泄露文本。 */
  stderrDroppedBytes: number;
}

const TASKKILL_STDERR_SHAPE = /^(ERROR|SUCCESS|INFO|Reason):[^\n]{0,160}$/;

/** 受控诊断：只放行已知形状（`ERROR:` / `Reason:` …），其余只记字节数。 */
export function summarizeTaskkillStderr(raw: string): { summary: string; droppedBytes: number } {
  const lines = String(raw ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const kept: string[] = [];
  let droppedBytes = 0;
  for (const line of lines) {
    const printable = line.replace(/[\u0000-\u001f\u007f]/g, "");
    if (kept.length < 4 && TASKKILL_STDERR_SHAPE.test(printable)) kept.push(printable);
    else droppedBytes += Buffer.byteLength(line, "utf8");
  }
  return { summary: kept.join(" | ").slice(0, 400), droppedBytes };
}

/** 非零**不再**丢弃诊断：拿回 status/signal 与受控 stderr，交给身份裁决。 */
export function runTaskkillWindowsProcessTree(pid: number): TaskkillOutcome {
  const result = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 30_000,
  });
  const { summary, droppedBytes } = summarizeTaskkillStderr(String(result.stderr ?? ""));
  return {
    status: typeof result.status === "number" ? result.status : null,
    signal: (result.signal as string | null) ?? null,
    stderrSummary: summary,
    stderrDroppedBytes: droppedBytes,
  };
}

export type WindowsIdentityState = "alive" | "gone" | "pid-reused" | "unknown";

/** 结构化协议：判定只读这个协议，**不**读本地化的错误文案。 */
export const WINDOWS_IDENTITY_PROTOCOL = "IDSTATE:";

/** gone 用 .NET 的 `ArgumentException`（进程不存在）辨认——**异常类型**不随语言变化。 */
export function windowsIdentityProbeScript(pid: number): string {
  return [
    "$ErrorActionPreference='Stop'",
    "try{",
    `$p=[Diagnostics.Process]::GetProcessById(${pid})`,
    "$t=$p.StartTime.ToUniversalTime().Ticks.ToString()",
    `'${WINDOWS_IDENTITY_PROTOCOL}TICKS='+$t`,
    `}catch [System.ArgumentException]{'${WINDOWS_IDENTITY_PROTOCOL}ABSENT'}catch{'${WINDOWS_IDENTITY_PROTOCOL}ERROR'}`,
  ].join(";");
}

export type WindowsIdentityRead = { kind: "ticks"; ticks: string } | { kind: "absent" } | { kind: "unknown" };

function defaultPowerShellRunner(script: string): string {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 30_000,
  });
}

/** 空输出 / 多行 / 非法形状 / 异常 ⇒ unknown（**不能**折成 gone）。 */
export function readWindowsIdentity(pid: number, runPowerShell: (script: string) => string = defaultPowerShellRunner): WindowsIdentityRead {
  if (!Number.isInteger(pid) || pid <= 0) return { kind: "unknown" };
  try {
    const out = String(runPowerShell(windowsIdentityProbeScript(pid)) ?? "").trim();
    if (out === `${WINDOWS_IDENTITY_PROTOCOL}ABSENT`) return { kind: "absent" };
    const matched = new RegExp(`^${WINDOWS_IDENTITY_PROTOCOL}TICKS=(\\d+)$`).exec(out);
    return matched ? { kind: "ticks", ticks: matched[1] } : { kind: "unknown" };
  } catch { return { kind: "unknown" }; }
}

/** 三向：alive(出生身份仍在) / gone(该身份已不存在) / pid-reused(同 PID 已被无关进程占用) / unknown。 */
export function probeWindowsIdentity(
  pid: number,
  expectedCreationDate: string,
  runPowerShell: (script: string) => string = defaultPowerShellRunner,
  kind: WindowsIdentityKind = "ticks",
): WindowsIdentityState {
  if (kind === "creation") return probeWindowsCimIdentity(pid, expectedCreationDate, runPowerShell);
  if (!Number.isInteger(pid) || pid <= 0 || !/^\d+$/.test(expectedCreationDate)) return "unknown";
  const read = readWindowsIdentity(pid, runPowerShell);
  if (read.kind === "absent") return "gone";
  if (read.kind === "ticks") return read.ticks === expectedCreationDate ? "alive" : "pid-reused";
  return "unknown";
}

export type WindowsIdentityKind = "ticks" | "creation";

export interface WindowsManagedIdentity {
  role: string;
  pid: number;
  creationDate: string;
  /** `ticks`（根，`[Diagnostics.Process]::StartTime` 的 .NET ticks）或
   *  `creation`（后代，**同一份 CIM 枚举快照**里的 `CreationDate`）。两者**不混用**、各自精确相等比较。 */
  kind?: WindowsIdentityKind;
}

export const WINDOWS_CAPTURE_PROTOCOL = "CAP:";

/**
 * 一次 PowerShell 里完成**绑定根身份**的取证：先核根出生身份 == 期望，再枚举后代并在
 * **同一次枚举**中读它们的出生身份，最后**再核一次**根身份。根代际漂移 ⇒ 整次取证作废。
 * 只用于取证，**不**用于杀进程。
 */
export function windowsCaptureScript(rootPid: number, expectedCreationDate: string): string {
  return [
    "$ErrorActionPreference='Stop'",
    `$want='${expectedCreationDate}'`,
    "function ReadBirthTicks([int]$p){try{[Diagnostics.Process]::GetProcessById($p).StartTime.ToUniversalTime().Ticks.ToString()}catch{''}}",
    `$rb=ReadBirthTicks ${rootPid}`,
    `if($rb -ne $want){'${WINDOWS_CAPTURE_PROTOCOL}RB='+$(if($rb){$rb}else{'ABSENT'})+';RA=SKIP;D=;G=';exit 0}`,
    "$procs=Get-CimInstance Win32_Process|Select-Object ProcessId,ParentProcessId,CreationDate",
    `$ids=[Collections.Generic.HashSet[int]]::new();[void]$ids.Add(${rootPid})`,
    "do{$n=0;$procs|%{if($ids.Contains([int]$_.ParentProcessId)-and $ids.Add([int]$_.ProcessId)){$n++}}}while($n-gt 0)",
    `[void]$ids.Remove(${rootPid})`,
    "$good=@();$bad=@()",
    "foreach($child in $ids){$hit=$procs|?{[int]$_.ProcessId -eq $child}|Select-Object -First 1;if($hit-and$hit.CreationDate){$good+=\"$child=$($hit.CreationDate.ToString('o'))\"}else{$bad+=\"$child\"}}",
    `$ra=ReadBirthTicks ${rootPid}`,
    `'${WINDOWS_CAPTURE_PROTOCOL}RB='+$(if($rb){$rb}else{'ABSENT'})+';RA='+$(if($ra){$ra}else{'ABSENT'})+';D='+($good -join ',')+';G='+($bad -join ',')`,
  ].join(";");
}

export interface WindowsDescendantCapture {
  identities: WindowsManagedIdentity[];
  rootBefore?: string;
  rootAfter?: string;
  /** 非空 ⇒ 取证不完整/根代际漂移，调用方**必须**按 unknown 处理，不得当成功。 */
  unknownReason?: string;
}

export function parseWindowsCapture(raw: string): { rootBefore: string; rootAfter: string; descendants: Array<{ pid: number; ticks: string }>; gaps: number[] } | null {
  const out = String(raw ?? "").trim();
  const matched = new RegExp(`^${WINDOWS_CAPTURE_PROTOCOL}RB=(ABSENT|\\d+);RA=(ABSENT|SKIP|\\d+);D=([^;]*);G=([^;]*)$`).exec(out);
  if (!matched) return null;
  const parseList = (text: string, withTicks: boolean) => {
    if (!text) return [] as Array<{ pid: number; ticks: string }>;
    const parts = text.split(",");
    const rows: Array<{ pid: number; ticks: string }> = [];
    for (const part of parts) {
      const m = withTicks ? /^(\d+)=(.+)$/.exec(part) : /^(\d+)$/.exec(part);
      if (!m) return null;
      if (withTicks && !isCompleteCimCreationDate(m[2])) return null;   // 非法出生身份 ⇒ 交由调用方判 unknown
      rows.push({ pid: Number(m[1]), ticks: withTicks ? m[2] : "" });
    }
    return rows;
  };
  const descendants = parseList(matched[3], true);
  const gaps = parseList(matched[4], false);
  if (!descendants || !gaps) return null;
  return { rootBefore: matched[1], rootAfter: matched[2], descendants, gaps: gaps.map((g) => g.pid) };
}

/**
 * 绑定**期望根身份**的取证：根在取证前/后都必须仍是期望代际；后代出生身份取自**同一次枚举**。
 * 任何漂移/缺口 ⇒ unknownReason（不猜）。只用于**验证**；杀进程仍走根 PID 的既存出生身份。
 */
export function captureWindowsDescendantIdentities(
  root: WindowsManagedIdentity,
  opts: { cap?: number; runPowerShell?: (script: string) => string } = {},
): WindowsDescendantCapture {
  // 🔴 2026-10-28（#2869）：默认上限 16 在繁忙的 Windows 宿主上不够用。
  //    CI 实测：`node stop windows-picker` 报
  //      descendant count 139 exceeds cap 16 for bridge pid=8232 → STOP_TIMEOUT → 测试判红
  //    11 次里红 2 次，本地（进程树小）从没红过 —— 是确定性阈值，不是抖动。
  //    139 个后代对 PowerShell 枚举与解析都不算大，所以把默认抬到 256；
  //    显式的 opts.cap 仍然优先（既有 cap 测试传的就是显式值）。
  const cap = opts.cap ?? Number(process.env.ANET_WINDOWS_DESCENDANT_CAP ?? 256);
  const run = opts.runPowerShell ?? defaultPowerShellRunner;
  const label = `${root.role} pid=${root.pid}`;
  let parsed: ReturnType<typeof parseWindowsCapture> = null;
  try { parsed = parseWindowsCapture(run(windowsCaptureScript(root.pid, root.creationDate))); }
  catch (e) {
    const detail = String((e as Error)?.message ?? "").split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 3).join(" | ").slice(0, 300);
    return { identities: [], unknownReason: `capture query failed for ${label}${detail ? ` (${detail})` : ""}` };
  }
  if (!parsed) return { identities: [], unknownReason: `capture output not understood for ${label}` };
  if (parsed.rootBefore !== root.creationDate) {
    return { identities: [], rootBefore: parsed.rootBefore, unknownReason: `root identity was already ${parsed.rootBefore} before capture for ${label}` };
  }
  if (parsed.rootAfter !== root.creationDate) {
    return { identities: [], rootBefore: parsed.rootBefore, rootAfter: parsed.rootAfter, unknownReason: `root identity changed during capture for ${label}` };
  }
  if (parsed.gaps.length > 0) {
    return { identities: [], rootBefore: parsed.rootBefore, rootAfter: parsed.rootAfter, unknownReason: `descendant birth identity unreadable during capture for ${label}: ${parsed.gaps.join(",")}` };
  }
  if (parsed.descendants.length > cap) {
    return { identities: [], rootBefore: parsed.rootBefore, rootAfter: parsed.rootAfter, unknownReason: `descendant count ${parsed.descendants.length} exceeds cap ${cap} for ${label}` };
  }
  return {
    identities: parsed.descendants.map((d) => ({ role: `${root.role}:desc`, pid: d.pid, creationDate: d.ticks, kind: "creation" as const })),
    rootBefore: parsed.rootBefore,
    rootAfter: parsed.rootAfter,
  };
}

export const WINDOWS_CIM_PROTOCOL = "CIMSTATE:";

/** 后代身份协议：**同一份快照**里的 CIM `CreationDate`（`ToString('o')`），精确相等比较。 */
export function cimIdentityProbeScript(pid: number): string {
  return [
    "$ErrorActionPreference='Stop'",
    "try{",
    `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"`,
    `if($p){'${WINDOWS_CIM_PROTOCOL}CREATED='+$p.CreationDate.ToString('o')}else{'${WINDOWS_CIM_PROTOCOL}ABSENT'}`,
    `}catch{'${WINDOWS_CIM_PROTOCOL}ERROR'}`,
  ].join(";");
}

// .NET round-trip "o": seven fraction digits, followed by local offset, Z, or no zone.
// https://learn.microsoft.com/en-us/dotnet/standard/base-types/standard-date-and-time-format-strings#the-round-trip-o-o-format-specifier
const CIM_CREATION_SHAPE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{7}(?:Z|([+-])(\d{2}):(\d{2}))?$/;

/** Validate the complete text without rounding the identity's fractional digits. */
export function isCompleteCimCreationDate(value: string): boolean {
  const m = CIM_CREATION_SHAPE.exec(value);
  if (!m || m[0] !== value) return false;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  if (year < 1601 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > days[month - 1]) return false;
  if (m[7] && (Number(m[8]) > 14 || Number(m[9]) > 59 || (m[8] === "14" && m[9] !== "00"))) return false;
  return true;
}

/**
 * 🔴 只有**期望值与读回值均为合法完整** `CreationDate`，且二者**精确不等**时才是 `pid-reused`；
 * 任何一侧非法（格式/日期/多行/空白畸形）⇒ **unknown** —— 不得因"读不懂"而放宽成"已退出/被复用"。
 * 比较保留全部精度：不做 `Date.parse`、不截断、不近似。
 */
export function parseCimIdentityState(raw: string, expectedCreationDate: string): WindowsIdentityState {
  if (!isCompleteCimCreationDate(expectedCreationDate)) return "unknown";
  const out = String(raw ?? "").trim();
  if (out === `${WINDOWS_CIM_PROTOCOL}ABSENT`) return "gone";
  const matched = new RegExp(`^${WINDOWS_CIM_PROTOCOL}CREATED=(.+)$`).exec(out);
  if (!matched || !isCompleteCimCreationDate(matched[1])) return "unknown";
  return matched[1] === expectedCreationDate ? "alive" : "pid-reused";
}

export function probeWindowsCimIdentity(
  pid: number,
  expectedCreationDate: string,
  runPowerShell: (script: string) => string = defaultPowerShellRunner,
): WindowsIdentityState {
  if (!Number.isInteger(pid) || pid <= 0 || !expectedCreationDate) return "unknown";
  try { return parseCimIdentityState(runPowerShell(cimIdentityProbeScript(pid)), expectedCreationDate); }
  catch { return "unknown"; }
}

export interface WindowsStopOrchestrationDeps {
  runPowerShell?: (script: string) => string;
  runTaskkill?: (pid: number) => TaskkillOutcome;
}

export interface WindowsStopOrchestration {
  verdict: WindowsStopVerdict;
  /** 实际发出 taskkill 的根 PID —— 负控可断言为 **0**。 */
  killedPids: number[];
  identities: WindowsManagedIdentity[];
  /** 非 `stopped` 时调用方**必须**保留记录、**不得**通知 Hub 离线。 */
  mustKeepRecord: boolean;
}

/**
 * 停止编排（CLI 实际使用的那一份，注入 runner/executor 以便见证）：
 * ① 对每个受管根做**绑定根身份**的取证（含后代出生身份与前后根代际核对）；
 * ② 每个根在**终止紧前**重验 PID+CreationDate —— `gone`/`pid-reused`/`unknown` 一律**不发**终止命令；
 * ③ 按精确身份裁决 gone/alive/unknown。过期 `safe` **不**构成终止授权。
 */
export function orchestrateWindowsManagedStop(
  roots: WindowsManagedIdentity[],
  deps: WindowsStopOrchestrationDeps = {},
): WindowsStopOrchestration {
  const runPowerShell = deps.runPowerShell;
  const runTaskkill = deps.runTaskkill ?? runTaskkillWindowsProcessTree;
  const identities: WindowsManagedIdentity[] = [...roots];
  const gaps: string[] = [];
  const notes: string[] = [];
  for (const root of roots) {
    const captured = captureWindowsDescendantIdentities(root, { runPowerShell });
    if (captured.unknownReason) gaps.push(captured.unknownReason);
    identities.push(...captured.identities);
  }
  const kills: Array<{ label: string; outcome: TaskkillOutcome }> = [];
  const killedPids: number[] = [];
  for (const root of [...roots].reverse()) {
    const label = `${root.role} pid=${root.pid}`;
    const state = probeWindowsIdentity(root.pid, root.creationDate, runPowerShell, root.kind);
    if (state !== "alive") { notes.push(`kill withheld for ${label}: root identity ${state}`); continue; }
    killedPids.push(root.pid);
    kills.push({ label, outcome: runTaskkill(root.pid) });
  }
  // 🔴 非零 kill ⇒ 必须以**遍历本身**证明「没有未记账的存活后代」：
  //    快照只提供 (pid, ppid)，遍历在 JS 侧、种子是**全部已捕获身份**（根 + 后代），
  //    **不依赖根是否可达**。任何未记账的现存后代 / 快照不可得 ⇒ unknown。
  const reconGaps: string[] = [];
  if (kills.some((kill) => kill.outcome.status !== 0 || kill.outcome.signal)) {
    const capturedPids = identities.map((identity) => identity.pid);
    let snapshot: Array<{ pid: number; ppid: number }> | null = null;
    try { snapshot = parseWindowsProcessSnapshot((runPowerShell ?? defaultPowerShellRunner)(windowsProcessSnapshotScript())); }
    catch { snapshot = null; }
    if (snapshot === null) {
      reconGaps.push(`tree not reconciled: process snapshot not obtained or not understood`);
    } else if (snapshot.length === 0) {
      // 🔴 全机 CIM 枚举**零行**不能证明"受管树已消失"：执行查询本身就会产生 powershell 进程，
      //    空结果更可能是**观测缺口**。不得把观察缺口当空集合 ⇒ unknown。
      reconGaps.push(`tree not reconciled: whole-machine process snapshot was empty; completeness not provable`);
    } else {
      const unaccounted = findUnaccountedDescendants(snapshot, capturedPids);
      if (unaccounted.length > 0) reconGaps.push(`tree not proven empty after a non-zero taskkill: unaccounted live descendants ${unaccounted.join(",")}`);
    }
  }
  const verdict = decideWindowsStopVerdict({
    identities,
    kills,
    notes,
    captureUnknown: [...gaps, ...reconGaps],
    probe: (identity) => probeWindowsIdentity(identity.pid, identity.creationDate, runPowerShell, identity.kind),
  });
  return { verdict, killedPids, identities, mustKeepRecord: verdict.kind !== "stopped" };
}

export const WINDOWS_SNAPSHOT_PROTOCOL = "SNAP:";

/**
 * 终止**之后**的进程快照：**只**返回现存进程的 (pid, ppid) 对，不在脚本里做遍历、不下结论。
 * 🔴 遍历刻意放在 JS 侧：这样「祖先链上的存活后代」这条判据**本身**可被单测见证，
 *    而不是只往编排里注入一个已经算好的结果。
 */
export function windowsProcessSnapshotScript(): string {
  return [
    "$ErrorActionPreference='Stop'",
    "$procs=Get-CimInstance Win32_Process|Select-Object ProcessId,ParentProcessId",
    `'${WINDOWS_SNAPSHOT_PROTOCOL}'+(($procs|%{ "$($_.ProcessId)=$($_.ParentProcessId)" }) -join ',')`,
  ].join(";");
}

export function parseWindowsProcessSnapshot(raw: string): Array<{ pid: number; ppid: number }> | null {
  const out = String(raw ?? "").trim();
  if (!out.startsWith(WINDOWS_SNAPSHOT_PROTOCOL)) return null;
  const body = out.slice(WINDOWS_SNAPSHOT_PROTOCOL.length);
  if (!body) return [];
  const rows: Array<{ pid: number; ppid: number }> = [];
  for (const part of body.split(",")) {
    const matched = /^(\d+)=(\d+)$/.exec(part.trim());
    if (!matched) return null;
    rows.push({ pid: Number(matched[1]), ppid: Number(matched[2]) });
  }
  return rows;
}

/**
 * 🔴 **完整性判据（不看根是否可达）**：以**全部已捕获身份**（根 + 后代）为种子，
 * 在终止后快照里沿 `ParentProcessId` 向下闭包；任何**可达且不属于已捕获身份**的现存进程，
 * 都是「未被记账的存活后代」。
 *
 * 这修掉的是这个反例：捕获 8100→8744 后，8744 又生出 9999；非零 kill 使 8100/8744 退出而
 * 9999 存活（快照里 `9999=8744`）。旧实现只从 8100 出发 BFS ⇒ 根已不可达 ⇒ 得空 ⇒ 误判 stopped。
 * 现在 8744 也在种子里 ⇒ 9999 可达 ⇒ 必须 `unknown`。
 *
 * ⚠️ **保证范围（有界）**：这是**单次有限快照**上的可达性判据，**不是**"历史后代完整性证明"。
 *    若某个中间节点**从未被捕获**且已退出，有限 pid/ppid 快照里**没有那条历史边**，本条判据
 *    看不到它；因此本片**不承诺**全时段/任意树零残留。超出该范围需要启动屏障/Job Object 一类
 *    机制，**不在本片引入**。
 */
export function findUnaccountedDescendants(
  snapshot: Array<{ pid: number; ppid: number }>,
  capturedPids: number[],
): number[] {
  const captured = new Set(capturedPids);
  const byParent = new Map<number, number[]>();
  for (const row of snapshot) {
    const list = byParent.get(row.ppid);
    if (list) list.push(row.pid);
    else byParent.set(row.ppid, [row.pid]);
  }
  const seen = new Set<number>(capturedPids);
  const queue = [...capturedPids];
  const unaccounted: number[] = [];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const child of byParent.get(parent) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
      if (!captured.has(child)) unaccounted.push(child);
    }
  }
  return unaccounted;
}

export interface WindowsStopContinuation<TStopResult> {
  /** 删除 Windows 归属记录（`rmSync(windowsCopresenceRecordPath(…))`）。 */
  removeRecord: () => void;
  /** CLI 的 `stopNode(resolved.id)` —— **只是停止节点并返回其结果**。 */
  stopNode: () => Promise<TStopResult>;
}

/**
 * 🔴 停止收尾的**唯一门控**（CLI 与见证共用）：只有 `stopped` 才删记录、才调用 `stopNode`；
 * `survived`/`unverifiable` 两者都不做；nodeStopInvoked 只表示回调被调用，停止成功与否仍由 stopResult 裁决。
 * 便于用 spy 观测**实际发生了什么调用**（而不是只看一个布尔）。
 *
 * ⚠️ **不含 Hub 离线通知**：真正的 `notifyServerOffline` 在 `stopNode` 之后、由 CLI 自行调用，
 * **不在**本门控内；因此「Hub 未收到离线通知」在本片**仍是欠项（未验）**。
 */
export async function settleWindowsManagedStop<TStopResult>(
  outcome: WindowsStopOrchestration,
  continuation: WindowsStopContinuation<TStopResult>,
): Promise<{ kept: boolean; nodeStopInvoked: boolean; stopResult?: TStopResult }> {
  if (outcome.verdict.kind !== "stopped") return { kept: true, nodeStopInvoked: false };
  continuation.removeRecord();
  const stopResult = await continuation.stopNode();
  return { kept: false, nodeStopInvoked: true, stopResult };
}

export type WindowsStopVerdict =
  | { kind: "stopped"; retainedDiagnostics: string[] }
  | { kind: "survived"; alive: string[]; retainedDiagnostics: string[] }
  | { kind: "unverifiable"; unknown: string[]; retainedDiagnostics: string[] };

/**
 * 成败只由**精确身份**裁决（不解析 taskkill 文案）：任一 `alive` ⇒ survived；否则任一
 * `unknown`（含取证缺口）⇒ unverifiable（两者**都不得绿**）；全部 gone 或 pid-reused
 * ⇒ stopped，并把非零 taskkill 的 status/signal/受控 stderr 作为**保留诊断**带出。
 */
export function decideWindowsStopVerdict(opts: {
  identities: WindowsManagedIdentity[];
  kills: Array<{ label: string; outcome: TaskkillOutcome }>;
  probe: (identity: WindowsManagedIdentity) => WindowsIdentityState;
  captureUnknown?: string[];
  notes?: string[];
}): WindowsStopVerdict {
  const retainedDiagnostics: string[] = [
    ...(opts.notes ?? []),
    ...(opts.captureUnknown ?? []).map((reason) => `capture gap: ${reason}`),
  ];
  for (const kill of opts.kills) {
    const { outcome } = kill;
    if (outcome.status === 0 && !outcome.signal) continue;
    retainedDiagnostics.push([
      `taskkill non-zero for ${kill.label}`,
      `status=${outcome.status === null ? "null" : outcome.status}`,
      `signal=${outcome.signal ?? "null"}`,
      outcome.stderrSummary ? `stderr=${outcome.stderrSummary}` : null,
      outcome.stderrDroppedBytes > 0 ? `stderrOmitted=${outcome.stderrDroppedBytes}B` : null,
    ].filter(Boolean).join(" "));
  }
  const alive: string[] = [];
  const unknown: string[] = [...(opts.captureUnknown ?? [])];
  for (const identity of opts.identities) {
    const state = opts.probe(identity);
    const label = `${identity.role} pid=${identity.pid}`;
    if (state === "alive") alive.push(label);
    else if (state === "unknown") unknown.push(label);
    else if (state === "pid-reused") retainedDiagnostics.push(`${label} pid reused; unrelated process left untouched`);
  }
  if (alive.length > 0) return { kind: "survived", alive, retainedDiagnostics };
  if (unknown.length > 0) return { kind: "unverifiable", unknown, retainedDiagnostics };
  return { kind: "stopped", retainedDiagnostics };
}
