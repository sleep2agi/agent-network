import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const cli = readFileSync(new URL("../bin/cli.ts", import.meta.url), "utf8");
const tmuxPresent = (() => { try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); return true; } catch { return false; } })();

describe("Codex co-presence launch readiness", () => {
  test("tmux receipt capture joins wrapped lines before exact identity matching", () => {
    const waitStart = cli.indexOf("function waitForTmuxPaneText(");
    const waitEnd = cli.indexOf("function capturePane(", waitStart);
    expect(cli.slice(waitStart, waitEnd)).toContain('"-p", "-J", "-S", "-200"');
  });

  test.skipIf(!tmuxPresent)("80-column tmux -J reconstructs an exact long bridge receipt", async () => {
    const session = `t1220-${process.pid}-${Date.now()}`;
    const receipt = "[codex-app-server] client-health role=bridge remote=ws://127.0.0.1:24700 thread=thread_0123456789abcdef0123456789abcdef";
    try {
      execFileSync("tmux", ["new-session", "-d", "-x", "80", "-y", "24", "-s", session,
        "bash", "-lc", `printf '%s\\n' '${receipt}'; sleep 5`]);
      let joined = "";
      for (let attempt = 0; attempt < 20 && !joined.includes(receipt); attempt++) {
        joined = execFileSync("tmux", ["capture-pane", "-t", `${session}:0.0`, "-p", "-J", "-S", "-20"], { encoding: "utf8" });
        if (!joined.includes(receipt)) await Bun.sleep(25);
      }
      expect(joined).toContain(receipt);
    } finally {
      try { execFileSync("tmux", ["kill-session", "-t", `=${session}`], { stdio: "ignore" }); } catch {}
    }
  });

  test("#849 POSIX app-server readiness probes the loopback port, not a pane string the binary never prints", () => {
    const start = cli.indexOf("async function startCopresenceOrchestration(");
    const end = cli.indexOf("\nasync function ", start + 1);
    const body = cli.slice(start, end);
    const appsrvProbe = body.indexOf("const bound = await waitForLoopbackPort(port, 25_000);");
    const bridgeSpawn = body.indexOf("const bridgeReady = await waitForTmuxPaneText(");
    expect(appsrvProbe).toBeGreaterThan(0);
    expect(bridgeSpawn).toBeGreaterThan(appsrvProbe);
    // strings -a <codex binary> | grep -c 'listening on: ' → 0 (#849 评论);等它等于等满超时。
    expect(body).not.toContain("`listening on: ${wsUrl}`");
  });

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
    expect(posix.match(/export CODEX_HOME=\$\{shellQuote\(opts\.codexHome\)\}/g)).toHaveLength(3);

    const windowsStart = cli.indexOf("async function startWindowsCodexCopresence(");
    const windowsEnd = cli.indexOf("async function startCopresenceOrchestration(", windowsStart);
    const windows = cli.slice(windowsStart, windowsEnd);
    expect(windows).toContain("CODEX_HOME: opts.codexHome");
    expect(windows).toContain("env: { ...process.env, CODEX_HOME: opts.codexHome }");
  });

  test("each POSIX role receives the node marker exactly once", () => {
    const start = cli.indexOf("async function startCopresenceOrchestration(");
    const end = cli.indexOf("async function startOpencodeCopresenceOrchestration(", start);
    const body = cli.slice(start, end);
    expect(body.match(/`ANET_NODE_MARKER=\$\{identityMarker\}`/g)).toHaveLength(3);
    for (const session of ["appsrvSession", "bridgeSession", "tuiSession"]) {
      const roleStart = body.indexOf(`"-s", ${session}`);
      const roleEnd = body.indexOf('"bash", "-lc"', roleStart);
      expect(body.slice(roleStart, roleEnd).match(/`ANET_NODE_MARKER=\$\{identityMarker\}`/g)).toHaveLength(1);
    }
  });

  test("POSIX success requires exact bridge receipt and PID-attributed loopback connection", () => {
    const start = cli.indexOf("async function startCopresenceOrchestration(");
    const end = cli.indexOf("async function startOpencodeCopresenceOrchestration(", start);
    const body = cli.slice(start, end);
    const receipt = body.indexOf("bridgeClientHealthReceipt(wsUrl, threadId)");
    const rendered = body.indexOf("probePosixOwnedLoopbackConnection(tuiIdentity.pid, port)");
    const success = body.indexOf("✅ 共存节点");
    expect(receipt).toBeGreaterThan(0);
    expect(rendered).toBeGreaterThan(receipt);
    expect(success).toBeGreaterThan(rendered);
    expect(body.slice(rendered, success)).toContain("process.exit(1)");
  });

  test("fresh path performs no thread RPC and launches deferred bridge before remote-only TUI", () => {
    const start = cli.indexOf("async function createCodexCopresenceThread(");
    const end = cli.indexOf("async function askTypedConfirmation", start);
    const body = cli.slice(start, end);
    expect(body).toContain('return { threadId: "", freshDeferred: true }');
    expect(body).not.toContain("createTuiHealthChallenge");
    expect(body).not.toContain('request("thread/start"');
    const orchestration = cli.slice(cli.indexOf("async function startCopresenceOrchestration("), cli.indexOf("async function startOpencodeCopresenceOrchestration("));
    const waiting = orchestration.indexOf("waiting-for-tui-thread");
    const remoteOnly = orchestration.indexOf("const tuiArgv = codexTuiLaunchArgs(");
    expect(waiting).toBeGreaterThan(0);
    expect(remoteOnly).toBeGreaterThan(waiting);
  });

  test("crash-window pending promotion is authoritative before either platform starts its TUI", () => {
    for (const [startName, endName] of [
      ["async function startWindowsCodexCopresence(", "async function startCopresenceOrchestration("],
      ["async function startCopresenceOrchestration(", "async function startOpencodeCopresenceOrchestration("],
    ]) {
      const body = cli.slice(cli.indexOf(startName), cli.indexOf(endName, cli.indexOf(startName)));
      const migration = body.indexOf("migrateCodexPendingThread(");
      const exactReceipt = body.indexOf("bridgeClientHealthReceipt(wsUrl, pendingRecoveryId)", migration);
      const promotion = body.indexOf("requirePromotedCodexPendingThread(", exactReceipt);
      const tuiArgs = body.indexOf("codexTuiLaunchArgs(", promotion);
      expect(migration).toBeGreaterThan(0);
      expect(exactReceipt).toBeGreaterThan(migration);
      expect(promotion).toBeGreaterThan(exactReceipt);
      expect(tuiArgs).toBeGreaterThan(promotion);
      expect(body.slice(migration, tuiArgs)).not.toContain('request("thread/start"');
    }
  });
});
