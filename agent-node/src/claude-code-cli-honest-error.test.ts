// #909 — `--runtime claude-code-cli` is provisioned by `anet` (it installs @anthropic-ai/claude-code
// and requires `claude` in PATH), but agent-node has NO execution lane for it. Before this fix it hit
// the generic "Unsupported runtime" — BYTE-IDENTICAL to a typo — so a user who ran `anet` all the way
// through install+login was told, in the same words as a misspelling, that their runtime was unknown.
//
// The judge here is NOT "did it fail?" (it failed before and after — no lane either way). The judge is
// "does agent-node distinguish this KNOWN, provisioned-but-unimplemented runtime from an UNKNOWN typo?"
// So the load-bearing assertion is that the two stderrs are NOT equal, plus a positive control that a
// real runtime trips neither branch (otherwise a "report unimplemented for everything" impl would also
// make the not-equal assertion pass while breaking real starts).
//
// Drives the REAL CLI entrypoint (spawned `src/cli.ts`), mirroring #491's harness — a helper-level test
// would not prove the user-visible output actually differs.

import { describe, expect, test } from "bun:test";
import { spawn } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI = join(import.meta.dir, "cli.ts");
const DEAD_HUB = "http://127.0.0.1:9"; // nothing listens; a valid runtime fails harmlessly AFTER the banner

interface RunResult { stdout: string; stderr: string; code: number | null }

function runCli(args: string[], timeoutMs = 15_000): Promise<RunResult> {
  const sandbox = mkdtempSync(join(tmpdir(), "anet-909-"));
  const home = mkdtempSync(join(tmpdir(), "anet-909-home-"));
  return new Promise<RunResult>((resolve) => {
    const child = spawn("bun", [CLI, ...args], {
      cwd: sandbox,
      env: { PATH: process.env.PATH ?? "", HOME: home, COMMHUB_URL: DEAD_HUB, RUNTIME: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill("SIGKILL"); } catch { /* gone */ }
      rmSync(sandbox, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      resolve({ stdout, stderr, code });
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.stdout.on("data", (d) => { stdout += String(d); if (/\n\s*hub:/.test(stdout)) finish(null); });
    child.stderr.on("data", (d) => { stderr += String(d); });
    child.on("exit", (code) => finish(code));
    child.on("error", () => finish(null));
  });
}

describe("#909 claude-code-cli reports a KNOWN gap, not a typo", () => {
  test("🔴🔴 claude-code-cli and a typo get DIFFERENT treatment, not the same template with a name swap", async () => {
    const known = await runCli(["--alias", "p909", "--runtime", "claude-code-cli"]);
    const bogus = await runCli(["--alias", "p909", "--runtime", "bogus-xyz-not-a-runtime"]);
    // Both fail closed…
    expect(known.code).not.toBe(0);
    expect(bogus.code).not.toBe(0);
    // …but comparing the raw stderrs is too weak: the generic error ECHOES the runtime name, so
    // `Unsupported runtime "claude-code-cli"` vs `…"bogus-xyz…"` already differ by the name alone —
    // that "difference" existed WITH the bug. #909 is about TREATMENT: a documented, provisioned
    // runtime must not get the same TEMPLATE as a typo. So normalize the echoed name out, then assert
    // the templates still differ. Pre-fix both normalize to the identical "Unsupported runtime <R>…"
    // line → this assertion fails (catches the bug); post-fix claude-code-cli is the distinct #909
    // message → they differ.
    const norm = (s: string, name: string) => s.split(name).join("<RUNTIME>");
    expect(norm(known.stderr, "claude-code-cli")).not.toBe(norm(bogus.stderr, "bogus-xyz-not-a-runtime"));
  }, 30_000);

  test("claude-code-cli names the gap (#909, not-a-typo) and points at a working runtime", async () => {
    const r = await runCli(["--alias", "p909", "--runtime", "claude-code-cli"]);
    const out = r.stdout + r.stderr;
    expect(out).toContain("#909");
    expect(out).toMatch(/not yet implemented|known gap|not a typo/);
    expect(out).toContain("claude-agent-sdk"); // tells the user what to use now
    // It must NOT masquerade as the generic unknown-runtime error.
    expect(out).not.toContain(`Unsupported runtime "claude-code-cli"`);
  }, 30_000);

  test("a genuinely unknown runtime still gets the generic 'Unsupported runtime' error", async () => {
    const r = await runCli(["--alias", "p909", "--runtime", "bogus-xyz-not-a-runtime"]);
    const out = r.stdout + r.stderr;
    expect(out).toContain("Unsupported runtime");
    expect(out).toContain("bogus-xyz-not-a-runtime");
    expect(out).not.toContain("#909"); // the typo path must not claim to be a known gap
  }, 30_000);

  test("🔴 positive control: a real runtime trips NEITHER branch (the honest error must not over-fire)", async () => {
    // Without this, an impl that reported "unimplemented" for every runtime would make the
    // not-equal assertion above pass while breaking real starts.
    const r = await runCli(["--alias", "p909", "--runtime", "claude-agent-sdk"]);
    const out = r.stdout + r.stderr;
    expect(out).not.toContain("#909");
    expect(out).not.toContain("Unsupported runtime");
  }, 30_000);
});
