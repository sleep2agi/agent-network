import { readdirSync } from "node:fs";
import { execTmux } from "../tmux.js";
import { CODEX_STOP_ORDER, codexCwdAllowed, codexRoleNames, type CodexAdoptionScope } from "./adopt-codex-evidence.js";
import { collectCodexPanes, codexTmuxEnv, listCodexPanes } from "./adopt-codex-tmux.js";
import { processStamp, sameProcess, stopVerifiedTree, type ProcessStamp } from "./adopt-process-tree.js";
import { hasAdoptionMarker, readAdoptionProc } from "./adopt-proc.js";

const pids = () => readdirSync("/proc").filter(x => /^\d+$/.test(x) && Number(x)>1).map(Number);
export async function stopCodexStages(scope: CodexAdoptionScope): Promise<void> {
  // Verify every live stage and reject detached/extra marker processes before
  // the first signal. Missing stages may be the result of an interrupted stop.
  collectCodexPanes(scope,CODEX_STOP_ORDER,true);
  for (let i=0; i<CODEX_STOP_ORDER.length; i++) {
    const panes = collectCodexPanes(scope,CODEX_STOP_ORDER,true);
    const pane = panes.find(p=>p.sessionName===codexRoleNames(scope)[CODEX_STOP_ORDER[i]]);
    if (!pane) continue;
    const root = processStamp(pane.rootPid!);
    const before = pane.processes.find(p => p.pid === pane.rootPid);
    if (!root || root.birth !== before?.birth || root.uid !== scope.uid || root.pid === process.pid)
      throw Error("adopt_process_generation_changed");
    const checked = new Map<number, ProcessStamp>();
    await stopVerifiedTree(root, {
      read: pid => {const stamp=processStamp(pid); if(stamp) checked.set(pid,stamp); return stamp;}, list: pids, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      signal: (pid, signal) => {
        const stamp=checked.get(pid);
        const current=processStamp(pid); if(!current) return;
        if (!stamp || !sameProcess(stamp,current)) throw Error("adopt_process_generation_changed");
        // Resume only the generation already frozen/verified by stopVerifiedTree.
        // TERM may already have made environ unreadable before the zombie flag.
        if (signal === "SIGCONT") {try {process.kill(pid,signal);} catch(e:any){if(e.code!=="ESRCH")throw e;} return;}
        let proc;
        try { proc = readAdoptionProc(pid); }
        catch (e) { if (!processStamp(pid)) return; throw e; }
        if (!proc) return;
        if (proc.birth !== stamp.birth || pid === process.pid || proc.uid !== scope.uid || !codexCwdAllowed(scope,proc.cwd,pid===root.pid) ||
            proc.env.ANET_NODE_MARKER !== scope.marker || proc.env.CODEX_HOME !== scope.codexHome)
          throw Error("adopt_codex_identity_unproven");
        const final=processStamp(pid); if(!final)return;
        if (!sameProcess(stamp,final)) throw Error("adopt_process_generation_changed");
        try {process.kill(pid, signal);} catch(e:any){if(e.code!=="ESRCH")throw e;}
      },
    });
    // remain-on-exit may retain a dead pane. Only remove that same verified ID,
    // never its name, a replacement pane, or the whole shared server.
    let retained = listCodexPanes(scope,true).find(r => r[2] === pane.pane);
    for(let retry=0;retained?.[4]==="0" && retry<20;retry++) {
      await new Promise(resolve=>setTimeout(resolve,50));
      retained=listCodexPanes(scope,true).find(r=>r[2]===pane.pane);
    }
    if (retained) {
      if (retained[1] !== pane.session || retained[4] !== "1" || Number(retained[3]) !== pane.rootPid)
        throw Error("adopt_codex_topology_changed");
      execTmux(["kill-pane", "-t", pane.pane], {env:codexTmuxEnv(scope.socket), timeout:5000});
    }
  }
  assertCodexStopped(scope);
}

export function assertCodexStopped(scope: CodexAdoptionScope): void {
  const names = new Set(Object.values(codexRoleNames(scope)));
  // A dead remain-on-exit pane from a prior daemon is not a running stage.
  if (listCodexPanes(scope, true).some(r => names.has(r[0]) && r[4]!=="1")) throw Error("adopt_codex_stage_still_running");
  // A child that escaped its original tree must not permit a false stopped ack.
  for (const pid of pids()) {
    const stamp = processStamp(pid); if (!stamp || stamp.uid !== scope.uid) continue;
    if (!hasAdoptionMarker(pid, scope.marker)) continue;
    let proc;
    try { proc = readAdoptionProc(pid); } catch { if (!processStamp(pid)) continue; throw Error("adopt_proc_unreadable"); }
    if (proc?.env.ANET_NODE_MARKER === scope.marker) throw Error("adopt_codex_stage_still_running");
  }
}
