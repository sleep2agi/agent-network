import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import type { TuiHealth } from "./codex-health";

/** Private launch evidence, written only after the launcher's PID attribution.
 * It contains no credentials and is bound to this bridge generation and remote. */
export interface WindowsTuiIdentity {
  version: 1;
  nodeId: string;
  marker: string;
  remote: string;
  pid: number;
  creationDate: string;
}

export function readWindowsTuiIdentity(path: string, expected: {
  nodeId: string; marker: string; remote: string;
}): WindowsTuiIdentity | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    const url = new URL(expected.remote);
    if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1"
      || !Number.isInteger(Number(url.port)) || Number(url.port) < 1 || Number(url.port) > 65535
      || url.username || url.password || url.search || url.hash || url.pathname !== "/") return;
    if (!expected.nodeId || !expected.marker || value.version !== 1
      || value.nodeId !== expected.nodeId || value.marker !== expected.marker || value.remote !== expected.remote
      || !Number.isInteger(value.pid) || value.pid <= 0
      || typeof value.creationDate !== "string" || !/^\d+$/.test(value.creationDate)) return;
    return value;
  } catch { return; }
}

type RunPowerShell = (script: string) => Promise<string>;
/** Exported for the opt-in #1321 diagnostics, which WRAPS this real runner so a
 *  test can never exercise a second runner with different semantics. No behaviour
 *  change: the probe still defaults to this function. */
export const runPowerShell: RunPowerShell = (script) => new Promise((resolve, reject) => {
  execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 4096,
  }, (error, stdout) => error ? reject(error) : resolve(stdout));
});

/** Unknown (including access/PowerShell failure) removes old health evidence.
 * A listener or a different local client never proves this TUI is connected. */
export async function probeWindowsTuiHealth(identity: WindowsTuiIdentity, run: RunPowerShell = runPowerShell): Promise<TuiHealth | undefined> {
  if (!Number.isInteger(identity.pid) || identity.pid <= 0 || !/^\d+$/.test(identity.creationDate)) return;
  let port: number;
  try {
    const url = new URL(identity.remote);
    port = Number(url.port);
    if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || !Number.isInteger(port) || port < 1 || port > 65535) return;
  } catch { return; }
  const script = [
    "$ErrorActionPreference='Stop'",
    `$birth='${identity.creationDate}'`,
    `function Read-Birth { try { [Diagnostics.Process]::GetProcessById(${identity.pid}).StartTime.ToUniversalTime().Ticks.ToString() } catch [ArgumentException] { '' } }`,
    "try {",
    "$before=Read-Birth",
    "if($before-ne$birth){'pane-dead';exit 0}",
    `$ids=[Collections.Generic.HashSet[int]]::new();[void]$ids.Add(${identity.pid})`,
    "$procs=Get-CimInstance Win32_Process|Select-Object ProcessId,ParentProcessId",
    "do{$n=0;$procs|%{if($ids.Contains([int]$_.ParentProcessId)-and $ids.Add([int]$_.ProcessId)){$n++}}}while($n-gt 0)",
    // Query all rows: no matching rows is evidence; a failed query is unknown.
    `$hit=Get-NetTCPConnection|?{$_.State-eq'Established'-and $_.RemoteAddress-eq'127.0.0.1'-and $_.RemotePort-eq${port}-and $ids.Contains([int]$_.OwningProcess)}`,
    "$after=Read-Birth",
    "if($after-ne$birth){'pane-dead'}elseif($hit){'running'}else{'session-missing'}",
    "} catch { 'unknown' }",
  ].join(";");
  try {
    const reason = (await run(script)).trim();
    if (reason === "running" || reason === "pane-dead" || reason === "session-missing") {
      return { ok: reason === "running", reason };
    }
  } catch { /* An unavailable probe cannot attest health or failure. */ }
}
