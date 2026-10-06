// Linux-only PID/birth ownership. Never select or signal by process name/alias.
import { lstatSync, readFileSync, readdirSync } from "node:fs";
export interface ProcessStamp { pid: number; ppid: number; birth: string; uid: number; }
export function processStamp(pid: number): ProcessStamp | null {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw Error("adopt_pid_invalid");
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const f = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    if (f[0] === "Z" || f[0] === "X") return null;
    if (!/^\d+$/.test(f[19] ?? "")) throw Error("adopt_proc_invalid");
    return { pid, ppid: Number(f[1]), birth: f[19], uid: lstatSync(`/proc/${pid}`).uid };
  } catch (e: any) { if (e.code === "ENOENT" || e.code === "ESRCH") return null; throw e; }
}
export interface TreeOps {
  read: (pid: number) => ProcessStamp | null;
  list: () => number[];
  signal: (pid: number, signal: NodeJS.Signals) => void;
  sleep: (ms: number) => Promise<void>;
}
const real: TreeOps = { read: processStamp, list: () => readdirSync("/proc").filter(x => /^\d+$/.test(x) && Number(x) > 1).map(Number),
  signal: (pid, signal) => { process.kill(pid, signal); }, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };
export function sameProcess(expected: ProcessStamp, current: ProcessStamp | null): boolean {
  return !!current && current.pid === expected.pid && current.birth === expected.birth && current.uid === expected.uid;
}
export async function stopVerifiedTree(root: ProcessStamp, ops: TreeOps = real): Promise<void> {
  const owned = new Map<number, ProcessStamp>([[root.pid, root]]);
  const frozen: ProcessStamp[] = [];
  const signal = (p: ProcessStamp, s: NodeJS.Signals) => {
    const now = ops.read(p.pid);
    if (!now) return;
    if (!sameProcess(p, now)) throw Error("adopt_process_generation_changed");
    ops.signal(p.pid, s);
  };
  try {
    // Freeze verified ancestors before discovering descendants. Each newly
    // discovered descendant is frozen too; unrelated same-alias nodes never enter.
    signal(root, "SIGSTOP"); frozen.push(root);
    for (let round = 0; round < 32; round++) {
      let added = 0;
      for (const pid of ops.list()) {
        if (owned.has(pid)) continue;
        const p = ops.read(pid); if (!p || p.uid !== root.uid) continue;
        const parent = owned.get(p.ppid);
        if (!parent || !sameProcess(parent, ops.read(parent.pid))) continue;
        signal(p, "SIGSTOP"); frozen.push(p); owned.set(pid, p); added++;
      }
      if (!added) break;
      if (round === 31) throw Error("adopt_process_tree_unstable");
    }
    // Terminate descendants before ancestors, checking birth again per signal.
    for (const p of [...owned.values()].reverse()) { signal(p, "SIGTERM"); signal(p, "SIGCONT"); }
    for (let i = 0; i < 40; i++) {
      if ([...owned.values()].every(p => !sameProcess(p, ops.read(p.pid)))) return;
      await ops.sleep(50);
    }
    for (const p of [...owned.values()].reverse()) signal(p, "SIGKILL");
    for (let i = 0; i < 40; i++) {
      if ([...owned.values()].every(p => !sameProcess(p, ops.read(p.pid)))) return;
      await ops.sleep(50);
    }
    throw Error("adopt_process_stop_timeout");
  } finally {
    // Never leave a surviving verified process frozen after a refused stop.
    for (const p of frozen) { try { if (sameProcess(p, ops.read(p.pid))) ops.signal(p.pid, "SIGCONT"); } catch {} }
  }
}
