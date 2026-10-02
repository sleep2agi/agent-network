import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { serializeProfileForConfigJson } from "./profile-serialize";

// #448 —— 每条会(重新)拉起 codex 子进程的路径,都必须 ① 从节点自己的 config/目录取 CODEX_HOME,
// ② 起来之后读 /proc/<pid>/environ 核对、不符就拒。这里按路径逐条钉住接线;行为本身由
// agent-node/src/codex-home-enforce.test.ts(真子进程)覆盖。
const CLI = readFileSync(join(import.meta.dir, "..", "bin", "cli.ts"), "utf8");

function body(startMarker: string, endMarker: string): string {
  const a = CLI.indexOf(startMarker);
  expect(a).toBeGreaterThan(-1);
  const b = CLI.indexOf(endMarker, a + startMarker.length);
  expect(b).toBeGreaterThan(a);
  return CLI.slice(a, b);
}

describe("#448 co-presence tmux sessions: CODEX_HOME set on the pane's FIRST process, then verified", () => {
  const posix = body("async function startCopresenceOrchestration(", "async function startOpencodeCopresenceOrchestration(");

  test("all three new-session calls pass -e CODEX_HOME (the tmux server env may carry another node's)", () => {
    const calls = posix.split('"new-session"').slice(1).map((c) => c.slice(0, 600));
    expect(calls.length).toBe(3);
    for (const call of calls) expect(call).toContain('"-e", `CODEX_HOME=${opts.codexHome}`');
  });

  test("the inner export stays too (bash -l profiles may reset it)", () => {
    expect(posix.split("`export CODEX_HOME=${shellQuote(opts.codexHome)}`").length - 1).toBe(3);
  });

  test("appsrv is verified right after READY, all three before success is printed", () => {
    const ready = posix.indexOf("① app-server READY");
    const firstCheck = posix.indexOf("assertCopresenceSessionsCodexHome([appsrvSession]");
    expect(firstCheck).toBeGreaterThan(ready);
    const allCheck = posix.indexOf("assertCopresenceSessionsCodexHome([appsrvSession, bridgeSession, tuiSession]");
    expect(allCheck).toBeGreaterThan(firstCheck);
    expect(posix.indexOf("✅ 共存节点")).toBeGreaterThan(allCheck);
  });

  test("the bridge learns the exact TUI session name for health.tui", () => {
    expect(posix).toContain('"-e", `ANET_CODEX_TUI_SESSION=${tuiSession}`');
  });

  test("a --codex-home override is persisted into config before the bridge reads it", () => {
    const persist = posix.indexOf("rawCfg.codexHome = opts.codexHome");
    expect(persist).toBeGreaterThan(-1);
    expect(posix.indexOf("const launchBridge")).toBeGreaterThan(persist);
  });

  test("assertCopresenceSessionsCodexHome fails closed: kills the node's sessions and exits non-zero", () => {
    const fn = body("function assertCopresenceSessionsCodexHome(", "\n}\n");
    expect(fn).toContain("verifyProcessTreeCodexHome(");
    expect(fn).toContain("killTmuxSession(s)");
    expect(fn).toContain("process.exit(1)");
    // 读不到 ≠ 通过:skipped 必须说出来
    expect(fn).toContain("skipped");
  });
});

describe("#448 launcher supervisor (agent-node spawn + exit-75 restart loop)", () => {
  const launch = body("async function launchAgent(", "  } else {\n    // spawn claude CLI");

  test("CODEX_HOME is resolved from the node's config/dir and applied AFTER profile env merge", () => {
    const merge = launch.indexOf("Object.assign(env, resolveProfileEnv(");
    const apply = launch.indexOf("applyNodeCodexHome(env, resolveNodeCodexHome(");
    expect(merge).toBeGreaterThan(-1);
    expect(apply).toBeGreaterThan(merge);
  });

  test("every runOnce spawn (first start AND each sentinel-75 respawn) is checked and refused on mismatch", () => {
    const runOnce = body("runOnce: async (ctrl) => {", "if (exitInfo.code === RESTART_SENTINEL)");
    const spawnAt = runOnce.indexOf("spawnOwnedNodeChild(");
    const verifyAt = runOnce.indexOf("verifyProcessTreeCodexHome({ rootPid: child.pid, expected: expectedCodexHome");
    expect(spawnAt).toBeGreaterThan(-1);
    expect(verifyAt).toBeGreaterThan(spawnAt);
    expect(runOnce.slice(verifyAt)).toContain("lastNonRestartCode = 1;");
  });
});

describe("#448 other entry points", () => {
  test("node start dispatch: codexHome = flag → persisted config → <nodeDir>/codex-home, made absolute", () => {
    expect(CLI).toContain('codexHome: resolve(opts["codex-home"] || (typeof prof.codexHome === "string" && prof.codexHome ? prof.codexHome : codexHomeDefault)),');
  });

  test("lifecycle controller (node codex start/restart/resume) does not hand its shell's CODEX_HOME to the launcher", () => {
    const start = body("    start: async () => {", "    waitHubOnline:");
    expect(start).toContain("delete env.CODEX_HOME;");
    expect(start.indexOf("delete env.CODEX_HOME;")).toBeLessThan(start.indexOf("spawnSync(process.execPath, argv"));
  });

  test("profile-serialize keeps codexHome (an explicit-field rebuild silently drops new fields)", () => {
    const out = serializeProfileForConfigJson({ runtime: "codex-app-server", codexHome: "/srv/h" }, {});
    expect(out.codexHome).toBe("/srv/h");
    const none = serializeProfileForConfigJson({ runtime: "codex-app-server" }, {});
    expect("codexHome" in none).toBe(false);
  });
});
