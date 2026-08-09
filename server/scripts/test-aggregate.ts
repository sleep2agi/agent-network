#!/usr/bin/env bun
// #434 canonical server test runner.
// Every test file gets a fresh process because server tests mutate process.env,
// cwd-sensitive child commands, and module-singleton database state.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

type Counts = { pass: number; fail: number; skip: number; expects: number };
type Result = Counts & {
  file: string;
  dbPath: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  wallMs: number;
};

const REPO_ROOT = resolve(import.meta.dir, "../..");
const SERVER_SRC = join(REPO_ROOT, "server", "src");
const DEFAULT_TIMEOUT_MS = 90_000;
const ALLOWED_PARENT_ENV = [
  "PATH", "TERM", "LANG", "LC_ALL", "LC_CTYPE", "CI", "GITHUB_ACTIONS",
  "SHELL", "USER", "LOGNAME", "SYSTEMROOT", "WINDIR",
] as const;

function parseArgs(argv: string[]) {
  let reverse = false;
  let verbose = false;
  const selectedFiles: string[] = [];
  let timeoutMs = Number(process.env.ANET_SERVER_TEST_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  for (const arg of argv) {
    if (arg === "--reverse") reverse = true;
    else if (arg === "--verbose" || arg === "-v") verbose = true;
    else if (arg.startsWith("--file=")) selectedFiles.push(arg.slice(7));
    else if (arg.startsWith("--timeout-ms=")) timeoutMs = Number(arg.slice(13));
    else if (arg === "--help" || arg === "-h") {
      console.log("usage: bun run test [--reverse] [--verbose] [--file=server/src/x.test.ts] [--timeout-ms=N]");
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100) throw new Error("timeout must be at least 100ms");
  return { reverse, verbose, selectedFiles, timeoutMs };
}

function collectTests(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile() && name.endsWith(".test.ts")) found.push(relative(REPO_ROOT, full));
    }
  };
  walk(dir);
  if (found.length === 0) throw new Error(`no test files found under ${dir}`);
  return found;
}

function slugFor(file: string): string {
  return file.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
}

function parseCounts(output: string): Counts {
  const last = (pattern: RegExp) => {
    const matches = [...output.matchAll(pattern)];
    return matches.length ? Number(matches.at(-1)![1]) : 0;
  };
  return {
    pass: last(/^\s*(\d+)\s+pass\s*$/gm),
    fail: last(/^\s*(\d+)\s+fail\s*$/gm),
    skip: last(/^\s*(\d+)\s+skip\s*$/gm),
    expects: last(/^\s*(\d+)\s+expect\(\) calls\s*$/gm),
  };
}

function childEnv(dbPath: string, suiteRoot: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ALLOWED_PARENT_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.NODE_ENV = "test";
  env.DATABASE_URL = "";
  env.COMMHUB_DB = dbPath;
  env.COMMHUB_UPLOADS_DIR = join(suiteRoot, "uploads");
  env.HOME = join(suiteRoot, "home");
  env.TMPDIR = join(suiteRoot, "tmp");
  return env;
}

function terminateTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch {}
  }
}

let activeChild: ChildProcessWithoutNullStreams | null = null;
let interruptedBy: NodeJS.Signals | null = null;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    interruptedBy = signal;
    if (activeChild) terminateTree(activeChild, signal);
  });
}

async function runFile(file: string, runRoot: string, timeoutMs: number, verbose: boolean): Promise<Result> {
  const suiteRoot = join(runRoot, slugFor(file));
  const dbPath = join(suiteRoot, "commhub.db");
  for (const dir of [join(suiteRoot, "home"), join(suiteRoot, "tmp"), join(suiteRoot, "uploads")]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  console.log(`TEST_DB_MAP\t${file}\t${dbPath}`);

  const started = Date.now();
  const child = spawn("bun", ["test", file], {
    cwd: REPO_ROOT,
    env: childEnv(dbPath, suiteRoot),
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  activeChild = child;
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    const text = String(chunk);
    stdout += text;
    if (verbose) process.stdout.write(text);
  });
  child.stderr.on("data", (chunk) => {
    const text = String(chunk);
    stderr += text;
    if (verbose) process.stderr.write(text);
  });

  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = setTimeout(() => {
    timedOut = true;
    terminateTree(child, "SIGTERM");
    killTimer = setTimeout(() => terminateTree(child, "SIGKILL"), 2_000);
  }, timeoutMs);
  const exited = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
    child.once("exit", (code, signal) => done({ code, signal }));
    child.once("error", () => done({ code: null, signal: null }));
  });
  clearTimeout(timeout);
  if (killTimer) clearTimeout(killTimer);
  activeChild = null;

  const output = `${stdout}\n${stderr}`;
  const counts = parseCounts(output);
  const validSummary = counts.pass + counts.fail + counts.skip > 0;
  const ok = exited.code === 0 && !exited.signal && !timedOut && validSummary;
  if (!ok) {
    const tail = output.split("\n").slice(-60).join("\n");
    console.error(`\nFAIL_SUITE ${file} exit=${exited.code} signal=${exited.signal} timeout=${timedOut}\n${tail}`);
  }
  console.log(`TEST_FILE_RESULT\t${file}\tpass=${counts.pass}\tfail=${counts.fail}\tskip=${counts.skip}\texpects=${counts.expects}\texit=${exited.code}\tsignal=${exited.signal ?? "none"}\ttimeout=${timedOut}`);
  return { file, dbPath, ...counts, exitCode: exited.code, signal: exited.signal, timedOut, wallMs: Date.now() - started };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let files = collectTests(SERVER_SRC);
  if (args.selectedFiles.length > 0) {
    for (const file of args.selectedFiles) {
      if (!files.includes(file)) throw new Error(`--file is not an enumerated server test: ${file}`);
    }
    files = [...new Set(args.selectedFiles)];
  }
  if (args.reverse) files.reverse();

  const explicitRoot = process.env.ANET_SERVER_TEST_ROOT;
  const runRoot = explicitRoot ? resolve(explicitRoot) : mkdtempSync(join(tmpdir(), "anet-server-tests-"));
  if (explicitRoot) mkdirSync(runRoot, { recursive: false, mode: 0o700 });
  const keep = process.env.ANET_SERVER_TEST_KEEP_ROOT === "1";
  const results: Result[] = [];
  try {
    for (const file of files) {
      if (interruptedBy) break;
      results.push(await runFile(file, runRoot, args.timeoutMs, args.verbose));
    }
  } finally {
    if (!keep) rmSync(runRoot, { recursive: true, force: true });
  }

  const totals = results.reduce((sum, item) => ({
    pass: sum.pass + item.pass,
    fail: sum.fail + item.fail,
    skip: sum.skip + item.skip,
    expects: sum.expects + item.expects,
  }), { pass: 0, fail: 0, skip: 0, expects: 0 });
  const bad = interruptedBy !== null || results.length !== files.length || results.some((item) =>
    item.exitCode !== 0 || item.signal !== null || item.timedOut || item.pass + item.fail + item.skip === 0
  );
  const summary = { files: results.length, order: args.reverse ? "reverse" : "normal", ...totals, bad, root: keep ? runRoot : null };
  console.log(`SERVER_AGGREGATE_RESULT ${JSON.stringify(summary)}`);
  if (interruptedBy) process.exit(interruptedBy === "SIGINT" ? 130 : 143);
  process.exit(bad ? 1 : 0);
}

main().catch((error) => {
  console.error(`SERVER_AGGREGATE_CRASH ${error instanceof Error ? error.stack || error.message : String(error)}`);
  if (activeChild) terminateTree(activeChild, "SIGKILL");
  process.exit(2);
});
