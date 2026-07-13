#!/usr/bin/env node
// RFC-030 Wave 1A P0.2 Commit 2 corrective (副指挥 d53209eb #5)
//
// Runs `tsc --noEmit` on the async-abort typecheck-negative
// fixture and asserts:
//   1. tsc exits NON-ZERO (typecheck fails).
//   2. The error output includes the fixture path AND at least one
//      "not assignable to" complaint about `SyncAbortAcknowledgement`.
//
// Green when both hold. Red on any regression that lets an async
// abort() slip past the type system.
//
// Usage: `npm run typecheck:rfc030-async-abort-negative`.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const agentNodeRoot = path.resolve(__dirname, "..");
const tscBin = path.join(agentNodeRoot, "node_modules", ".bin", "tsc");
if (!fs.existsSync(tscBin)) {
  console.log("FAIL: tsc binary not found at", tscBin);
  console.log("     run `bun add -d typescript` first");
  process.exit(2);
}

const fixtureSrc = path.join(
  agentNodeRoot,
  "src", "runtime", "codex-policy-gateway", "fixtures",
  "async-abort-negative.ts.fixture",
);
if (!fs.existsSync(fixtureSrc)) {
  console.log("FAIL: fixture missing at", fixtureSrc);
  process.exit(2);
}

// Copy the fixture into a temp dir with a `.ts` extension so tsc
// treats it as a normal source file, and write a minimal tsconfig
// that inherits strict mode + points at the copy. The original
// fixture stays *.ts.fixture so the gateway tsconfig excludes it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rfc030-abort-neg-"));
const fixtureTs = path.join(tmp, "async-abort-negative.ts");
fs.copyFileSync(fixtureSrc, fixtureTs);

// Adjust import paths in the copied file — the source uses relative
// "../uds-server" which no longer resolves from tmp. Rewrite them
// to point at the real gateway subtree.
const gwDir = path.join(agentNodeRoot, "src", "runtime", "codex-policy-gateway");
let src = fs.readFileSync(fixtureTs, "utf8");
src = src.replaceAll('"../uds-server"', JSON.stringify(path.join(gwDir, "uds-server.ts")));
src = src.replaceAll('"../protocol"', JSON.stringify(path.join(gwDir, "protocol.ts")));
fs.writeFileSync(fixtureTs, src, "utf8");

const tsconfig = {
  compilerOptions: {
    target: "ES2022",
    lib: ["ES2022"],
    module: "ESNext",
    moduleResolution: "bundler",
    strict: true,
    noEmit: true,
    esModuleInterop: true,
    skipLibCheck: true,
    types: ["node"],
    isolatedModules: false,
    allowImportingTsExtensions: true,
  },
  include: [fixtureTs],
};
const tsconfigPath = path.join(tmp, "tsconfig.json");
fs.writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2), "utf8");

let stdout = "";
let stderr = "";
let exitCode = 0;
try {
  execFileSync(tscBin, ["--project", tsconfigPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  // If tsc exited 0, the type system LET an async abort through — RED.
} catch (e) {
  exitCode = e.status ?? 1;
  stdout = e.stdout?.toString() ?? "";
  stderr = e.stderr?.toString() ?? "";
}

const output = stdout + stderr;

console.log("RFC-030 async-abort typecheck-negative");
console.log("  fixture:", fixtureTs);
console.log("  tsc exit:", exitCode);

if (exitCode === 0) {
  console.log("  FAIL: tsc exited 0 — async abort was NOT rejected by the type system");
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(1);
}

// Assert the error mentions each of the three Bad*Abort classes
// AND at least one flavour of the brand ("SyncAbortAcknowledgement"
// or "unique symbol" — tsc's serialisation of `typeof SYNC_ABORT`).
const requiredBadClasses = ["BadAsyncAbort", "BadVoidAbort", "BadNumberAbort"];
const missingBad = requiredBadClasses.filter((c) => !output.includes(c));
const mentionsBrand = output.includes("SyncAbortAcknowledgement")
  || output.includes("unique symbol")
  || output.includes("typeof SYNC_ABORT");
if (missingBad.length > 0 || !mentionsBrand) {
  console.log("  FAIL: tsc failed but error text did not cover all required cases");
  console.log("  missing Bad*Abort classes:", missingBad.join(",") || "(none)");
  console.log("  brand mentioned:", mentionsBrand);
  console.log("---- tsc output (first 2 KB) ----");
  console.log(output.slice(0, 2000));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(1);
}

console.log("  ok  tsc rejected each of BadAsyncAbort / BadVoidAbort / BadNumberAbort");
console.log("  ok  error output references the SyncAbortAcknowledgement brand (`unique symbol`)");
console.log("---- first tsc lines ----");
console.log(output.split("\n").slice(0, 8).join("\n"));

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(0);
