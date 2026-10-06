import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { AdoptionProcessEvidence } from "./adopt-local-identity.js";

export interface AdoptionProc extends AdoptionProcessEvidence { pid: number; birth: string; }
export function readAdoptionProc(pid: number): AdoptionProc | null {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw Error("adopt_pid_invalid");
  const root = `/proc/${pid}`;
  let stat: string;
  try { stat = readFileSync(join(root, "stat"), "utf8"); }
  catch (e: any) { if (e.code === "ENOENT") return null; throw Error("adopt_proc_unreadable"); }
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  if (fields[0] === "Z") return null;
  const birth = fields[19];
  if (!birth || !/^\d+$/.test(birth)) throw Error("adopt_proc_invalid");
  const env: Record<string, string> = Object.create(null);
  for (const pair of readFileSync(join(root, "environ"), "utf8").split("\0")) {
    const at = pair.indexOf("="); if (at > 0) env[pair.slice(0, at)] = pair.slice(at + 1);
  }
  const evidence = { pid, birth, uid: lstatSync(root).uid, env,
    cwd: realpathSync(join(root, "cwd")), argv: readFileSync(join(root, "cmdline"), "utf8").split("\0").filter(Boolean) };
  const finalStat = readFileSync(join(root, "stat"), "utf8");
  if (finalStat.slice(finalStat.lastIndexOf(")") + 2).split(" ")[19] !== birth) throw Error("adopt_pid_changed");
  return evidence;
}
export function readAdoptionPid(nodeDir: string): number | null {
  const file = join(nodeDir, ".pid");
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid?.() || st.mode & 0o022) throw Error("adopt_pidfile_unsafe");
    const raw = readFileSync(file, "utf8").trim();
    const pid = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(pid) || pid <= 1) throw Error("adopt_pid_invalid");
    return pid;
  } catch (e: any) { if (e.code === "ENOENT") return null; throw e; }
}
