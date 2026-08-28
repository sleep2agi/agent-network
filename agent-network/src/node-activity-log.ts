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
import { appendFileSync, existsSync, mkdirSync } from "fs";
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
  let created = false;
  let disabled = false;
  return {
    append(line: string): void {
      if (disabled) return;
      try {
        if (!created) {
          mkdirSync(dir, { recursive: true });
          created = true;
        } else if (!existsSync(dir)) {
          // 🔴 The directory existed and is now gone — that is `anet node
          // stop`/delete tearing the node dir down while this proxy is still
          // flushing its last lines (SSE-disconnect callbacks fire exactly
          // then). Recreating it here loses the race on purpose-built
          // cleanup verification: stop's "authoritative local resources
          // survived" check red-flags the resurrected directory and the
          // whole stop fails. Once torn down, never write again.
          disabled = true;
          return;
        }
        const date = now().toISOString().slice(0, 10);
        appendFileSync(join(dir, `${date}.log`), line + "\n");
      } catch {
        // Deliberately silent (same stance as cli.ts::_log): a broken or
        // read-only working directory must not take down the proxy. The
        // stderr copy of the same line still reaches the tmux pane. Do NOT
        // reset `created` — that would re-open the mkdir path and the
        // resurrection race above.
      }
    },
  };
}
