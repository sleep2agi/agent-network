import { spawn } from "node:child_process";
import { findUnaccountedDescendants, type WindowsManagedIdentity, type WindowsDescendantCapture, type WindowsStopOrchestrationDeps, type AsyncWindowsStopDeps, probeWindowsIdentity } from "./windows-codex-copresence.js";

// Toolhelp is a local kernel snapshot. Unlike CIM it does not initialize WMI
// for each identity. No command lines, secrets, shell, or external executable.
const NATIVE_TABLE = `
using System; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class AnetProcessTable {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Entry {
  public uint size, usage, pid; public UIntPtr heap; public uint module, threads, ppid;
  public int priority; public uint flags;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string name;
 }
 [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
 [DllImport("kernel32.dll", EntryPoint="Process32FirstW", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool First(IntPtr h,ref Entry e);
 [DllImport("kernel32.dll", EntryPoint="Process32NextW", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool Next(IntPtr h,ref Entry e);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 public static string[] Rows() {
  var h=CreateToolhelp32Snapshot(2,0); if(h==new IntPtr(-1)) throw new Exception("snapshot unavailable");
  try { var rows=new List<string>(); var e=new Entry(); e.size=(uint)Marshal.SizeOf(typeof(Entry));
   if(!First(h,ref e)) throw new Exception("snapshot empty");
   do { rows.Add(e.pid+"="+e.ppid); if(rows.Count>8192) throw new Exception("snapshot cap exceeded"); } while(Next(h,ref e));
   if(Marshal.GetLastWin32Error()!=18) throw new Exception("snapshot incomplete");
   return rows.ToArray();
  } finally { CloseHandle(h); }
 }
}`;

const PRELUDE = [
  "$ErrorActionPreference='Stop'",
  `Add-Type -TypeDefinition '${NATIVE_TABLE.replace(/'/g, "''")}'`,
  "function Birth([int]$id){try{[Diagnostics.Process]::GetProcessById($id).StartTime.ToUniversalTime().Ticks.ToString()}catch [System.ArgumentException]{'ABSENT'}catch{'ERROR'}}",
  "function Table{$h=@{};foreach($row in [AnetProcessTable]::Rows()){$pair=$row.Split('=');$h[[int]$pair[0]]=[int]$pair[1]};return ,$h}",
].join(";\n");

function validIdentity(identity: WindowsManagedIdentity): boolean {
  return Number.isSafeInteger(identity.pid) && identity.pid > 1 && /^\d+$/.test(identity.creationDate) && (!identity.kind || identity.kind === "ticks");
}

export function windowsSdkEvidenceScript(identities: WindowsManagedIdentity[], capture: boolean, includePrelude = true): string {
  if (!identities.every(validIdentity)) throw Error("invalid SDK process identity");
  const pids = [...new Set(identities.map(identity => identity.pid))];
  const code = [includePrelude ? PRELUDE : "", `$roots=@(${pids.join(",")})`];
  if (capture) {
    code.push(
      "$before=@{};foreach($id in $roots){$before[$id]=Birth $id}",
      "$first=Table;$ids=[Collections.Generic.HashSet[int]]::new();foreach($id in $roots){[void]$ids.Add($id)}",
      "do{$n=0;foreach($id in $first.Keys){if($ids.Contains($first[$id])-and$ids.Add($id)){$n++}}}while($n-gt 0)",
      "if($ids.Count-gt 512){throw 'descendant cap exceeded'}",
      "$births=@{};foreach($id in $ids){$births[$id]=Birth $id}",
      // Bracket a second native PPID snapshot with birth reads. A recycled PID
      // cannot acquire a stale parent edge from the first table.
      "$second=Table;$rows=@();foreach($id in $ids){$rows+=@{pid=$id;ppid=$first[$id];birth=$births[$id];after=(Birth $id);stable=($first.ContainsKey($id)-and$second.ContainsKey($id)-and$first[$id]-eq$second[$id])}}",
      "$checks=@();foreach($id in $roots){$checks+=@{pid=$id;before=$before[$id];after=(Birth $id)}}",
      "'SDKSTOP:'+(@{checks=$checks;rows=$rows}|ConvertTo-Json -Compress -Depth 5)",
    );
  } else {
    code.push(
      "$table=Table;$rows=@();foreach($id in $table.Keys){$rows+=@{pid=$id;ppid=$table[$id]}}",
      "$states=@();foreach($id in $roots){$states+=@{pid=$id;birth=(Birth $id)}}",
      "'SDKSTOP:'+(@{rows=$rows;states=$states}|ConvertTo-Json -Compress -Depth 5)",
    );
  }
  return code.join(";\n");
}

function decode(raw: string): any {
  const text = raw.trim();
  if (!text.startsWith("SDKSTOP:")) throw Error("native snapshot protocol missing");
  const value = JSON.parse(text.slice(8));
  if (!Array.isArray(value.rows) || value.rows.length === 0 || value.rows.length > 8192) throw Error("native snapshot incomplete");
  const seen = new Set<number>();
  for (const row of value.rows) {
    if (!Number.isSafeInteger(row.pid) || row.pid < 0 || !Number.isSafeInteger(row.ppid) || row.ppid < 0 || seen.has(row.pid)) throw Error("invalid native process row");
    seen.add(row.pid);
  }
  return value;
}

export function windowsSdkBatchEvidence(run: (script: string) => string): Pick<WindowsStopOrchestrationDeps, "captureRoots" | "readFinalEvidence"> {
  return {
    captureRoots(roots): WindowsDescendantCapture[] {
      if (!roots.length) return [];
      const data = decode(run(windowsSdkEvidenceScript(roots, true)));
      return roots.map(root => {
        const check = data.checks?.filter((row: any) => row.pid === root.pid);
        const rootRow = data.rows.find((row: any) => row.pid === root.pid);
        if (check?.length !== 1 || check[0].before !== root.creationDate || check[0].after !== root.creationDate
            || !rootRow || rootRow.stable !== true || rootRow.birth !== root.creationDate || rootRow.after !== root.creationDate) return { identities: [], unknownReason: "root birth changed or unavailable during native snapshot" };
        const descendants = findUnaccountedDescendants(data.rows, [root.pid]);
        if (descendants.length > 256) return { identities: [], unknownReason: "descendant cap exceeded" };
        const ids: WindowsManagedIdentity[] = [];
        for (const pid of descendants) {
          const row = data.rows.find((candidate: any) => candidate.pid === pid);
          if (!row || row.stable !== true || typeof row.birth !== "string" || !/^\d+$/.test(row.birth) || row.birth !== row.after) return { identities: [], unknownReason: "descendant parent/birth changed or unavailable during native snapshot" };
          ids.push({ pid, role: `${root.role}:desc`, creationDate: row.birth, kind: "ticks" });
        }
        return { identities: ids, rootBefore: check[0].before, rootAfter: check[0].after };
      });
    },
    readFinalEvidence(identities) {
      if (!identities.length) return { snapshot: [], probe: () => "unknown" };
      const data = decode(run(windowsSdkEvidenceScript(identities, false)));
      return { snapshot: data.rows, probe(identity) {
        const states = data.states?.filter((row: any) => row.pid === identity.pid);
        if (!validIdentity(identity) || states?.length !== 1) return "unknown";
        const birth = states[0].birth;
        if (birth === "ABSENT") return "gone";
        if (typeof birth !== "string" || !/^\d+$/.test(birth)) return "unknown";
        return birth === identity.creationDate ? "alive" : "pid-reused";
      } };
    },
  };
}

const RESIDENT_SCRIPT = `[Console]::Out.WriteLine('SDKBOOT');[Console]::Out.Flush()
${PRELUDE}
[Console]::Out.WriteLine('SDKCOMPILED');[Console]::Out.Flush()
[Console]::Out.WriteLine('SDKREADY')
[Console]::Out.Flush()
while($null -ne ($line=[Console]::In.ReadLine())) {
 $request=$null
 try {
  $request=$line|ConvertFrom-Json
  $script=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($request.script))
  $result=(& ([scriptblock]::Create($script))|Out-String).Trim()
  [Console]::Out.WriteLine((@{id=$request.id;ok=$true;result=$result}|ConvertTo-Json -Compress))
 } catch {
  [Console]::Out.WriteLine((@{id=$request.id;ok=$false;error=$_.Exception.Message}|ConvertTo-Json -Compress))
 }
}`;

/** Deliberately never return upstream text, paths or environment values. */
export function sdkEvidenceReason(raw: string): string {
  if (/access.{0,20}denied|unauthorizedaccess|permissiondenied/i.test(raw)) return "access_denied";
  if (/commandnotfound|not recognized|could not.*find|filenotfound/i.test(raw)) return "dependency_missing";
  if (/compiler|compilation|add-type|csharp/i.test(raw)) return "compile_failed";
  if (/parsererror|syntaxerror/i.test(raw)) return "script_invalid";
  return raw ? "unknown" : "none";
}

/** A private pipe, not a disk DLL cache. Compile once per stop, reuse for every
 * capture, immediate pre-kill birth check and final query; dispose on all paths.
 * Startup/compilation has its own bound, queries retain their 5s bound. */
export async function openWindowsSdkEvidenceSession(options: {
  onProgress?: (message: string) => void;
  startupTimeoutMs?: number;
  queryTimeoutMs?: number;
  launch?: { command: string; args: string[] }; // transport fixture, never Hub input
} = {}): Promise<{ deps: AsyncWindowsStopDeps; close: () => void }> {
  const started = Date.now();
  options.onProgress?.(`helper starting runtime=${process.versions.bun ? "bun" : "node"} env_present=${JSON.stringify(Object.fromEntries(
    ["SystemRoot", "windir", "TEMP", "TMP", "HOME", "USERPROFILE", "PSModulePath"].map(key => [key, !!process.env[key]])))}`);
  const launch = options.launch ?? { command: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(RESIDENT_SCRIPT, "utf16le").toString("base64")] };
  const child = spawn(launch.command, launch.args, { stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true });
  let closed = false, sequence = 0, buffer = "", stderr = "", stderrBytes = 0, stdoutBytes = 0;
  let stage = "launch_requested", exitObserved = false;
  const diagnostic = () => `stage=${stage} exit_observed=${exitObserved} exit_code=${child.exitCode ?? "none"} termination_observed=${child.signalCode !== null} stdout_bytes=${stdoutBytes} buffered_bytes=${Buffer.byteLength(buffer)} stderr_bytes=${stderrBytes} stderr_reason=${sdkEvidenceReason(stderr)}`;
  let pending: { resolve: (raw: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; id: number } | undefined;
  const fail = (error: Error) => {
    if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = undefined; }
    close();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    if (pending) { clearTimeout(pending.timer); pending.reject(Error("SDK evidence session closed")); pending = undefined; }
    child.stdin.end();
    // Node terminates its owned Windows process handle, no POSIX signal argv.
    child.kill();
  };
  const wait = (id: number, ms: number): Promise<string> => new Promise((resolve, reject) => {
    pending = { id, resolve, reject, timer: setTimeout(() => fail(Error(`SDK evidence ${id === 0 ? "startup" : "query"} timeout (${ms}ms): ${diagnostic()}`)), ms) };
  });
  const ready = wait(0, options.startupTimeoutMs ?? 20_000);
  child.on("spawn", () => { if (stage === "launch_requested") stage = "spawned"; });
  child.on("error", () => fail(Error(`SDK evidence spawn failed: ${diagnostic()}`)));
  child.on("exit", () => { exitObserved = true; fail(Error(`SDK evidence process exited: ${diagnostic()}`)); });
  child.stdin.on("error", () => fail(Error(`SDK evidence input failed: ${diagnostic()}`)));
  child.stderr.on("data", chunk => { stderrBytes += chunk.length; stderr = (stderr + String(chunk)).slice(0, 512); });
  child.stdout.on("data", chunk => {
    stdoutBytes += chunk.length; buffer += String(chunk);
    if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) { fail(Error("SDK evidence output cap exceeded")); return; }
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      if (!line) continue;
      try {
        if (!pending) throw Error("unsolicited SDK evidence response");
        let raw = line;
        if (pending.id === 0) {
          if (line === "SDKBOOT" || line === "SDKCOMPILED") {
            stage = line === "SDKBOOT" ? "script_entered" : "initialized";
            options.onProgress?.(`helper stage=${stage} elapsed_ms=${Date.now() - started}`);
            continue;
          }
          if (line !== "SDKREADY") throw Error(`SDK readiness protocol mismatch: ${diagnostic()}`);
          stage = "ready";
        }
        else {
          const reply = JSON.parse(line);
          if (reply.id !== pending.id || reply.ok !== true || typeof reply.result !== "string") throw Error(`SDK query failed: reason=${sdkEvidenceReason(typeof reply.error === "string" ? reply.error : "protocol mismatch")} ${diagnostic()}`);
          raw = reply.result;
        }
        clearTimeout(pending.timer); const resolve = pending.resolve; pending = undefined; resolve(raw);
      } catch { fail(Error(`SDK evidence protocol failed: ${diagnostic()}`)); return; }
    }
  });
  await ready;
  options.onProgress?.(`helper ready startup_compile_ms=${Date.now() - started}`);
  const query = async (script: string, stage: string): Promise<string> => {
    if (closed || pending) throw Error("SDK evidence session unavailable or busy");
    const at = Date.now(), id = ++sequence;
    const result = wait(id, options.queryTimeoutMs ?? 5_000);
    child.stdin.write(JSON.stringify({ id, script: Buffer.from(script, "utf8").toString("base64") }) + "\n");
    const raw = await result;
    options.onProgress?.(`${stage} query_ms=${Date.now() - at}`);
    return raw;
  };
  return { close, deps: {
    captureRoots: async roots => {
      const raw = await query(windowsSdkEvidenceScript(roots, true, false), "capture");
      return windowsSdkBatchEvidence(() => raw).captureRoots!(roots);
    },
    probeRoot: async root => {
      if (!validIdentity(root)) return "unknown";
      try {
        const raw = await query(`$birth=Birth ${root.pid};'IDSTATE:'+$(if($birth-eq 'ABSENT'){'ABSENT'}elseif($birth-eq 'ERROR'){'ERROR'}else{'TICKS='+$birth})`, "prekill");
        return probeWindowsIdentity(root.pid, root.creationDate, () => raw);
      } catch { return "unknown"; }
    },
    readFinalEvidence: async identities => {
      const raw = await query(windowsSdkEvidenceScript(identities, false, false), "final");
      return windowsSdkBatchEvidence(() => raw).readFinalEvidence!(identities);
    },
  } };
}
