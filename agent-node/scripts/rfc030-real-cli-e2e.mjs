// RFC-030 Wave 1A P0.2 Commit 1 corrective round 9 — real codex 0.144.0
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
// 副指挥 ab7d7682 / b2b22ae6 / 67ac4df5 evidence P1: probe MUST NOT
// touch the real bearer, AND the canary-scrub detector MUST bind
// to the probe's SAME raw stdout / stderr chunk streams with
// PER-STREAM independent rolling tails. Round-8 shared a single
// rolling-tail across the two streams, which had two failure
// modes:
//   (a) stdout writes prefix → stderr writes noise → stdout
//       writes suffix. stdout ALONE is a contiguous canary, but
//       the shared tail got overwritten by stderr's noise
//       between the two stdout feeds → false negative.
//   (b) stdout writes prefix → stderr writes suffix. Neither
//       stream contains a full canary, but the shared tail would
//       concatenate them → false positive.
// Round-9 uses two separate detector instances (one per stream);
// the reported `canaryDetected` OR-reduces them, so a canary that
// is contiguous within EITHER stream is caught, and neither
// stream can borrow bytes from the other.
//
// Additionally we now wait for the child's `close` event
// (which fires AFTER stdio streams have emitted `end`) instead of
// `exit`. `exit` can fire while a final chunk is still buffered
// in stdout / stderr; `close` guarantees the tail has drained.
//
// Real Codex spawn continues to use the real bearer +
// SecretRedactor — the two paths do NOT share plaintext.
const PROBE_CANARY_BEARER = "probe-canary-NOT-A-REAL-BEARER-abcdefghij";

/**
 * Streaming canary detector. Feeds byte chunks; on each chunk it
 * concatenates a rolling tail of `canary.length - 1` bytes from
 * the previous chunk so the canary is detected even when it lands
 * on a chunk boundary. Never buffers the whole stream. A single
 * detector instance is bound to a SINGLE stream so a peer stream
 * cannot corrupt its rolling tail.
 */
function makeCanaryDetector(canary) {
  const target = Buffer.from(canary, "utf8");
  let tail = Buffer.alloc(0);
  let hit = false;
  return {
    feed(chunk) {
      if (hit) return;
      const buf = tail.length > 0 ? Buffer.concat([tail, chunk]) : chunk;
      if (buf.indexOf(target) >= 0) { hit = true; return; }
      const keep = Math.min(buf.length, target.length - 1);
      tail = keep > 0 ? buf.slice(buf.length - keep) : Buffer.alloc(0);
    },
    detected() { return hit; },
  };
}

/**
 * Single production probe. Runs the SAME capture path in both
 * modes: raw stdout/stderr chunks feed the canary detector,
 * stdout also feeds a line-splitting parser that extracts key
 * names only. Return object contains ONLY {code, keys,
 * canaryDetected, note} — NO raw byte field, NO value strings.
 *
 * mode.dumpValues:
 *   false (safe) — child pipeline strips values BEFORE emit:
 *     `env | cut -d= -f1 | grep ... | sort -u`
 *     Detector MUST NOT fire in this mode.
 *   true  (unsafe/mutation-red) — child pipeline emits `env`
 *     verbatim so values (including canary) surface on stdout.
 *     Detector MUST fire; if it doesn't, the detector is dead
 *     code and the whole safe-mode PASS is meaningless.
 */
async function probeChildEnvKeysUnderPty(unsetPwd, { dumpValues = false } = {}) {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "rfc030-envprobe-"));
  const env = buildAllowlistEnv(PROBE_CANARY_BEARER, {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: codexHome,
    TMPDIR: os.tmpdir(),
    CODEX_HOME: codexHome,
  });
  const childPipeline = dumpValues
    // Unsafe: emit `env` verbatim so values (canary) hit stdout.
    ? "env"
    // Safe: strip values inside child.
    : "env | cut -d= -f1 | grep -E '^[A-Za-z_][A-Za-z0-9_]*$' | sort -u";
  const prefix = unsetPwd ? "unset PWD; " : "";
  const shellCmd = `${prefix}${childPipeline}`;
  const child = spawn("script", ["-qec", shellCmd, "/dev/null"], {
    env, stdio: ["pipe", "pipe", "pipe"],
  });
  // 副指挥 67ac4df5: per-stream detectors with independent tails.
  const stdoutDetector = makeCanaryDetector(PROBE_CANARY_BEARER);
  const stderrDetector = makeCanaryDetector(PROBE_CANARY_BEARER);
  const outLines = [];
  let stderrBytes = 0;
  let stdoutTail = "";
  // Detectors tap the RAW byte chunks BEFORE the line splitter —
  // reordering / rewrapping the parse layer cannot deceive them.
  child.stdout.on("data", (c) => {
    stdoutDetector.feed(c);
    stdoutTail += c.toString("utf8");
    let idx;
    while ((idx = stdoutTail.indexOf("\n")) >= 0) {
      const line = stdoutTail.slice(0, idx).trim();
      stdoutTail = stdoutTail.slice(idx + 1);
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)$/);
      if (m) outLines.push(m[1]);
    }
  });
  child.stderr.on("data", (c) => {
    stderrDetector.feed(c);
    stderrBytes += c.length;
  });
  // 副指挥 67ac4df5: await `close` (fires AFTER stdio streams
  // have flushed and emitted their `end`), NOT `exit` — `exit` can
  // fire while a final buffered stdout / stderr chunk is still in
  // flight, which would let the detector read stale state.
  const code = await new Promise((r) => {
    child.on("close", (c) => r(c));
  });
  if (stdoutTail.trim()) {
    const m = stdoutTail.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)$/);
    if (m) outLines.push(m[1]);
  }
  try { fs.rmSync(codexHome, { recursive: true, force: true }); } catch {}
  const keys = [...new Set(outLines)].sort();
  // `note` never contains values — only exit code + counters.
  const note = `exit=${code} stderr_bytes=${stderrBytes} lines=${outLines.length}`;
  const canaryDetected = stdoutDetector.detected() || stderrDetector.detected();
  return { code, keys, canaryDetected, note };
}

async function main() {
  console.log("RFC-030 Wave 1A P0.2 Commit 1 corrective round 9 — real codex 0.144.0 bootstrap smoke");
  const { server, plaintext, authorizerCalls } = await startServer();

  // 副指挥 e85ade40 evidence-gate P3: mutation red must run BEFORE
  // spawn so a lookalike-CommHub-key never reaches the child.
  let mutationRefused = false;
  try {
    buildAllowlistEnv("b", { COMMHUB_TOKEN: "leak" });
  } catch { mutationRefused = true; }
  if (mutationRefused) ok("mutation red: COMMHUB_TOKEN refused by buildAllowlistEnv");
  else fail("env mutation red", "COMMHUB_TOKEN went through buildAllowlistEnv");

  // 副指挥 67ac4df5 evidence P1 direct-repro: two pure-JS
  // synthetic interleave cases that exercise the detector wiring
  // WITHOUT a child process, driving the SAME `makeCanaryDetector`
  // instances the probe uses.
  {
    const canary = PROBE_CANARY_BEARER;
    const mid = Math.floor(canary.length / 2);
    const prefix = Buffer.from(canary.slice(0, mid), "utf8");
    const suffix = Buffer.from(canary.slice(mid), "utf8");
    // Case A: canary is CONTIGUOUS on stdout, split by stderr
    // noise arriving BETWEEN the two stdout feeds. With a shared
    // detector (round-8) the tail would be overwritten by stderr
    // "NOISE" and the canary would be MISSED. Per-stream detectors
    // fix that.
    const stdoutA = makeCanaryDetector(canary);
    const stderrA = makeCanaryDetector(canary);
    stdoutA.feed(prefix);
    stderrA.feed(Buffer.from("NOISE_NOT_CANARY_XYZ", "utf8"));
    stdoutA.feed(suffix);
    const detectedA = stdoutA.detected() || stderrA.detected();
    if (detectedA === true) {
      ok("detector interleave case A: stdout prefix + stderr noise + stdout suffix ⇒ detected=true (contiguous within stdout stream)");
    } else {
      fail(
        "detector interleave case A",
        "expected detected=true when canary is contiguous within stdout despite stderr interleave; got false",
      );
    }
    // Case B: canary is SPLIT across streams — prefix on stdout,
    // suffix on stderr. Neither stream contains the whole canary.
    // With a shared detector (round-8) the tail from stdout would
    // fuse with the stderr feed and produce a FALSE POSITIVE.
    // Per-stream detectors keep each tail isolated → detected=false.
    const stdoutB = makeCanaryDetector(canary);
    const stderrB = makeCanaryDetector(canary);
    stdoutB.feed(prefix);
    stderrB.feed(suffix);
    const detectedB = stdoutB.detected() || stderrB.detected();
    if (detectedB === false) {
      ok("detector interleave case B: stdout prefix + stderr suffix ⇒ detected=false (no cross-stream fusion)");
    } else {
      fail(
        "detector interleave case B",
        "expected detected=false when canary is split across streams; got true (would be a cross-stream false positive)",
      );
    }
  }

  // 副指挥 ab7d7682 / b2b22ae6 evidence P1: probe uses a FIXED
  // CANARY bearer, never the real plaintext. Child emits only key
  // names in safe mode. Parent never stores/returns/prints raw
  // values. Detector taps the SAME raw stdout+stderr chunk streams
  // the probe uses (chunk-boundary safe).
  const expectedEnvKeys = ["PATH", "HOME", "TMPDIR", "CODEX_HOME", TUI_BEARER_ENV_NAME].sort();
  const withGuard = await probeChildEnvKeysUnderPty(true);
  if (withGuard.code !== 0) {
    fail("child-env probe exit=0", `env-probe failed ${withGuard.note}`);
  } else if (JSON.stringify(withGuard.keys) === JSON.stringify(expectedEnvKeys)) {
    ok(`child env exact-set (probed under PTY, canary bearer): [${withGuard.keys.join(",")}]`);
  } else {
    fail(
      "child env exact-set (probed under PTY)",
      `expected [${expectedEnvKeys.join(",")}] got [${withGuard.keys.join(",")}] (${withGuard.note})`,
    );
  }
  // Mutation red 1 — omit unset PWD. Must show PWD → 6 keys.
  const withoutGuard = await probeChildEnvKeysUnderPty(false);
  if (withoutGuard.code !== 0) {
    fail("mutation-red no-unset-PWD probe exit=0", `probe failed ${withoutGuard.note}`);
  } else if (withoutGuard.keys.includes("PWD") && withoutGuard.keys.length === expectedEnvKeys.length + 1) {
    ok(`mutation red: without unset PWD the PTY child sees ${withoutGuard.keys.length} keys (includes PWD) — guard is load-bearing`);
  } else {
    fail(
      "mutation-red: missing PWD or unexpected key set",
      `keys=[${withoutGuard.keys.join(",")}] (expected exactly one extra key PWD)`,
    );
  }
  // 副指挥 b2b22ae6 P1 hard-red: canary detector is bound to the
  // probe's REAL stdout/stderr byte chunks. We run the SAME probe
  // function in an `unsafe/dumpValues` mode where the child pipes
  // out `env` verbatim — values (including the canary bearer) do
  // land on stdout. If the detector is real, it MUST fire; if not,
  // safe-mode PASS is meaningless.
  const unsafeDump = await probeChildEnvKeysUnderPty(true, { dumpValues: true });
  if (unsafeDump.canaryDetected === true) {
    ok("canary detector — unsafe mode: canary in child stdout was DETECTED (detector proven live)");
  } else {
    fail(
      "canary detector — unsafe mode",
      `expected canaryDetected=true when child pipes value stream; got false (${unsafeDump.note})`,
    );
  }
  // Safe mode invariant: detector MUST NOT fire under production
  // capture — values are stripped in the child.
  if (withGuard.canaryDetected === false && withoutGuard.canaryDetected === false) {
    ok("canary detector — safe mode: withGuard + withoutGuard both scanned clean (0 hits)");
  } else {
    fail(
      "canary detector — safe mode",
      `withGuard.canaryDetected=${withGuard.canaryDetected} withoutGuard.canaryDetected=${withoutGuard.canaryDetected} (expected both false)`,
    );
  }
  // Return-shape gate: probe return objects contain ONLY the
  // whitelisted fields — never a raw string, never a value.
  const allowedFields = new Set(["code", "keys", "canaryDetected", "note"]);
  const shapeOk = [withGuard, withoutGuard, unsafeDump].every(
    (r) => Object.keys(r).every((k) => allowedFields.has(k)),
  );
  if (shapeOk) {
    ok("probe return shape: only {code, keys, canaryDetected, note} exposed");
  } else {
    const extras = [withGuard, withoutGuard, unsafeDump]
      .flatMap((r) => Object.keys(r))
      .filter((k) => !allowedFields.has(k));
    fail("probe return shape", `extra fields leaked: [${[...new Set(extras)].join(",")}]`);
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
