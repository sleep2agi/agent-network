import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const cli = readFileSync(new URL("../bin/cli.ts", import.meta.url), "utf8");

describe("Codex co-presence launch readiness", () => {
  test("POSIX waits for the shared bridge protocol boundary before creating the TUI", () => {
    const start = cli.indexOf("async function startCopresenceOrchestration(");
    const end = cli.indexOf("async function startOpencodeCopresenceOrchestration(", start);
    const body = cli.slice(start, end);
    const bridgeSpawn = body.indexOf("② bridge tmux=");
    const readyWait = body.indexOf("const bridgeReady = await waitForTmuxPaneText(", bridgeSpawn);
    const tuiCreate = body.indexOf("const tuiCmd = [", bridgeSpawn);
    expect(bridgeSpawn).toBeGreaterThan(0);
    expect(readyWait).toBeGreaterThan(bridgeSpawn);
    expect(tuiCreate).toBeGreaterThan(readyWait);
    expect(body.slice(bridgeSpawn, tuiCreate)).not.toContain("setTimeout(r, 3000)");
  });

  test("app-server, bridge and TUI receive one node-specific CODEX_HOME on both launchers", () => {
    const posixStart = cli.indexOf("async function startCopresenceOrchestration(");
    const posixEnd = cli.indexOf("async function startOpencodeCopresenceOrchestration(", posixStart);
    const posix = cli.slice(posixStart, posixEnd);
    expect(posix.match(/export CODEX_HOME=/g)).toHaveLength(3);

    const windowsStart = cli.indexOf("async function startWindowsCodexCopresence(");
    const windowsEnd = cli.indexOf("async function startCopresenceOrchestration(", windowsStart);
    const windows = cli.slice(windowsStart, windowsEnd);
    expect(windows).toContain("CODEX_HOME: opts.codexHome");
    expect(windows).toContain("env: { ...process.env, CODEX_HOME: opts.codexHome }");
  });
});
