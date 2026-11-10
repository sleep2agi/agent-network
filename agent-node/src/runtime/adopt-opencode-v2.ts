// OpenCode V2 co-presence adoption (phase 1: registration for source reads / fork).
//
// A hand-started co-presence node is a human TUI + agent-node bridge + shared
// `opencode serve`. Phase 1 only *registers* it with the co-located daemon so the
// Hub has exactly one manager and the daemon's source reader may resolve it.
// Nothing here signals, spawns or rewrites the node: start/stop stay refused
// (`adopt_opencode_lifecycle_unsupported`) until a verified restart path exists.
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AdoptionLocalIdentity } from "./adopt-local-identity.js";
import type { AdoptionProc } from "./adopt-proc.js";

/** Read-only pidfile. Hand-started nodes write it 0664; we never signal this pid,
 * only compare its /proc identity, so group-writability is acceptable here. */
export function readOpenCodeBridgePid(nodeDir: string, uid: number): number {
  const file = join(nodeDir, ".pid");
  let st;
  try { st = lstatSync(file); } catch { throw Error("adopt_opencode_bridge_not_running"); }
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o002)) throw Error("adopt_pidfile_unsafe");
  const raw = readFileSync(file, "utf8").trim();
  const pid = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(pid) || pid <= 1) throw Error("adopt_pid_invalid");
  return pid;
}

/** The pid must be this node's live agent-node bridge: same uid, cwd = workdir, argv
 * carries exactly this node's --config. Environment is intentionally not compared:
 * co-presence bridges carry launcher-specific markers that a daemon cannot reproduce. */
export function verifyOpenCodeBridge(identity: AdoptionLocalIdentity, proc: AdoptionProc | null, uid: number): void {
  if (!proc) throw Error("adopt_opencode_bridge_not_running");
  if (proc.uid !== uid || proc.cwd !== identity.workdir) throw Error("adopt_process_identity_mismatch");
  const at = proc.argv.indexOf("--config");
  if (at < 0 || proc.argv[at + 1] !== identity.configPath || proc.argv.filter(v => v === "--config").length !== 1
      || !proc.argv.some(v => v === "agent-node" || v.endsWith("/agent-node") || /\/agent-node\/dist\/cli\.js$/.test(v))) {
    throw Error("adopt_process_argv_mismatch");
  }
}
