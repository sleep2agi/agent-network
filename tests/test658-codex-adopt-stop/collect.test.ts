import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { execTmux } from "../../agent-node/src/tmux.js";
import { collectCodexPanes, codexTmuxEnv } from "../../agent-node/src/runtime/adopt-codex-tmux.js";

test("real default socket: CJK three stages, unrelated decoy remains", () => {
  const workdir = mkdtempSync("/tmp/codex-evidence-"), uid = process.getuid!();
  const socket = `/tmp/tmux-${uid}/default`, codexHome = `${workdir}/codex-home`;
  mkdirSync(`/tmp/tmux-${uid}`, {recursive:true, mode:0o700});
  mkdirSync(codexHome, {mode:0o700});
  const scope = { alias: "测试节点", socket, codexHome, workdir, uid, marker: "fixture-marker" };
  const env = codexTmuxEnv(socket);
  const names = [scope.alias, `${scope.alias}-桥`, `${scope.alias}-appsrv`, "unrelated-decoy"];
  try {
    for (const name of names) execTmux(["new-session", "-d", "-s", name, "-c", workdir,
      `exec env ANET_NODE_MARKER=${name === "unrelated-decoy" ? "foreign" : scope.marker} CODEX_HOME=${codexHome} sleep 300`], {env});
    const panes = collectCodexPanes(scope);
    expect(panes.length).toBe(3);
    expect(panes.every(p => /^%\d+$/.test(p.pane))).toBe(true);
    expect(() => collectCodexPanes({...scope, marker:"wrong"})).toThrow("adopt_codex_identity_unproven");
    // Collection is read-only: all four sessions still exist.
    const sessions = execTmux(["list-sessions"], {env,encoding:"utf8"});
    expect(sessions).toContain("unrelated-decoy");
  } finally {
    // Container-only cleanup by enumerated opaque IDs, never names/kill-server.
    const ids = execTmux(["list-sessions", "-F", "#{session_id}"], {env,encoding:"utf8"}).trim().split("\n");
    for (const id of ids) if (/^\$\d+$/.test(id)) execTmux(["kill-session", "-t", id], {env});
  }
});
