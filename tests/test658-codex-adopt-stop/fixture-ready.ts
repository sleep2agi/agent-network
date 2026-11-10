// new-session returns before its shell has exec'd the identity-bearing
// process. Only synchronize the fixture; never retry a production refusal.
import { readdirSync, writeFileSync } from "node:fs";
import { listCodexPanes } from "../../agent-node/src/runtime/adopt-codex-tmux.js";
import { readAdoptionProc } from "../../agent-node/src/runtime/adopt-proc.js";
import { processStamp } from "../../agent-node/src/runtime/adopt-process-tree.js";
import type { CodexAdoptionScope } from "../../agent-node/src/runtime/adopt-codex-evidence.js";

export function heldIdentityCommand(release: string, body: string): string {
  return `while [ ! -f '${release}' ]; do sleep 0.01; done; ${body}`;
}

export interface HeldStage {
  pane: string;
  marker: string;
  codexHome: string;
  cwd: string;
  argv?: string;
  argvIncludes?: string;
  descendantCwd?: string;
}

function descendantPids(root: number): number[] {
  const stamps = readdirSync("/proc").filter(x => /^\d+$/.test(x) && Number(x) > 1)
    .map(x => { try { return processStamp(Number(x)); } catch { return null; } })
    .filter(p => p !== null);
  const selected = new Set([root]);
  for (let changed = true; changed;) {
    changed = false;
    for (const p of stamps) if (selected.has(p.ppid) && !selected.has(p.pid)) { selected.add(p.pid); changed = true; }
  }
  selected.delete(root);
  return [...selected];
}

function stageReady(scope: CodexAdoptionScope, stage: HeldStage, pid: number): boolean {
  let proc;
  try { proc = readAdoptionProc(pid); } catch { return false; }
  if (!proc || proc.uid !== scope.uid || proc.cwd !== stage.cwd ||
      proc.env.CODEX_HOME !== stage.codexHome || proc.env.ANET_NODE_MARKER !== stage.marker)
    return false;
  if (stage.descendantCwd) {
    return descendantPids(proc.pid).some(childPid => {
      let child;
      try { child = readAdoptionProc(childPid); } catch { return false; }
      return !!child && child.argv.join(" ") === "sleep 300" && child.cwd === stage.descendantCwd &&
        child.uid === scope.uid && child.env.CODEX_HOME === stage.codexHome && child.env.ANET_NODE_MARKER === stage.marker;
    });
  }
  if (stage.argvIncludes) return proc.argv.join(" ").includes(stage.argvIncludes);
  return proc.argv.join(" ") === (stage.argv ?? "sleep 300");
}

/** Every pane started against `release` must be listed. Writing the file lets them exec. */
export async function waitForHeldStages(scope: CodexAdoptionScope, release: string, stages: readonly HeldStage[]): Promise<void> {
  writeFileSync(release, "ready", { mode: 0o600 });
  const want = new Set(stages.map(stage => stage.pane));
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    let rows: string[][] = [];
    try { rows = listCodexPanes(scope).filter(row => want.has(row[2])); }
    catch { rows = []; }
    if (rows.length === stages.length && stages.every(stage => {
      const row = rows.find(item => item[2] === stage.pane);
      return !!row && stageReady(scope, stage, Number(row[3]));
    })) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error("fixture identity-bearing stages not ready");
}
