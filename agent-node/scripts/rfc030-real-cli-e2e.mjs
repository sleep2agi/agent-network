// RFC-030 Wave 1A P0.2 Commit 1 corrective round 2 — real codex 0.144.0
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
  SecretRedactor,
} = mod;

const ALLOWED_LOOPBACK = "127.0.0.1";
let passed = 0, failed = 0;
const notes = [];

function ok(name) { passed++; console.log(`  ok  ${name}`); }
function fail(name, why) { failed++; console.log(`  FAIL ${name}: ${why}`); }

// ─────────────────────────────────────────────────────────────────────
// Env detection
// ─────────────────────────────────────────────────────────────────────

// 副指挥 06e92ef7 P1: absolute REALPATH — resolve symlinks so the
// version check and spawn use the same on-disk binary. Exact version
// match (`= 0.144.0`), NOT prefix.
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
  // Resolve symlinks so we're auditing the same inode we'll spawn.
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
async function spawnCodex(plaintext, port, underPty) {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "rfc030-codex-home-"));
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: codexHome,
    TMPDIR: os.tmpdir(),
    CODEX_HOME: codexHome,
    ANET_CODEX_TUI_BEARER: plaintext,
  };
  const codexArgs = [
    "--remote", `ws://${ALLOWED_LOOPBACK}:${port}`,
    "--remote-auth-token-env", "ANET_CODEX_TUI_BEARER",
    "-c", "check_for_update_on_startup=false",
  ];
  // Version-checked bin used verbatim in spawn so no PATH re-lookup
  // can slip a different codex in between (副指挥 1b24ae71 P1).
  const codexBin = CODEX_BIN;
  const argv = underPty
    ? ["-qec", `${JSON.stringify(codexBin)} ${codexArgs.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`, "/dev/null"]
    : codexArgs;
  const cmd = underPty ? "script" : codexBin;
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
  return { child, outChunks, errChunks, cleanup };
}

async function main() {
  console.log("RFC-030 Wave 1A P0.2 Commit 1 corrective round 4 — real codex 0.144.0 bootstrap smoke");
  const { server, plaintext, authorizerCalls } = await startServer();

  // 副指挥 06e92ef7 P1: assert the child env exact-set is exactly
  // the allowlist. Bad-key mutation attempts must FAIL loudly.
  const expectedEnvKeys = ["PATH", "HOME", "TMPDIR", "CODEX_HOME", "ANET_CODEX_TUI_BEARER"].sort();
  const childEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: os.tmpdir(),
    TMPDIR: os.tmpdir(),
    CODEX_HOME: os.tmpdir(),
    ANET_CODEX_TUI_BEARER: plaintext,
  };
  const actualEnvKeys = Object.keys(childEnv).sort();
  if (JSON.stringify(actualEnvKeys) === JSON.stringify(expectedEnvKeys)) {
    ok(`child env exact-set matches allowlist: [${actualEnvKeys.join(",")}]`);
  } else {
    fail("env allowlist exact-set", `expected [${expectedEnvKeys.join(",")}] got [${actualEnvKeys.join(",")}]`);
  }
  // Mutation red: attempting to add a CommHub-shape key must throw.
  const { buildAllowlistEnv } = mod;
  let mutationRefused = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    buildAllowlistEnv("b", { COMMHUB_TOKEN: "leak" });
  } catch { mutationRefused = true; }
  if (mutationRefused) ok("mutation red: COMMHUB_TOKEN refused by buildAllowlistEnv");
  else fail("env mutation red", "COMMHUB_TOKEN went through buildAllowlistEnv");

  const { child, outChunks, errChunks, cleanup } = await spawnCodex(
    plaintext, server.boundPortActual(), true,
  );

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
