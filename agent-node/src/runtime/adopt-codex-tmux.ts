import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { execTmux } from "../tmux.js";
import { parseTmuxRows, tmuxListArgs } from "../tmux-format.js";
import { processStamp, sameProcess } from "./adopt-process-tree.js";
import { hasAdoptionMarker, readAdoptionProc } from "./adopt-proc.js";
import { CODEX_STOP_ORDER, codexRoleNames, verifyCodexPanes, type CodexRole, type CodexAdoptionScope, type CodexPaneSnapshot } from "./adopt-codex-evidence.js";

export function codexSocket(socket: string, uid: number): void {
  if (!isAbsolute(socket) || /[\0\r\n]/.test(socket)) throw Error("adopt_socket_unsafe");
  const parent = dirname(socket), dir = lstatSync(parent), st = lstatSync(socket);
  if (!dir.isDirectory() || dir.isSymbolicLink() || realpathSync(parent) !== parent || dir.uid !== uid || (dir.mode & 0o077) ||
      !st.isSocket() || st.isSymbolicLink() || st.uid !== uid) throw Error("adopt_socket_unsafe");
}
export function codexTmuxEnv(socket: string) {
  return { ...process.env, ANET_TMUX_SOCKET: socket, TMUX: undefined, TMUX_PANE: undefined };
}
/** Only list-*; explicit socket via the shared wrapper. Never display/target by name. */
export function listCodexPanes(scope: CodexAdoptionScope, allowStopped = false) {
  try { codexSocket(scope.socket, scope.uid); }
  catch (e: any) { if (allowStopped && e.code === "ENOENT") return []; throw e; }
  let output: string;
  try { output = execTmux(tmuxListArgs(["list-panes", "-a"],
    ["#{session_name}", "#{session_id}", "#{pane_id}", "#{pane_pid}", "#{pane_dead}"]),
    { encoding: "utf8", timeout: 5000, env: codexTmuxEnv(scope.socket) }); }
  catch (e: any) {
    const stderr = String(e.stderr ?? "");
    if (allowStopped && e.status === 1 && (/^no server running on /m.test(stderr) ||
        /^error connecting to .* \(No such file or directory\)$/m.test(stderr))) return [];
    throw Error("adopt_tmux_listing_failed");
  }
  const rows = parseTmuxRows(output, 5);
  if (rows.length !== output.split(/\r?\n/).filter(Boolean).length) throw Error("adopt_tmux_listing_invalid");
  return rows;
}
function tree(root: number) {
  const stamps = readdirSync("/proc").filter(x => /^\d+$/.test(x) && Number(x) > 1)
    .map(x => processStamp(Number(x))).filter(p => p !== null);
  const rootStamp = stamps.find(p => p.pid === root);
  if (!rootStamp) throw Error("adopt_codex_stage_missing");
  const selected = new Set([root]);
  for (let changed = true; changed;) {
    changed = false;
    for (const p of stamps) if (selected.has(p.ppid) && !selected.has(p.pid)) { selected.add(p.pid); changed = true; }
  }
  return stamps.filter(p => selected.has(p.pid)).sort((a,b) => a.pid-b.pid).map(stamp => {
    const proc = readAdoptionProc(stamp.pid);
    if (!proc || proc.birth !== stamp.birth || !sameProcess(stamp, processStamp(stamp.pid))) throw Error("adopt_process_generation_changed");
    return proc;
  });
}
export function assertNoEscapedCodexProcesses(scope: CodexAdoptionScope, panes: readonly CodexPaneSnapshot[]): void {
  const owned = new Map(panes.flatMap(p=>p.processes).map(p=>[p.pid,p.birth]));
  for (const item of readdirSync("/proc")) {
    if (!/^\d+$/.test(item) || Number(item)<=1) continue;
    const pid=Number(item), stamp=processStamp(pid);
    if (!stamp || stamp.uid!==scope.uid) continue;
    if (!hasAdoptionMarker(pid, scope.marker)) continue;
    let proc;
    try {proc=readAdoptionProc(pid);} catch(e) {if(!processStamp(pid))continue;throw e;}
    if(proc?.env.ANET_NODE_MARKER===scope.marker && owned.get(pid)!==proc.birth)
      throw Error("adopt_codex_untracked_process");
  }
}
export function collectCodexPanes(scope: CodexAdoptionScope, roles: readonly CodexRole[] = CODEX_STOP_ORDER, allowMissing = false): CodexPaneSnapshot[] {
  const byRole = codexRoleNames(scope);
  const rows = listCodexPanes(scope,allowMissing);
  const names = new Set(roles.map(role => byRole[role]));
  const targets = new Set(rows.filter(r => names.has(r[0])).map(r => r[1]));
  const result = rows.filter(r => targets.has(r[1]) && !(allowMissing && r[4]==="1")).map(r => {
    if (r[4] !== "0" || !/^\d+$/.test(r[3])) throw Error("adopt_codex_stage_missing");
    return { socket: scope.socket, sessionName: r[0], session: r[1], pane: r[2], rootPid: Number(r[3]), processes: tree(Number(r[3])) };
  });
  // Missing stages are allowed only for continuation, after a global marker
  // census proves no detached/extra stage is omitted from the verified trees.
  const liveRoles = allowMissing ? roles.filter(role=>result.some(p=>p.sessionName===byRole[role])) : roles;
  verifyCodexPanes(scope, result, liveRoles);
  // Even a dead extra pane makes the session topology ambiguous.
  for(const pane of result) if(rows.filter(r=>r[1]===pane.session).length!==1) throw Error("adopt_codex_target_ambiguous");
  assertNoEscapedCodexProcesses(scope,result);
  // No await: reject a changed topology or process generation before returning.
  if (!isDeepStrictEqual(rows, listCodexPanes(scope,allowMissing))) throw Error("adopt_codex_topology_changed");
  for (const pane of result) {
    const row = rows.find(r => r[2] === pane.pane)!;
    if (!isDeepStrictEqual(pane.processes, tree(Number(row[3])))) throw Error("adopt_process_generation_changed");
  }
  return result;
}
