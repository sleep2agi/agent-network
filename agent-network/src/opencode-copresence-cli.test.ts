import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const cli = readFileSync(join(import.meta.dir, "..", "bin", "cli.ts"), "utf8");

function functionBody(name: string): string {
  const start = cli.indexOf(`async function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const rest = cli.slice(start + 1);
  const end = rest.search(/\n(?:export )?(?:async )?function /);
  return end < 0 ? rest : rest.slice(0, end);
}

describe("OpenCode co-presence CLI wiring", () => {
  const body = functionBody("startOpencodeCopresenceOrchestration");

  test("persists copresence mode before launching the bridge", () => {
    const save = body.indexOf('opencodeMode: "copresence"');
    const bridge = body.indexOf('"new-session"');
    expect(save).toBeGreaterThan(-1);
    expect(bridge).toBeGreaterThan(save);
  });

  test("checks exact OpenCode dependencies before mutating profile or starting tmux", () => {
    const compatibility = body.indexOf('assertStartCompatibility("opencode-cli")');
    const save = body.indexOf('opencodeMode: "copresence"');
    const bridge = body.indexOf('"new-session"');
    expect(compatibility).toBeGreaterThan(-1);
    expect(save).toBeGreaterThan(compatibility);
    expect(bridge).toBeGreaterThan(compatibility);
  });

  test("starts only exact alias and alias-bridge tmux sessions", () => {
    expect(body).toContain("const bridgeSession = `${displayName}-桥`");
    expect(body).toContain("const tuiSession = displayName");
    expect(body).not.toContain("pkill");
    expect(body).not.toContain("killall");
  });

  test("does not depend on a long-lived tmux server's stale launcher environment", () => {
    expect(body).toContain('export PATH=${shellQuote(process.env.PATH ?? "")}');
    expect(body).toContain("export ANET_AGENT_NODE_BIN=");
    expect(body).toContain("export ANET_OPENCODE_SAFE_BASE=");
  });

  test("waits for the owner-only runtime launcher before starting the official TUI", () => {
    const wait = body.indexOf("while (!existsSync(attachScript)");
    const tuiSpawn = body.lastIndexOf('"new-session"');
    expect(wait).toBeGreaterThan(-1);
    expect(tuiSpawn).toBeGreaterThan(wait);
    expect(body).toContain("exec ${shellQuote(attachScript)}");
  });

  test("launcher timeout reports enough bridge context to debug one-command startup", () => {
    const timeout = body.indexOf("OpenCode copresence server did not produce its attach launcher within 30s.");
    expect(timeout).toBeGreaterThan(-1);
    const timeoutBody = body.slice(timeout, timeout + 900);
    expect(timeoutBody).toContain("expected launcher:");
    expect(timeoutBody).toContain("bridge log:");
    expect(timeoutBody).toContain("bridge tmux session:");
    expect(timeoutBody).toContain("Recheck foreground: anet node start");
    expect(timeoutBody).toContain("bridge pane tail:");
    expect(timeoutBody).toContain("bridge pane tail unavailable");
  });

  test("persists bridge output so exited tmux panes still leave diagnostics", () => {
    const logPath = body.indexOf('const bridgeLog = join(nodesDir(), resolved.id, "opencode-copresence-bridge.log")');
    const spawn = body.indexOf('"new-session"', logPath);
    const readFallback = body.indexOf("readFileSync(bridgeLog", spawn);
    expect(logPath).toBeGreaterThan(-1);
    expect(body.slice(logPath, spawn)).toContain("rmSync(bridgeLog, { force: true })");
    expect(body.slice(spawn - 400, spawn + 300)).toContain(">> ${shellQuote(bridgeLog)} 2>&1");
    expect(readFallback).toBeGreaterThan(spawn);
  });

  test("the generic --copresence dispatcher selects OpenCode by stored runtime", () => {
    const dispatch = cli.indexOf('if (copresenceRuntime === "opencode-cli")');
    expect(dispatch).toBeGreaterThan(-1);
    expect(cli.slice(dispatch, dispatch + 240)).toContain("startOpencodeCopresenceOrchestration(id, opts.hub)");
  });

  test("operator help names the create, attach, and stop commands", () => {
    expect(cli).toContain("anet node create <name> --runtime opencode-cli --mode copresence");
    expect(cli).toContain("tmux attach -t '=<name>'");
    expect(cli).toContain("anet node stop <name>");
  });

  test("prints an exact tmux target so an exited TUI cannot prefix-match the bridge", () => {
    expect(body).toContain("tmux attach -t ${shellQuote(`=${displayName}`)}");
    expect(body).not.toContain("tmux attach -t ${shellQuote(displayName)}");
  });
});
