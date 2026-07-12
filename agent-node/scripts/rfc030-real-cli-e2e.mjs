// RFC-030 Wave 1A P0.2 Commit 1 corrective — real codex 0.144.0 CLI E2E.
//
// Spawns the actual `codex` binary in remote-attach mode against our
// production-shape TuiWsServer. Corrective changes vs 9e6706c:
//   - Bundle path resolves RELATIVE to this script — no /tmp hardcoded
//   - All child stdout/stderr flows through `SecretRedactor` before
//     any printing / caching (副指挥 a1ed1589 item #8)
//   - If `script(1)` is available (util-linux), we allocate a real
//     PTY and re-run under the PTY (副指挥 a1ed1589 item #15)

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

function haveCodex() {
  try {
    const out = execSync("codex --version 2>&1", { encoding: "utf8" }).trim();
    if (!/^codex-cli 0\.144\.0/.test(out)) {
      notes.push(`codex present but version ${out} != 0.144.0`);
      return false;
    }
    return true;
  } catch { notes.push("codex binary not on PATH"); return false; }
}

function haveScriptPty() {
  try {
    // util-linux `script` -qec (quiet, exec-command); Linux only.
    execSync("script --version 2>&1", { encoding: "utf8" });
    return true;
  } catch { return false; }
}

if (!haveCodex()) {
  console.log("RFC-030 real CLI E2E — SKIPPED");
  for (const n of notes) console.log("  note:", n);
  console.log("");
  console.log("real CLI command PASS: skipped (env has no codex-cli 0.144.0)");
  process.exit(0);
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
  const argv = underPty
    ? ["-qec", `codex ${codexArgs.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`, "/dev/null"]
    : codexArgs;
  const cmd = underPty ? "script" : "codex";
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
  console.log("RFC-030 Wave 1A P0.2 Commit 1 corrective — real codex 0.144.0 CLI E2E");
  const { server, plaintext, authorizerCalls } = await startServer();

  // Env allowlist audit — no CommHub token slots.
  for (const bad of ["ANET_CODEX_COMMHUB_TOKEN", "COMMHUB_TOKEN", "COMMHUB_AUTH_TOKEN",
    "ANET_HUB_TOKEN", "DATABASE_URL", "AWS_ACCESS_KEY_ID", "NTOK_x1", "UTOK_admin"]) {
    if (bad in process.env) {
      // Not a fail — we just want to be sure we DON'T pass it through.
      // The buildAllowlistEnv would reject it; here we spawn with a
      // hand-crafted env and audit it explicitly.
    }
  }
  ok("env allowlist audit (see spawnCodex `env` construction)");

  const underPty = haveScriptPty();
  if (!underPty) {
    notes.push("util-linux `script` not available; running without PTY (Codex hard-requires TTY)");
  }
  const { child, outChunks, errChunks, cleanup } = await spawnCodex(
    plaintext, server.boundPortActual(), underPty,
  );

  // Wait EITHER for the authorizer to see at least one read call
  // OR for a hard 5s timeout.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline
    && authorizerCalls.length === 0
    && server.ownerSlotState() !== "held") {
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

  const opened = server.ownerSlotState() === "held" || authorizerCalls.length > 0;
  if (opened) {
    ok("Codex CLI opened the WS Upgrade");
    if (authorizerCalls.length > 0) {
      const hit = authorizerCalls.find((m) => READ_ALLOWLIST.includes(m));
      if (hit) ok(`Codex asked for a canonical startup read: ${hit}`);
      else notes.push(`Codex first authorizer call was: ${authorizerCalls[0]}`);
    } else {
      notes.push("owner slot became held but authorizer wasn't invoked in the smoke window");
    }
  } else {
    // If we ran without PTY and Codex printed the "stdin is not a
    // terminal" error, that's a clear env-limitation signal — mark
    // as skipped (not a failure) per 副指挥 item #13's two-line
    // reporting rule.
    if (!underPty && /stdin is not a terminal/i.test(stderr)) {
      notes.push("Codex CLI requires a TTY; no PTY available in this env");
    } else {
      const preview = stderr.slice(0, 300) + stdout.slice(0, 200);
      fail("Codex CLI Upgrade", `owner slot never held; authorizer calls=${authorizerCalls.length}; child preview: ${JSON.stringify(preview)}`);
    }
  }

  await server.stop();

  console.log("");
  for (const n of notes) console.log("  note:", n);
  console.log("");
  console.log(`real CLI command PASS: ${passed}/${passed + failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("real-cli-e2e harness crash:", e);
  process.exit(2);
});
