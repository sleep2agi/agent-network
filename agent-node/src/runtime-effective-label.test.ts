// #491 — the startup banner must report the runtime that is ACTUALLY in
// effect, and an unknown runtime must fail closed.
//
// Both assertions drive the REAL CLI entrypoint (spawned `src/cli.ts`),
// not a helper: the reported bug was that the banner echoed the user's
// input verbatim while a different implementation bucket was running, so
// a helper-level test would not have caught it.
//
// Isolation: every spawn runs in a fresh empty cwd with a fake HOME and a
// hub URL pointing at a closed loopback port, so no real `.anet/nodes`
// profile is read and no live hub is contacted.

import { describe, expect, test } from "bun:test";
import { spawn } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI = join(import.meta.dir, "cli.ts");
/** Loopback port nothing listens on — the node's connect attempt fails
 *  harmlessly AFTER the startup banner has already been printed. */
const DEAD_HUB = "http://127.0.0.1:9";

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * Spawn the real CLI in isolation and collect output until either the
 * process exits or the banner is complete (whichever comes first).
 */
function runCli(args: string[], timeoutMs = 15_000): Promise<RunResult> {
  const sandbox = mkdtempSync(join(tmpdir(), "anet-491-"));
  const home = mkdtempSync(join(tmpdir(), "anet-491-home-"));
  return new Promise<RunResult>((resolve) => {
    const child = spawn("bun", [CLI, ...args], {
      cwd: sandbox,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        COMMHUB_URL: DEAD_HUB,
        // Keep the environment from contributing a runtime of its own.
        RUNTIME: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      rmSync(sandbox, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      resolve({ stdout, stderr, code });
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += String(d);
      // The banner ends with the `hub:` line; once seen we have all we
      // need and can stop the reconnect loop early.
      if (/\n\s*hub:/.test(stdout)) finish(null);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("exit", (code) => finish(code));
    child.on("error", () => finish(null));
  });
}

/** The `runtime:` line of the startup banner, without the log prefix. */
function bannerRuntimeLine(stdout: string): string | null {
  const m = stdout.match(/^.*\bruntime:\s*(.+)$/m);
  return m ? m[1].trim() : null;
}

/** The `model:` line of the startup banner, without the log prefix. */
function bannerModelLine(stdout: string): string | null {
  const m = stdout.match(/^.*\bmodel:\s*(.+)$/m);
  return m ? m[1].trim() : null;
}

describe("#491 startup banner reports the EFFECTIVE runtime", () => {
  test("alias input 'codex-tui' → banner names the effective runtime (codex-app-server), not just the raw input", async () => {
    const r = await runCli(["--alias", "p491-node", "--runtime", "codex-tui"]);
    const line = bannerRuntimeLine(r.stdout);
    expect(line).not.toBeNull();
    // The whole point of the bug: the operator must be able to tell WHICH
    // implementation is running. Echoing only the alias hides it.
    expect(line!).toContain("codex-app-server");
  }, 30_000);

  test("canonical input stays readable (no regression for the common case)", async () => {
    const r = await runCli(["--alias", "p491-node", "--runtime", "claude-agent-sdk"]);
    const line = bannerRuntimeLine(r.stdout);
    expect(line).not.toBeNull();
    expect(line!).toContain("claude-agent-sdk");
  }, 30_000);
});

describe("#491 regression lock — unknown runtime fails closed", () => {
  // NOTE: this behaviour already exists on main (added before this issue);
  // the lock exists so it cannot silently regress back to the
  // `RUNTIME_MAP[raw] || "claude"` fallback that shipped in 2.4.13.
  test("unknown runtime → non-zero exit, error names the value AND the supported list", async () => {
    const r = await runCli(["--alias", "p491-node", "--runtime", "totally-bogus-runtime"]);
    const out = r.stdout + r.stderr;
    expect(r.code).not.toBe(0);
    expect(out).toContain("totally-bogus-runtime");
    // Supported list is generated from the live RUNTIME_MAP, so assert on
    // entries that must be present in ANY version that has the map.
    expect(out).toMatch(/claude-agent-sdk/);
    expect(out).toMatch(/codex-sdk/);
    // …and it must NOT have silently started as claude.
    expect(bannerRuntimeLine(r.stdout) ?? "").not.toContain("claude-agent-sdk");
  }, 30_000);
});

describe("#553 Grok startup banner reports model ownership truthfully", () => {
  test("unset model on Grok ACP names the Grok CLI as owner, not the runtime alias as a model id", async () => {
    const r = await runCli(["--alias", "p553-node", "--runtime", "grok-build-acp"]);
    const line = bannerModelLine(r.stdout);
    expect(line).toBe("configured by Grok CLI");
    expect(line).not.toContain("grok-build");
  }, 30_000);

  test("unset model on Grok CLI uses the same non-versioned ownership statement", async () => {
    const r = await runCli(["--alias", "p553-node", "--runtime", "grok-build-cli"]);
    const line = bannerModelLine(r.stdout);
    expect(line).toBe("configured by Grok CLI");
    expect(line).not.toContain("grok-build");
  }, 30_000);

  test("an explicit Grok model is still reported exactly", async () => {
    const r = await runCli(["--alias", "p553-node", "--runtime", "grok-build-acp", "--model", "grok-4.5"]);
    expect(bannerModelLine(r.stdout)).toBe("grok-4.5");
  }, 30_000);
});
