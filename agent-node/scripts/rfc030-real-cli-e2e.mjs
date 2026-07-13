// RFC-030 Wave 1A P0.2 Commit 1 corrective round 6 — real codex 0.144.0
// **bootstrap smoke**.
//
// This script is a bootstrap smoke, not a full E2E. Honest scope
// (副指挥 3ed5c004 evidence item #2):
//   - PTY-attaches to codex-cli 0.144.0 and observes the FIRST
//     authorizer call (`account/read`).
//   - Does NOT observe the full four-read startup sequence, does NOT
//     observe normal CLI exit — the harness SIGKILLs after the
//     account/read arrives because we don't ship the full read-set
//     responses in this fake authorizer.
//
// Hard-fail behaviour (副指挥 3ed5c004 evidence item #2):
//   - If codex-cli is missing or version != 0.144.0 → HARD FAIL, non-
//     zero exit. No "PASS: skipped".
//   - If util-linux `script(1)` is missing → HARD FAIL. Codex requires
//     a TTY; without `script(1)` we cannot honestly claim we drove it.
//
// 副指挥 e85ade40 evidence-gate: the child env exact-set assertion
// + mutation-red drive `buildAllowlistEnv` DIRECTLY and pass the
// frozen result to `spawn`. Prior version audited a hand-built
// object while `spawnCodex` built its OWN env — the two could
// diverge silently. Now the child env IS the frozen output of
// `buildAllowlistEnv`; nothing else may be injected. A hostile
// caller adding a foreign key must fail loudly before spawn.
//
// Reproducibility: use
//   RFC030_CODEX_BIN=<path> npm run test:rfc030-real-cli-smoke
// (the npm script runs `bun run build` first and passes the bundle
// path through `RFC030_BUNDLE`). Direct
// `node scripts/rfc030-real-cli-e2e.mjs` requires
// `agent-node/dist/rfc030-integration.mjs` to exist; `dist/` is
// gitignored so a clean checkout fails with ERR_MODULE_NOT_FOUND
// — do not report a raw `node ...` command as the reproducer.
//
// Bundle path resolves RELATIVE to this script — no /tmp hardcoded.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { spawn } from "node:child_process";
import { execSync } from "node:child_process";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const BUNDLE = process.env.RFC030_BUNDLE
  ?? path.resolve(__dirname, "..", "dist", "rfc030-integration.mjs");

const mod = await import(url.pathToFileURL(BUNDLE).href);
const {
  TuiWsServer, TuiBearer, HumanOwnerCoordinator,
  UpstreamRequestMux, ReverseRequestNamespace,
  SecretRedactor, buildAllowlistEnv, TUI_BEARER_ENV_NAME,
} = mod;

const ALLOWED_LOOPBACK = "127.0.0.1";
let passed = 0, failed = 0;
const notes = [];

function ok(name) { passed++; console.log(`  ok  ${name}`); }
function fail(name, why) { failed++; console.log(`  FAIL ${name}: ${why}`); }

// ─────────────────────────────────────────────────────────────────────
// Env detection
// ─────────────────────────────────────────────────────────────────────

// 副指挥 06e92ef7 P1 + e85ade40: absolute REALPATH — resolve
// symlinks so the version check and spawn use the SAME canonical
// path. Exact version match (`= 0.144.0`), NOT prefix.
// Narrowed claim: `realpath` fixes the canonical path; it does NOT
// prove same-inode over time (an unlink+rename between --version
// and spawn could still swap the file). Both operations resolve
// the same captured path; that captured path is used verbatim in
// spawn (no PATH re-lookup).
function resolveCodexBin() {
  if (process.env.RFC030_CODEX_BIN) return path.resolve(process.env.RFC030_CODEX_BIN);
  try {
    return execSync("command -v codex", { encoding: "utf8", shell: "/bin/sh" }).trim();
  } catch { return null; }
}

let CODEX_BIN = null;

function haveCodex() {
  const rawBin = resolveCodexBin();
  if (rawBin === null || rawBin.length === 0) {
    notes.push("codex binary not on PATH");
    return false;
  }
  // Resolve symlinks so `--version` and spawn resolve the SAME
  // canonical path. `realpath` does not prove same-inode-over-time
  // (an unlink+rename between the two syscalls could still swap
  // the file); we only claim canonical-path stability.
  let realBin;
  try {
    realBin = fs.realpathSync(rawBin);
  } catch {
    notes.push(`realpath failed for ${rawBin}`);
    return false;
  }
  try {
    const out = execSync(`${JSON.stringify(realBin)} --version 2>&1`, { encoding: "utf8", shell: "/bin/sh" }).trim();
    // Exact match, not prefix: reject 0.144.0-rc.1 etc.
    if (out !== "codex-cli 0.144.0") {
      notes.push(`resolved realpath=${realBin} but version '${out}' != 'codex-cli 0.144.0' exact`);
      return false;
    }
    CODEX_BIN = realBin;
    notes.push(`using codex binary (realpath): ${realBin}`);
    return true;
  } catch { notes.push(`codex --version failed for realpath=${realBin}`); return false; }
}

function haveScriptPty() {
  try {
    // util-linux `script` -qec (quiet, exec-command); Linux only.
    execSync("script --version 2>&1", { encoding: "utf8" });
    return true;
  } catch { return false; }
}

if (!haveCodex()) {
  console.log("RFC-030 real CLI bootstrap smoke — FAIL: codex-cli 0.144.0 not on PATH");
  for (const n of notes) console.log("  note:", n);
  console.log("");
  console.log("real CLI bootstrap smoke PASS: 0/1 (env missing codex-cli 0.144.0)");
  process.exit(1);
}
if (!haveScriptPty()) {
  console.log("RFC-030 real CLI bootstrap smoke — FAIL: util-linux script(1) not on PATH");
  console.log("");
  console.log("real CLI bootstrap smoke PASS: 0/1 (env missing PTY tool)");
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────

const READ_ALLOWLIST = ["account/read", "hooks/list", "configRequirements/read", "model/list"];

async function startServer() {
  const mux = new UpstreamRequestMux();
  const reverseNs = new ReverseRequestNamespace();
  const diag = {
    entries: [],
    newCorrelationId() { return "cid"; },
    reportInternalError(e) { this.entries.push(e); },
  };
  const coord = new HumanOwnerCoordinator({
    mux, reverseNs, diagnostics: diag, approvalMode: "never",
  });
  const bearer = TuiBearer.mint();
  const plaintext = bearer.takePlaintextForLauncher();
  const authorizerCalls = [];
  const upstream = {
    written: [],
    async writeFrame(f) { this.written.push(f); },
    onFrame(_h) { return () => {}; },
    onClose(_h) { return () => {}; },
    async close() {},
  };
  const server = new TuiWsServer({
    bearer,
    humanOwner: coord,
    authorizer: {
      async authorize(frame) {
        authorizerCalls.push(frame.method);
        return READ_ALLOWLIST.includes(frame.method)
          ? { verdict: "allow" }
          : { verdict: "deny", code: 0, reason: "not-in-allowlist" };
      },
    },
    initProvider: {
      currentSnapshot: () => ({ serverInfo: { name: "codex", version: "0.144.0" }, capabilities: {} }),
    },
    diagnostics: diag,
    upstreamTransport: upstream,
  });
  await server.start();
  return { server, bearer, plaintext, coord, diag, authorizerCalls };
}

/**
 * Spawn codex-cli against our server. Pipes stdout/stderr through a
 * `SecretRedactor` so no raw bearer bytes ever land in a cache or
 * printed diagnostic.
 *
 * If `underPty` is true, invokes via `script -qec ...` to allocate a
 * real PTY (Codex requires stdin be a terminal).
 */
// 副指挥 db0bbe13 evidence P1: PTY chain audit.
//
// Under `script -qec 'CMD' /dev/null`, `script` invokes `sh -c CMD`,
// and `sh` unconditionally exports `PWD=<cwd>` before executing
// `CMD`. That means the REAL child env inherited by Codex under a
// PTY has an extra key `PWD` — the "exact 5-key allowlist" claim
// was FALSE. Minimal repro:
//     env -i PATH=... HOME=... TMPDIR=... CODEX_HOME=... \
//       ANET_CODEX_TUI_BEARER=x script -qec 'env | sort' /dev/null
//   → keys: [ANET_CODEX_TUI_BEARER, CODEX_HOME, HOME, PATH, PWD, TMPDIR]
//     (6 keys — `PWD` was injected by sh.)
//
// Fix (chosen after weighing the trade-offs the coordinator listed):
// prepend `unset PWD; exec ...` inside the shell command so the
// child never sees `PWD` from the shell. Adding `PWD` to the
// allowlist would leak the workspace path into a Codex-visible
// env var, which the fixture doc says we do NOT do.
//
// The reproducer probe below re-runs the SAME PTY chain but swaps
// the codex binary for `env` — parsing the emitted keys proves the
// unset landed. A mutation-red variant that OMITS the unset must
// surface `PWD` and turn red, so a future edit that drops the
// `unset PWD;` prefix loudly breaks the smoke.

function buildPtyShellCommand(unsetPwd, codexBin, codexArgs) {
  const shArgs = codexArgs.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  const prefix = unsetPwd ? "unset PWD; " : "";
  // `exec` so codex replaces the shell — no lingering intermediate sh
  // in the process tree (also means the shell will not later print a
  // prompt into the PTY that could contaminate the captured stream).
  return `${prefix}exec ${JSON.stringify(codexBin)} ${shArgs}`;
}

async function spawnCodex(plaintext, port, underPty) {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "rfc030-codex-home-"));
  // 副指挥 e85ade40 evidence-gate P3: unify the real spawn env with
  // `buildAllowlistEnv`. Prior rounds built two separate objects —
  // the assertion audited one; the child inherited the other. Now
  // the child env IS the frozen output of buildAllowlistEnv, so any
  // divergence between audited-set and actual-child-env is
  // impossible AT THE PARENT LEVEL. The PWD-strip in the shell
  // command layer closes the gap between what the parent passes and
  // what the child actually sees under a PTY.
  const env = buildAllowlistEnv(plaintext, {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: codexHome,
    TMPDIR: os.tmpdir(),
    CODEX_HOME: codexHome,
  });
  const codexArgs = [
    "--remote", `ws://${ALLOWED_LOOPBACK}:${port}`,
    "--remote-auth-token-env", TUI_BEARER_ENV_NAME,
    "-c", "check_for_update_on_startup=false",
  ];
  // Version-checked bin used verbatim in spawn so no PATH re-lookup
  // can slip a different codex in between (副指挥 1b24ae71 P1).
  const codexBin = CODEX_BIN;
  const argv = underPty
    ? ["-qec", buildPtyShellCommand(true, codexBin, codexArgs), "/dev/null"]
    : codexArgs;
  const cmd = underPty ? "script" : codexBin;
  // env is the frozen buildAllowlistEnv output — pass the SAME
  // reference (no spread) so a later mutation can't slip in.
  const child = spawn(cmd, argv, { env, stdio: ["pipe", "pipe", "pipe"] });
  const outRedactor = new SecretRedactor(plaintext, "[REDACTED bearer]");
  const errRedactor = new SecretRedactor(plaintext, "[REDACTED bearer]");
  const outChunks = [];
  const errChunks = [];
  child.stdout.on("data", (c) => outChunks.push(outRedactor.push(c)));
  child.stderr.on("data", (c) => errChunks.push(errRedactor.push(c)));
  const cleanup = () => {
    outChunks.push(outRedactor.finish());
    errChunks.push(errRedactor.finish());
    outRedactor.wipe();
    errRedactor.wipe();
    try { fs.rmSync(codexHome, { recursive: true, force: true }); } catch {}
  };
  return { child, outChunks, errChunks, cleanup, env };
}

/**
 * 副指挥 db0bbe13 evidence P1: probe the ACTUAL child env keys
 * seen by the process that would have been Codex, by running the
 * SAME PTY chain but replacing the codex binary with `env |
 * cut -d= -f1 | sort` inside the shell command. This closes the
 * "audited parent-env vs actual PTY-child-env" gap.
 *
 * When `unsetPwd` is true (production), the child must have EXACTLY
 * the 5-key allowlist. When false (mutation red), the child must
 * have 6 keys (the extra `PWD` sh injects) — proving the
 * `unset PWD;` prefix is the load-bearing guard.
 */
async function probeChildEnvKeysUnderPty(plaintext, unsetPwd) {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "rfc030-envprobe-"));
  const env = buildAllowlistEnv(plaintext, {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: codexHome,
    TMPDIR: os.tmpdir(),
    CODEX_HOME: codexHome,
  });
  const dumpArgs = []; // no args — `env` alone dumps
  // Reuse the same builder so the shell layer is identical to the
  // real spawn. Just swap `codexBin` → `env`.
  const shellCmd = buildPtyShellCommand(unsetPwd, "env", dumpArgs);
  const child = spawn("script", ["-qec", shellCmd, "/dev/null"], {
    env, stdio: ["pipe", "pipe", "pipe"],
  });
  const chunks = [];
  child.stdout.on("data", (c) => chunks.push(c));
  child.stderr.on("data", (c) => chunks.push(c));
  const [code] = await new Promise((r) => {
    child.on("exit", (c, s) => r([c, s]));
  });
  try { fs.rmSync(codexHome, { recursive: true, force: true }); } catch {}
  if (code !== 0) return { code, keys: null, raw: Buffer.concat(chunks).toString("utf8") };
  const raw = Buffer.concat(chunks).toString("utf8");
  // `env` output is `KEY=VALUE\n` per line. Extract keys.
  const keys = raw.split(/\r?\n/)
    .map((line) => line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/)?.[1])
    .filter((k) => typeof k === "string")
    .sort();
  // Deduplicate (some shells emit `_` twice under PTY).
  const uniq = [...new Set(keys)];
  return { code, keys: uniq, raw };
}

async function main() {
  console.log("RFC-030 Wave 1A P0.2 Commit 1 corrective round 6 — real codex 0.144.0 bootstrap smoke");
  const { server, plaintext, authorizerCalls } = await startServer();

  // 副指挥 e85ade40 evidence-gate P3: mutation red must run BEFORE
  // spawn so a lookalike-CommHub-key never reaches the child.
  let mutationRefused = false;
  try {
    buildAllowlistEnv("b", { COMMHUB_TOKEN: "leak" });
  } catch { mutationRefused = true; }
  if (mutationRefused) ok("mutation red: COMMHUB_TOKEN refused by buildAllowlistEnv");
  else fail("env mutation red", "COMMHUB_TOKEN went through buildAllowlistEnv");

  // 副指挥 db0bbe13 evidence P1: probe the REAL child env under
  // the SAME PTY chain by swapping codex → env. Assert exact 5-key
  // set. The parallel red run OMITS `unset PWD;` and MUST surface
  // 6 keys (including PWD) — proving the guard is load-bearing.
  const expectedEnvKeys = ["PATH", "HOME", "TMPDIR", "CODEX_HOME", TUI_BEARER_ENV_NAME].sort();
  const withGuard = await probeChildEnvKeysUnderPty(plaintext, true);
  if (withGuard.keys === null) {
    fail("child-env probe exit=0", `env-probe exited code=${withGuard.code}, raw=${JSON.stringify(withGuard.raw).slice(0, 200)}`);
  } else if (JSON.stringify(withGuard.keys) === JSON.stringify(expectedEnvKeys)) {
    ok(`child env exact-set (probed under PTY): [${withGuard.keys.join(",")}]`);
  } else {
    fail(
      "child env exact-set (probed under PTY)",
      `expected [${expectedEnvKeys.join(",")}] got [${withGuard.keys.join(",")}]`,
    );
  }
  // Mutation red — omit unset. Must show PWD → 6 keys.
  const withoutGuard = await probeChildEnvKeysUnderPty(plaintext, false);
  if (withoutGuard.keys === null) {
    fail("mutation-red child-env probe (no unset PWD) exit=0", `code=${withoutGuard.code}`);
  } else if (withoutGuard.keys.includes("PWD") && withoutGuard.keys.length === expectedEnvKeys.length + 1) {
    ok(`mutation red: without unset PWD the PTY child sees ${withoutGuard.keys.length} keys (includes PWD) — guard is load-bearing`);
  } else {
    fail(
      "mutation-red: missing PWD or unexpected key set",
      `keys=[${withoutGuard.keys.join(",")}] (expected exactly one extra key PWD)`,
    );
  }

  const { child, outChunks, errChunks, cleanup, env: spawnedEnv } = await spawnCodex(
    plaintext, server.boundPortActual(), true,
  );

  // Also keep the parent-side exact-set check on the SAME reference
  // that was passed to spawn (no spread copy). This closes the
  // "assertion audits copy A while spawn ships copy B" gap.
  const actualEnvKeys = Object.keys(spawnedEnv).sort();
  if (JSON.stringify(actualEnvKeys) === JSON.stringify(expectedEnvKeys)) {
    ok(`parent-side env reference exact-set matches allowlist: [${actualEnvKeys.join(",")}]`);
  } else {
    fail("env allowlist parent-side exact-set", `expected [${expectedEnvKeys.join(",")}] got [${actualEnvKeys.join(",")}]`);
  }

  // 副指挥 1b24ae71 P1: wait strictly for an authorizer call OR a
  // hard timeout. `ownerSlotState === "held"` alone is NOT a pass
  // signal — the round-2 direct-mode smoke passed 3/3 without a
  // single authorizer call. First authorizer call must be exactly
  // `account/read`.
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline && authorizerCalls.length === 0) {
    await new Promise((r) => setTimeout(r, 100));
  }
  try { child.kill("SIGKILL"); } catch {}
  await new Promise((r) => {
    const t = setTimeout(() => r(), 500);
    child.on("exit", () => { clearTimeout(t); r(); });
  });
  cleanup();
  const stderr = Buffer.concat(errChunks).toString("utf8");
  const stdout = Buffer.concat(outChunks).toString("utf8");

  // No plaintext bearer must ever appear in captured output.
  if (stdout.includes(plaintext) || stderr.includes(plaintext)) {
    fail("SecretRedactor covers child output", "plaintext bearer visible in captured output");
  } else {
    ok("SecretRedactor covers child output (no plaintext in captured out+err)");
  }

  // 副指挥 1b24ae71 P1: strict predicate. `ownerSlotState === "held"`
  // alone is NOT a pass signal — round-2 direct smoke passed 3/5
  // times with zero authorizer calls. Require at least one call AND
  // the first must be exactly `account/read`.
  if (authorizerCalls.length === 0) {
    const preview = stderr.slice(0, 300) + stdout.slice(0, 200);
    fail("Codex CLI bootstrap smoke", `0 authorizer calls in 6 s; child preview: ${JSON.stringify(preview)}`);
  } else {
    ok(`Codex authorizer invoked (${authorizerCalls.length} call${authorizerCalls.length === 1 ? "" : "s"})`);
    if (authorizerCalls[0] === "account/read") {
      ok("Codex first authorizer call is exactly account/read");
    } else {
      fail("Codex first authorizer call", `expected account/read, got ${authorizerCalls[0]}`);
    }
  }

  await server.stop();

  console.log("");
  for (const n of notes) console.log("  note:", n);
  console.log("");
  console.log(`real CLI bootstrap smoke PASS: ${passed}/${passed + failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("real-cli bootstrap smoke crash:", e);
  process.exit(2);
});
