import { test } from "bun:test";
import { existsSync } from "node:fs";
import { execTmux as runTmux } from "../../agent-node/src/tmux.js";
import { codexTmuxEnv } from "../../agent-node/src/runtime/adopt-codex-tmux.js";

// Opt-in is set by this suite's Dockerfile, never by a host-side test command.
export const containerEnabled = process.env.TEST658_CONTAINER === "1" && existsSync("/.dockerenv");
export const containerTest = test.skipIf(!containerEnabled);

/** A fresh mkdtemp socket per test; track creation results, not teardown census. */
export function fixtureTmux(socket: string) {
  if (!containerEnabled) throw Error("container-only tmux fixture");
  if (!/^\/tmp\/(codex-[a-z-]+|preflight)-[^/]+\/socket$/.test(socket) || existsSync(socket))
    throw Error("fixture requires a fresh private socket");
  const owned = new Set<string>();
  const env = codexTmuxEnv(socket);
  function exec(args: string[], options: any = {}): any {
    if (args[0] === "kill-server" || args[0] === "kill-session") throw Error("fixture forbids broad cleanup");
    if (args[0] === "kill-pane" && !owned.has(args[args.indexOf("-t") + 1])) throw Error("pane not created by fixture");
    const command = args[0] === "new-session" ? [args[0], "-P", "-F", "#{pane_id}", ...args.slice(1)] : args;
    const result = runTmux(command, {...options, encoding:"utf8", env});
    if (args[0] === "new-session") {
      const pane = String(result).trim();
      if (!/^%\d+$/.test(pane)) throw Error("fixture creation did not return pane ID");
      owned.add(pane);
    }
    return result;
  }
  function cleanup() {
    // IDs are never reused during this server lifetime. Do not enumerate and
    // claim panes created by another actor, even on this private socket.
    for (const pane of owned) {
      try { runTmux(["kill-pane", "-t", pane], {env,stdio:"ignore"}); }
      catch (e: any) { if (e.status !== 1) throw e; } // already removed by tested stop
    }
    owned.clear();
  }
  return {exec, cleanup};
}
