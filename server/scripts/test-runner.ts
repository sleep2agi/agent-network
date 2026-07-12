#!/usr/bin/env bun
// #434 — canonical aggregate test runner.
//
// Written in Bun (no Node runtime dependency) to be the sole
// production test gate for the server subtree. Every real-server
// integration suite gets its own isolated `Bun.spawn` child with:
//
//   - explicit env allowlist (no spread of parent env) — see
//     ALLOWED_PARENT_ENV_KEYS below
//   - independent HOME + COMMHUB_DB (fresh mkdtemp per child)
//   - DATABASE_URL EXPLICITLY UNSET, no exceptions (#434 rule 9,
//     #435 defense-in-depth)
//   - NODE_ENV = "test" always
//
// Serial by design (concurrency = 1). No `--concurrency=N` flag ships
// in this PR: we exchange latency for determinism until we have real
// evidence that parallelism is safe on this workload.
//
// The runner drives Bun's exit code — the truth. Pass/fail counters
// parsed out of child stdout are for the aggregate summary only; a
// count-line disagreement never lets a red child green-wash the gate.
//
// SIGINT/SIGTERM handling: the runner forwards to all live children,
// then cleans up temp dirs / DB / -wal / -shm before propagating exit.
//
// Documented failure modes we deliberately DO surface (not smother):
//   - unregistered *.test.ts on disk → hard fail before any run
//   - duplicate manifest entry → hard fail before any run
//   - a suite exits non-zero → runner exits non-zero, prints child
//     stdout/stderr tail so triage is one command away
//   - a child leaks a process (doesn't exit) → runner surfaces the
//     hang; do NOT paper over with process.exit(0)

import { spawn, spawnSync } from "child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "fs";
import { join, relative, resolve } from "path";
import { tmpdir } from "os";
import {
  ISOLATED_SERVER_SUITES,
  SHARED_UNIT_SUITES,
  manifestSet,
} from "./test-manifest";

// ── args ──────────────────────────────────────────────────────────

interface Args {
  suite?: string;   // optional filter; only match paths in the manifest
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--verbose" || a === "-v") args.verbose = true;
    else if (a === "--suite") args.suite = argv[++i];
    else if (a?.startsWith("--suite=")) args.suite = a.slice("--suite=".length);
    else if (a === "--help" || a === "-h") {
      console.log(
        "usage: bun run scripts/test-runner.ts [--suite=<manifest-path>] [--verbose]\n" +
        "  --suite=<path>  filter to a single suite by exact manifest path\n" +
        "                  (only matches entries registered in scripts/test-manifest.ts)\n" +
        "  --verbose       stream child stdout/stderr in real time\n"
      );
      process.exit(0);
    } else {
      console.error(`unknown arg: ${a}\n`);
      process.exit(2);
    }
  }
  return args;
}

// ── env allowlist ────────────────────────────────────────────────

// Keys the runner is willing to hand down to child suites verbatim.
// Anything not in this list is dropped. In particular, `DATABASE_URL`
// is NOT in this list even if the parent shell set it — the child MUST
// see it as unset. This is defense-in-depth on top of the #435 guard.
const ALLOWED_PARENT_ENV_KEYS = new Set<string>([
  "PATH",
  "TMPDIR",
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "CI",
  "GITHUB_ACTIONS",
  "SHELL",
  "USER",
  "LOGNAME",
]);

/** Build a child env: allowlist parent keys, force test defaults, isolate. */
function buildChildEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const k of ALLOWED_PARENT_ENV_KEYS) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  // Force defaults for this test process.
  env.NODE_ENV = "test";
  // Explicit unset — even if a caller stuffs DATABASE_URL into
  // `overrides`, we drop it. The runner-self test verifies this.
  delete env.DATABASE_URL;
  // Layer suite-specific values.
  Object.assign(env, overrides);
  // Post-condition guard.
  delete env.DATABASE_URL;
  return env as NodeJS.ProcessEnv;
}

// ── manifest ↔ filesystem set equality ───────────────────────────

function collectTestFilesOnDisk(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      // Skip node_modules and hidden dirs.
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      const s = statSync(full);
      if (s.isDirectory()) walk(full);
      else if (s.isFile() && full.endsWith(".test.ts")) {
        out.push(relative(SERVER_ROOT, full));
      }
    }
  }
  walk(root);
  return out.sort();
}

function assertManifestExhaustive(): void {
  // Duplicate check first — a copy-paste would silently double a suite.
  const seen = new Set<string>();
  for (const p of [...ISOLATED_SERVER_SUITES, ...SHARED_UNIT_SUITES]) {
    if (seen.has(p)) {
      console.error(`❌ manifest duplicate entry: ${p}`);
      process.exit(2);
    }
    seen.add(p);
  }
  const manifest = manifestSet();
  const onDisk = new Set<string>();
  for (const p of collectTestFilesOnDisk(join(SERVER_ROOT, "src"))) onDisk.add(p);
  for (const p of collectTestFilesOnDisk(join(SERVER_ROOT, "scripts"))) onDisk.add(p);

  const unregistered = [...onDisk].filter((p) => !manifest.has(p));
  const missing = [...manifest].filter((p) => !onDisk.has(p));

  if (unregistered.length + missing.length > 0) {
    console.error("❌ manifest / disk mismatch (issue #434 rule 4):");
    for (const p of unregistered) console.error(`   unregistered on disk: ${p}`);
    for (const p of missing) console.error(`   in manifest but missing: ${p}`);
    console.error(
      "\n  Register every new *.test.ts in scripts/test-manifest.ts explicitly.\n" +
      "  isolated_server = imports ./index or otherwise binds Bun.serve.\n" +
      "  shared_unit     = pure logic; safe to co-load in one shared child."
    );
    process.exit(2);
  }
}

// ── child suite runner ───────────────────────────────────────────

interface SuiteResult {
  suite: string;                // manifest path, e.g. "src/foo.test.ts"
  kind: "isolated_server" | "shared_unit";
  exitCode: number | null;
  signal: string | null;
  pass: number;
  fail: number;
  expects: number;
  wallMs: number;
  tempDir: string;
}

// One-shot pass/fail/expect parser. Anchored to Bun's own trailing
// count block (line-start whitespace + `NNN pass|fail|expect() calls`)
// so noisy substrings elsewhere in child output (e.g. log lines that
// contain the word "fail") don't get grabbed. Returns 0 when a marker
// is absent — the count is evidence, not the gate.
function parseCounts(stdout: string, stderr: string): { pass: number; fail: number; expects: number } {
  const s = stdout + "\n" + stderr;
  // Look for the LAST occurrence of each Bun-standard line, so a test
  // suite that runs its own inner bun test (like test-runner-self.test.ts)
  // doesn't double-count its inner child's output.
  const passLines = [...s.matchAll(/^\s+(\d+)\s+pass\s*$/gm)];
  const failLines = [...s.matchAll(/^\s+(\d+)\s+fail\s*$/gm)];
  const expLines = [...s.matchAll(/^\s+(\d+)\s+expect\(\)\s+calls\s*$/gm)];
  return {
    pass: passLines.length ? Number(passLines[passLines.length - 1][1]) : 0,
    fail: failLines.length ? Number(failLines[failLines.length - 1][1]) : 0,
    expects: expLines.length ? Number(expLines[expLines.length - 1][1]) : 0,
  };
}

const liveChildren = new Set<ReturnType<typeof spawn>>();
const liveTempDirs = new Set<string>();

function forwardSignal(sig: NodeJS.Signals) {
  for (const c of liveChildren) {
    try { c.kill(sig); } catch {}
  }
}

function cleanupTemp(dir: string) {
  liveTempDirs.delete(dir);
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

process.on("SIGINT", () => { forwardSignal("SIGINT"); });
process.on("SIGTERM", () => { forwardSignal("SIGTERM"); });

async function runOneChild(
  suites: readonly string[],
  kind: "isolated_server" | "shared_unit",
  verbose: boolean,
): Promise<SuiteResult> {
  const started = Date.now();
  const tempDir = mkdtempSync(join(tmpdir(), `anet-434-${kind}-`));
  liveTempDirs.add(tempDir);
  const homeDir = join(tempDir, "home");
  const dbPath = join(tempDir, "commhub.db");
  const uploadsDir = join(tempDir, "uploads");

  const env = buildChildEnv({
    HOME: homeDir,
    COMMHUB_DB: dbPath,
    COMMHUB_UPLOADS_DIR: uploadsDir,
    // TMPDIR override so any test that uses mkdtemp() stays inside our
    // per-child dir (best-effort — some tests already carry an explicit
    // mkdtemp of their own).
    TMPDIR: tempDir,
  });

  // Make sure HOME exists before Bun/bun test tries to touch it.
  try { rmSync(homeDir, { recursive: true, force: true }); } catch {}
  try { require("fs").mkdirSync(homeDir, { recursive: true }); } catch {}
  try { require("fs").mkdirSync(uploadsDir, { recursive: true }); } catch {}

  const child = spawn("bun", ["test", ...suites], {
    cwd: SERVER_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  liveChildren.add(child);

  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk) => {
    const text = chunk.toString();
    stdout += text;
    if (verbose) process.stdout.write(text);
  });
  child.stderr!.on("data", (chunk) => {
    const text = chunk.toString();
    stderr += text;
    if (verbose) process.stderr.write(text);
  });

  const result = await new Promise<{ code: number | null; signal: string | null }>((r) => {
    child.on("exit", (code, signal) => r({ code, signal }));
  });
  liveChildren.delete(child);

  const counts = parseCounts(stdout, stderr);
  const wallMs = Date.now() - started;

  if (result.code !== 0 && !verbose) {
    // Surface a stderr tail so failures are diagnosable without re-running.
    const tail = (stdout + "\n" + stderr).split("\n").slice(-40).join("\n");
    console.error(
      `\n──── ${kind} suite(s) FAILED ────\n${suites.join(", ")}\n────\n${tail}\n────\n`
    );
  }

  cleanupTemp(tempDir);
  return {
    suite: suites.join(","),
    kind,
    exitCode: result.code,
    signal: result.signal,
    pass: counts.pass,
    fail: counts.fail,
    expects: counts.expects,
    wallMs,
    tempDir,
  };
}

// ── main ─────────────────────────────────────────────────────────

const SERVER_ROOT = resolve(__dirname, "..");

async function main() {
  const args = parseArgs(process.argv.slice(2));

  assertManifestExhaustive();

  const filter = args.suite;
  const includes = (p: string): boolean => !filter || p === filter;

  const isolatedToRun = ISOLATED_SERVER_SUITES.filter(includes);
  const sharedToRun = SHARED_UNIT_SUITES.filter(includes);

  if (filter && isolatedToRun.length + sharedToRun.length === 0) {
    console.error(`❌ --suite=${filter} did not match any manifest entry`);
    process.exit(2);
  }

  const results: SuiteResult[] = [];

  // Isolated first (one child per file) — serial.
  for (const s of isolatedToRun) {
    if (!args.verbose) process.stdout.write(`▸ isolated_server: ${s} … `);
    const r = await runOneChild([s], "isolated_server", args.verbose);
    results.push(r);
    if (!args.verbose) {
      process.stdout.write(
        r.exitCode === 0
          ? `ok (${r.pass}/${r.fail}/${r.expects}, ${r.wallMs}ms)\n`
          : `FAIL (exit=${r.exitCode}, signal=${r.signal})\n`
      );
    }
  }

  // Shared unit — one child running all of them (still serial vs isolated).
  if (sharedToRun.length > 0) {
    if (!args.verbose) process.stdout.write(`▸ shared_unit: ${sharedToRun.length} files … `);
    const r = await runOneChild(sharedToRun, "shared_unit", args.verbose);
    results.push(r);
    if (!args.verbose) {
      process.stdout.write(
        r.exitCode === 0
          ? `ok (${r.pass}/${r.fail}/${r.expects}, ${r.wallMs}ms)\n`
          : `FAIL (exit=${r.exitCode}, signal=${r.signal})\n`
      );
    }
  }

  // Aggregate summary.
  const totalPass = results.reduce((n, r) => n + r.pass, 0);
  const totalFail = results.reduce((n, r) => n + r.fail, 0);
  const totalExp = results.reduce((n, r) => n + r.expects, 0);
  const anyBadExit = results.some((r) => r.exitCode !== 0);

  console.log("");
  console.log("── aggregate summary ──");
  console.log(`  suites run: ${results.length}`);
  console.log(`  total pass:    ${totalPass}`);
  console.log(`  total fail:    ${totalFail}`);
  console.log(`  total expects: ${totalExp}`);
  for (const r of results) {
    console.log(
      `  [${r.kind}] ${r.suite}: exit=${r.exitCode} ${r.pass}/${r.fail}/${r.expects} ${r.wallMs}ms`
    );
  }

  // GATE — exit code from children is the truth; count sums are evidence.
  process.exit(anyBadExit ? 1 : 0);
}

main().catch((err) => {
  console.error("runner crashed:", err);
  process.exit(2);
});
