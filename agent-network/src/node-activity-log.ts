// #1345 — file sink for the node-server (claude-code-cli stdio proxy) log.
//
// claude-code-cli nodes have NO agent-node process, so nothing ever wrote
// `.anet/nodes/<alias>/logs/` for them — "read the node log to verify a
// member's real state" was structurally impossible for half the fleet, and
// an empty logs/ dir looked exactly like "idle for a week" (#1345). The
// proxy is the only long-lived process we own in that mode and it already
// knows its alias (#203), so it carries the communication-layer log.
//
// Format parity with agent-node/src/cli.ts::_log: file named by UTC date
// (`YYYY-MM-DD.log`), line carries local wall-clock time. Every failure is
// swallowed — the MCP stdio loop must never die because a log line could
// not be written.
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";

export interface ActivityLogSink {
  append(line: string): void;
}

export function createActivityLogSink(
  baseDir: string,
  alias: string,
  now: () => Date = () => new Date(),
): ActivityLogSink {
  const dir = join(baseDir, ".anet", "nodes", alias, "logs");
  let dirReady = false;
  return {
    append(line: string): void {
      try {
        if (!dirReady) {
          mkdirSync(dir, { recursive: true });
          dirReady = true;
        }
        const date = now().toISOString().slice(0, 10);
        appendFileSync(join(dir, `${date}.log`), line + "\n");
      } catch {
        // Deliberately silent (same stance as cli.ts::_log): a broken or
        // read-only working directory must not take down the proxy. The
        // stderr copy of the same line still reaches the tmux pane.
        dirReady = false;
      }
    },
  };
}
