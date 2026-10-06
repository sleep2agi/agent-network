import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { AdoptionProcessEvidence } from "./adopt-local-identity.js";
import { decodeProcNulBlock, hasLoneSurrogate } from "../codex-home-enforce.js";

export interface AdoptionProc extends AdoptionProcessEvidence { pid: number; birth: string; }
/** Census prefilter only, never signal authority. Match a full raw ASCII entry;
 * unrelated/unreadable processes must not undergo strict environment decoding. */
export function hasAdoptionMarker(pid: number, marker: string): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1 || !/^[A-Za-z0-9-]+$/.test(marker)) return false;
  let raw: Buffer;
  try {raw=readFileSync(`/proc/${pid}/environ`);} catch {return false;}
  const entry=Buffer.from(`ANET_NODE_MARKER=${marker}\0`,"ascii");
  for(let at=raw.indexOf(entry);at>=0;at=raw.indexOf(entry,at+1))
    if(at===0 || raw[at-1]===0)return true;
  return false;
}
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
  for (const pair of decodeProcNulBlock(readFileSync(join(root, "environ"))).split("\0")) {
    if (hasLoneSurrogate(pair)) throw Error("adopt_proc_invalid");
    const at = pair.indexOf("=");
    if (at > 0) {
      const key=pair.slice(0,at);
      if (Object.hasOwn(env,key)) throw Error("adopt_proc_invalid");
      env[key]=pair.slice(at+1);
    }
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
