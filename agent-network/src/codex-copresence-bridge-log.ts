/**
 * #535 (audit P1-2) — keep the codex co-presence bridge's last words.
 *
 * The bridge (piece ②) runs in its own tmux session. When it failed, that
 * session exited, and the launcher still printed
 *   Debug: tmux attach -t '=<alias>-桥'
 * which pointed at nothing. The audit only found the real cause
 * (`exact paired package identity validation failed: … unsafe ownership or
 * mode`) by re-running the bridge command by hand.
 *
 * Its stdout/stderr now also go to `<node dir>/codex-bridge.log`, and a failed
 * start prints the tail of that file plus the path. Same idea as the OpenCode
 * twin (copresence-bridge.log), with two differences:
 *   - the file is NOT under logs/: `anet logs` shows the reverse-sorted first
 *     `*.log` there, and a name like this sorts above agent-node's dated logs,
 *     so it would hide them;
 *   - the copy is capped (the bridge runs for days and agent-node already
 *     writes its own dated log). Past the cap the remainder is drained, never
 *     refused: a reader that stopped reading would SIGPIPE `tee` and with it
 *     the bridge's stdout.
 */

export const CODEX_BRIDGE_LOG_NAME = "codex-bridge.log";
export const CODEX_BRIDGE_LOG_CAP_BYTES = 2 * 1024 * 1024;
export const CODEX_BRIDGE_TAIL_LINES = 20;

/**
 * A bash statement that sends the rest of the script's stdout+stderr to the
 * pane AND to the log (whole lines, up to about CAP bytes, flushed line by line). `quotedLogPath` must already be
 * shell-quoted. The parent `exec`s anet next, so anet's pid is still the pane's
 * process; `tee`/`awk` inherit the session's ANET_NODE_MARKER and are
 * reaped with it on stop.
 */
export function codexBridgeTeeCommand(quotedLogPath: string, capBytes = CODEX_BRIDGE_LOG_CAP_BYTES): string {
  // 🔴 Not `head -c`: head buffers its output until it exits, so a bridge that is still running
  //    (the "did not attach within 25 s" case) left an EMPTY log — measured in the e2e.
  // 🔴 Not awk either: Debian's mawk block-buffers its INPUT from a pipe (fflush only helps output),
  //    so the same live-bridge log stayed empty in Docker while gawk on a dev box passed.
  //    Plain bash `read` takes one line as soon as it arrives. Past the cap the reader turns into
  //    `cat >/dev/null`, so it keeps draining and tee never sees a closed pipe.
  const cap = Math.max(0, Math.floor(capBytes));
  const sink = `n=0; while IFS= read -r l || [ -n "$l" ]; do n=$((n + \${#l} + 1)); if [ "$n" -gt ${cap} ]; then exec cat >/dev/null; fi; printf '%s\\n' "$l" >> ${quotedLogPath}; done`;
  // `-p` = --output-error=warn-nopipe. If the capped file sink disappears,
  // tee keeps the pane output alive instead of closing agent-node's stdout.
  return `exec > >(tee -p >(${sink})) 2>&1`;
}

/** Last `n` non-empty lines, with trailing whitespace trimmed. */
export function tailLines(text: string, n = CODEX_BRIDGE_TAIL_LINES): string[] {
  const lines = text.replace(/\r/g, "").split("\n").map((l) => l.replace(/\s+$/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n);
}

export interface BridgeFailureInput {
  readonly bridgeAlive: boolean;
  readonly attachCommand: string;
  readonly logPath: string;
  readonly logText: string;
  readonly waitedSeconds: number;
  readonly cleanupCommand: string;
}

/** What the launcher prints when the bridge did not report ready. */
export function bridgeLaunchFailureLines(i: BridgeFailureInput): string[] {
  const out: string[] = [];
  out.push(i.bridgeAlive
    ? `[anet] ❌ bridge did not attach to the shared app-server within ${i.waitedSeconds}s (it is still running).`
    : `[anet] ❌ bridge exited before attaching to the shared app-server.`);
  const tail = tailLines(i.logText);
  if (tail.length > 0) {
    out.push(`[anet]    Last ${tail.length} line(s) of the bridge output (${i.logPath}):`);
    for (const line of tail) out.push(`[anet]    | ${line}`);
  } else {
    out.push(`[anet]    The bridge wrote nothing to ${i.logPath}.`);
  }
  // Only offer an attach that can work: a dead session has nothing to attach to.
  if (i.bridgeAlive) out.push(`[anet]    Debug:   ${i.attachCommand}`);
  out.push(`[anet]    Full log: ${i.logPath}`);
  out.push(`[anet]    Cleanup: ${i.cleanupCommand}`);
  return out;
}
