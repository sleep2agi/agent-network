import { execFileSync } from "node:child_process";
import { findUnaccountedDescendants, type WindowsManagedIdentity, type WindowsDescendantCapture, type WindowsStopOrchestrationDeps } from "./windows-codex-copresence.js";

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

export function windowsSdkEvidenceScript(identities: WindowsManagedIdentity[], capture: boolean): string {
  if (!identities.every(validIdentity)) throw Error("invalid SDK process identity");
  const pids = [...new Set(identities.map(identity => identity.pid))];
  const code = [PRELUDE, `$roots=@(${pids.join(",")})`];
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

export function windowsSdkBatchEvidence(run: (script: string) => string = script => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 5_000, maxBuffer: 4 * 1024 * 1024,
})): Pick<WindowsStopOrchestrationDeps, "captureRoots" | "readFinalEvidence"> {
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
