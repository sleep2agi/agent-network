import { readFileSync, readdirSync } from "node:fs";
import { codexRoleNames, type CodexAdoptionScope } from "./adopt-codex-evidence.js";
import { listCodexPanes } from "./adopt-codex-tmux.js";
import { processStamp } from "./adopt-process-tree.js";

/** Never authorize signals with an old boot's marker or stored PID. Even a
 * differently marked process using this CODEX_HOME requires fresh adoption. */
export function assertCodexAbsentAfterReboot(scope: CodexAdoptionScope): void {
  const names = new Set(Object.values(codexRoleNames(scope)));
  if (listCodexPanes(scope, true).some(row => names.has(row[0]))) throw Error("adopt_codex_readopt_required");
  const entries = [Buffer.from(`CODEX_HOME=${scope.codexHome}\0`), Buffer.from(`ANET_NODE_MARKER=${scope.marker}\0`)];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name) || Number(name) <= 1) continue;
    const pid = Number(name), stamp = processStamp(pid);
    if (!stamp || stamp.uid !== scope.uid) continue;
    let raw: Buffer;
    try { raw = readFileSync(`/proc/${pid}/environ`); }
    catch { if (!processStamp(pid)) continue; throw Error("adopt_proc_unreadable"); }
    for (const entry of entries) {
      for (let at = raw.indexOf(entry); at >= 0; at = raw.indexOf(entry, at + 1)) {
        if (at === 0 || raw[at - 1] === 0) throw Error("adopt_codex_readopt_required");
      }
    }
  }
}
