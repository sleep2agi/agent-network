import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { atomicWritePrivateJson } from "./private-state";

export type WindowsCopresenceRole = "appsrv" | "bridge";

export interface WindowsManagedProcess {
  role: WindowsCopresenceRole;
  pid: number;
  creationDate: string;
  logPath: string;
}

export interface WindowsCopresenceRecord {
  version: 1;
  nodeId: string;
  createdAt: string;
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
  const escaped = path.replace(/'/g, "''");
  const script = [
    `$path='${escaped}'`, `$acl=Get-Acl -LiteralPath $path`,
    `$acl.SetAccessRuleProtection($true,$false)`,
    `$acl.Access | ForEach-Object { [void]$acl.RemoveAccessRuleSpecific($_) }`,
    `$inherit=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'`,
    `$prop=[Security.AccessControl.PropagationFlags]::None`,
    `$allow=[Security.AccessControl.AccessControlType]::Allow`,
    `$ids=@([Security.Principal.WindowsIdentity]::GetCurrent().User,[Security.Principal.SecurityIdentifier]'S-1-5-18',[Security.Principal.SecurityIdentifier]'S-1-5-32-544')`,
    `$ids | ForEach-Object { $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($_,'FullControl',$inherit,$prop,$allow)) }`,
    `Set-Acl -LiteralPath $path -AclObject $acl`,
  ].join(";");
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
}

export function closeLog(fd: number): void {
  closeSync(fd);
}

export type CreationDateProbe = (pid: number) => string | null;

/** Uses CIM instead of locale-dependent tasklist output. */
export function probeWindowsCreationDate(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const script = `(Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\").CreationDate`;
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
    }).trim();
    return out || null;
  } catch { return null; }
}

export function writeWindowsCopresenceRecord(
  nodesDir: string,
  nodeId: string,
  processes: WindowsManagedProcess[],
): void {
  atomicWritePrivateJson(windowsCopresenceRecordPath(nodesDir, nodeId), {
    version: 1,
    nodeId,
    createdAt: new Date().toISOString(),
    processes,
  } satisfies WindowsCopresenceRecord);
}

export function readWindowsCopresenceRecord(nodesDir: string, nodeId: string): WindowsCopresenceRecord | null {
  const path = windowsCopresenceRecordPath(nodesDir, nodeId);
  if (!existsSync(path)) return null;
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<WindowsCopresenceRecord>;
  if (value.version !== 1 || value.nodeId !== nodeId || !Array.isArray(value.processes)) {
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
