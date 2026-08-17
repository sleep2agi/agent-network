// #909 — `claude-code-cli` is provisioned by the anet launcher (it installs @anthropic-ai/claude-code
// and requires `claude` in PATH), but agent-node has no execution lane for it. The launcher's
// `assertStartCompatibility` guard exists precisely to stop an unsupported agent-node from silently
// selecting another runtime — yet its early-return `if (runtime !== "codex-sdk" && !== "claude-agent-sdk")`
// skipped the one provisioned runtime that most needed it (grok-build-cli and opencode-cli were covered).
//
// 🔴 The judge here is the one thing that makes this test worth writing: agent-node ALSO fails on this
// runtime (its own #909 branch), so "start failed" is true whether or not the LAUNCHER caught it. This
// test must prove the refusal happened AT THE LAUNCHER, BEFORE agent-node was spawned — not that
// something downstream died. The distinguisher is the wording that is unique to each layer:
//   launcher  (bin/cli.ts, assertStartCompatibility):  "…provisioned HERE (Claude Code CLI…"
//   agent-node (src/cli.ts):                           "…provisioned BY `anet`…" / "Unsupported runtime"
// If the launcher branch is removed, the early-return lets launchAgent spawn agent-node, and the output
// flips to agent-node's wording — which these assertions catch.
//
// Behavioral (spawns the real launcher with a real profile), matching the failure the user hit: install
// the CLI, log in, `anet node start`, and only then get told — in typo-shaped words — the runtime is bad.

import { describe, expect, test } from "bun:test";
import { spawn } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI = join(import.meta.dir, "..", "bin", "cli.ts");

function runStart(runtime: string, timeoutMs = 30_000): Promise<{ out: string; code: number | null }> {
  const sb = mkdtempSync(join(tmpdir(), "anet-909L-"));
  const home = mkdtempSync(join(tmpdir(), "anet-909L-home-"));
  const nodeDir = join(sb, ".anet", "nodes", "p909launcher");
  mkdirSync(nodeDir, { recursive: true });
  // nodesDir() = <cwd>/.anet/nodes — a minimal profile is enough to reach assertStartCompatibility.
  writeFileSync(
    join(nodeDir, "config.json"),
    JSON.stringify({ node_id: "p909launcher", alias: "p909launcher", runtime, hub: "http://127.0.0.1:9" }),
  );
  return new Promise((resolve) => {
    const child = spawn("bun", [CLI, "node", "start", "p909launcher"], {
      cwd: sb,
      env: { PATH: process.env.PATH ?? "", HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      try { child.kill("SIGKILL"); } catch { /* gone */ }
      rmSync(sb, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      resolve({ out, code });
    };
    const t = setTimeout(() => finish(null), timeoutMs);
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { out += String(d); });
    child.on("exit", (c) => finish(c));
    child.on("error", () => finish(null));
  });
}

describe("#909 claude-code-cli is refused AT THE LAUNCHER, before agent-node is spawned", () => {
  test("🔴🔴 refusal is the launcher's (provisioned HERE), and agent-node is never reached", async () => {
    const r = await runStart("claude-code-cli");
    expect(r.code).not.toBe(0);
    // The refusal is the launcher's own #909 branch…
    expect(r.out).toContain("#909");
    expect(r.out).toContain("provisioned here"); // unique to bin/cli.ts's assertStartCompatibility branch
    // …and agent-node was NOT spawned. 🔴 The robust check is STRUCTURAL, not wording-coupled
    // (通信龙): agent-node prefixes ALL its output with `[<ALIAS>]`; the launcher uses `[anet]` (and
    // names the node only in quotes, `"p909launcher"`). So if agent-node started at all, the bracketed
    // `[p909launcher]` prefix appears. This survives any future rewording of agent-node's messages —
    // notably step 2, when the lane is built and agent-node's #909 wording changes; a negative assertion
    // coupled to that wording would silently go green there while agent-node was in fact spawned.
    expect(r.out).not.toContain("[p909launcher]");
    // belt: agent-node's generic typo error is stable-shaped, so keep it too.
    expect(r.out).not.toContain(`Unsupported runtime "claude-code-cli"`);
  }, 45_000);
});
