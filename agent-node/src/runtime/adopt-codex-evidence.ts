import { isAbsolute } from "node:path";
import type { AdoptionProc } from "./adopt-proc.js";

export const CODEX_STOP_ORDER = ["bridge", "tui", "appsrv"] as const;
export type CodexRole = typeof CODEX_STOP_ORDER[number];
export interface CodexPaneSnapshot {
  socket: string;
  session: string;
  pane: string;
  sessionName: string;
  rootPid?: number;
  // A fresh, complete live tree, not PIDs copied from the identity file.
  processes: readonly AdoptionProc[];
}
export interface CodexAdoptionScope {
  alias: string;
  socket: string;
  marker: string;
  codexHome: string;
  workdir: string;
  uid: number;
}

/** Pure evidence gate. Caller must first verify config node/network/Hub and
 * canonical private paths, capture complete trees, and repeat before actions.
 * Names select candidates only; matching a name never authorizes a signal.
 * No stored PID, default-socket ban, or fallback to name-based tmux targeting.
 */
export function verifyCodexPanes(scope: CodexAdoptionScope, panes: readonly CodexPaneSnapshot[], roles: readonly CodexRole[] = CODEX_STOP_ORDER): Record<CodexRole, CodexPaneSnapshot> {
  if (!scope.alias || !scope.marker || !isAbsolute(scope.socket) ||
      !isAbsolute(scope.codexHome) || !isAbsolute(scope.workdir) || !Number.isSafeInteger(scope.uid) || scope.uid < 0)
    throw Error("adopt_codex_scope_invalid");
  const names = { bridge: `${scope.alias}-桥`, tui: scope.alias, appsrv: `${scope.alias}-appsrv` };
  const result = {} as Record<CodexRole, CodexPaneSnapshot>;
  const sessions = new Set<string>(), ids = new Set<string>();
  for (const role of roles) {
    const matches = panes.filter(p => p.socket === scope.socket && p.sessionName === names[role]);
    // Multi-pane sessions need an explicit future contract, never collateral kill.
    if (matches.length !== 1) throw Error("adopt_codex_stage_ambiguous");
    const pane = matches[0];
    if (!/^\$\d+$/.test(pane.session) || !/^%\d+$/.test(pane.pane) ||
        sessions.has(pane.session) || ids.has(pane.pane) ||
        panes.some(p => p.socket === scope.socket && p.session === pane.session && p !== pane))
      throw Error("adopt_codex_target_ambiguous");
    if (!pane.processes.length) throw Error("adopt_codex_stage_missing");
    for (const proc of pane.processes) {
      if (proc.uid !== scope.uid || proc.cwd !== scope.workdir ||
          proc.env.ANET_NODE_MARKER !== scope.marker || proc.env.CODEX_HOME !== scope.codexHome)
        throw Error("adopt_codex_identity_unproven");
      if (!Number.isSafeInteger(proc.pid) || proc.pid <= 1 || !/^\d+$/.test(proc.birth))
        throw Error("adopt_codex_generation_invalid");
    }
    sessions.add(pane.session); ids.add(pane.pane); result[role] = pane;
  }
  return result;
}
