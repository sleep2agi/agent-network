import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { execTmux } from "../tmux.js";
import { parseTmuxRows, tmuxFormat, tmuxUtf8Args } from "../tmux-format.js";
import { processStamp } from "./adopt-process-tree.js";
import type { AdoptionLocalIdentity } from "./adopt-local-identity.js";
import type { AdoptionProc } from "./adopt-proc.js";
import type { AdoptedChild } from "./adopt-registry.js";

export function configHash(identity: AdoptionLocalIdentity): string {
  return createHash("sha256").update(JSON.stringify(identity.config)).digest("hex");
}
export function privateSocket(socket: string, uid: number): void {
  if (!isAbsolute(socket) || socket.endsWith(`/tmux-${uid}/default`) || /[\r\n\0]/.test(socket)) throw Error("adopt_explicit_private_socket_required");
  const dir = lstatSync(dirname(socket));
  if (!dir.isDirectory() || dir.isSymbolicLink() || realpathSync(dirname(socket)) !== dirname(socket) || dir.uid !== uid || dir.mode & 0o077) throw Error("adopt_socket_directory_unsafe");
  const st = lstatSync(socket);
  if (!st.isSocket() || st.uid !== uid) throw Error("adopt_socket_unsafe");
}
export function paneEvidence(socket: string, pane: string, uid: number) {
  privateSocket(socket, uid);
  if (!/^%\d+$/.test(pane)) throw Error("adopt_pane_invalid");
  const output = execTmux(tmuxUtf8Args(["display-message", "-p", "-t", pane, tmuxFormat(["#{pane_pid}", "#{session_name}", "#{pane_dead}"])]),
    { encoding: "utf8", timeout: 5000, env: { ...process.env, ANET_TMUX_SOCKET: socket, TMUX: undefined, TMUX_PANE: undefined } });
  const rows = parseTmuxRows(output, 3);
  if (rows.length !== 1) throw Error("adopt_pane_unverified");
  const result = rows[0];
  const pid = Number(result[0]);
  if (!Number.isSafeInteger(pid) || pid <= 1 || !result[1] || /[\r\n\0]/.test(result[1])) throw Error("adopt_pane_unverified");
  return { pid, session: result[1], dead: result[2] === "1" };
}
export function captureLaunchEvidence(identity: AdoptionLocalIdentity, proc: AdoptionProc): NonNullable<AdoptedChild["launch_evidence"]> {
  if (!proc.env.TMUX) return { mode: "bare", config_hash: configHash(identity) };
  const socket = proc.env.TMUX.split(",")[0], pane = proc.env.TMUX_PANE ?? "";
  const seen = paneEvidence(socket, pane, proc.uid);
  let cursor = processStamp(proc.pid), belongs = false;
  for (let i = 0; cursor && i < 128; i++) {
    if (cursor.uid !== proc.uid) break;
    if (cursor.pid === seen.pid) { belongs = true; break; }
    if (cursor.ppid <= 1) break;
    cursor = processStamp(cursor.ppid);
  }
  if (!belongs || seen.dead) throw Error("adopt_pane_process_mismatch");
  return { mode: "tmux", config_hash: configHash(identity), socket, pane, session: seen.session };
}
