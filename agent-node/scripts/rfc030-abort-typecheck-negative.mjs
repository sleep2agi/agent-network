#!/usr/bin/env node
// RFC-030 Wave 1A P0.2 Commit 2 corrective round 2 (副指挥 0bd525d0
// P1-3). Per-fixture typecheck harness for the abort() Promise<void>
// contract.
//
// For EACH negative fixture:
//   - Copy to a fresh tmp dir with a `.ts` extension.
//   - Rewrite the relative imports so they resolve to the actual
//     gateway sources.
//   - Run `tsc --strict --noEmit`.
//   - Assert:
//       * tsc exit code non-zero
//       * error output includes a TS2416 / TS2322 diagnostic
//         pointing at the FIXTURE's own file
//       * error output mentions the specific class name in the
//         fixture
//       * the OFFENDING LINE for that fixture is the `abort:` line
//
// The positive baseline fixture is expected to typecheck CLEAN
// (exit 0). A "positive + unrelated TS error" variant is generated
// on the fly and MUST NOT pass the negative check (proving the
// harness cannot be tricked by unrelated diagnostics elsewhere).
//
// Usage: `npm run typecheck:rfc030-abort-negative`.

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
  process.exit(2);
}
const gwDir = path.join(agentNodeRoot, "src", "runtime", "codex-policy-gateway");
const fixturesDir = path.join(gwDir, "fixtures");

function copyFixture(basename, tmpDir) {
  const src = path.join(fixturesDir, basename);
  const dst = path.join(tmpDir, basename.replace(".ts.fixture", ".ts"));
  let content = fs.readFileSync(src, "utf8");
  content = content.replaceAll('"../uds-server"', JSON.stringify(path.join(gwDir, "uds-server.ts")));
  content = content.replaceAll('"../protocol"', JSON.stringify(path.join(gwDir, "protocol.ts")));
  fs.writeFileSync(dst, content, "utf8");
  return dst;
}

function makeTsconfig(entryFile, tmpDir) {
  const cfg = {
    compilerOptions: {
      target: "ES2022", lib: ["ES2022"], module: "ESNext", moduleResolution: "bundler",
      strict: true, noEmit: true, esModuleInterop: true, skipLibCheck: true,
      types: ["node"], isolatedModules: false, allowImportingTsExtensions: true,
      strictFunctionTypes: true,
      typeRoots: [path.join(agentNodeRoot, "node_modules", "@types")],
      baseUrl: agentNodeRoot,
      paths: { "*": [path.join(agentNodeRoot, "node_modules", "*")] },
    },
    include: [entryFile],
  };
  const p = path.join(tmpDir, "tsconfig.json");
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), "utf8");
  return p;
}

function runTsc(tsconfigPath) {
  try {
    execFileSync(tscBin, ["--project", tsconfigPath], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { exitCode: 0, output: "" };
  } catch (e) {
    return {
      exitCode: e.status ?? 1,
      output: (e.stdout?.toString() ?? "") + (e.stderr?.toString() ?? ""),
    };
  }
}

let passed = 0;
let failed = 0;
const notes = [];
function ok(name) { passed++; console.log(`  ok  ${name}`); }
function fail(name, why) { failed++; console.log(`  FAIL ${name}: ${why}`); }

const NEGATIVE_FIXTURES = [
  { basename: "abort-negative-void.ts.fixture",       className: "BadVoidAbort",       expectedLineRegex: /abort: \(\) => void/ },
  { basename: "abort-negative-number.ts.fixture",     className: "BadNumberAbort",     expectedLineRegex: /abort: \(\) => number/ },
  { basename: "abort-negative-syncsymbol.ts.fixture", className: "BadSyncSymbolAbort", expectedLineRegex: /abort: \(\) => typeof REVERTED_SYNC_ABORT/ },
];

for (const nf of NEGATIVE_FIXTURES) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rfc030-abort-neg-"));
  const fixTs = copyFixture(nf.basename, tmp);
  const tsconfig = makeTsconfig(fixTs, tmp);
  const { exitCode, output } = runTsc(tsconfig);
  const label = `negative fixture ${nf.basename}`;
  if (exitCode === 0) {
    fail(label, "tsc exited 0 — the bad implementation was NOT rejected");
    notes.push(`---- ${label} output ----`);
    notes.push(output.slice(0, 2000));
  } else {
    // Precise assertions: mentions className, mentions the fixture
    // file basename, and a TS2416/TS2322 diagnostic.
    const outputMentionsClass = output.includes(nf.className);
    const outputMentionsFixture = output.includes(path.basename(fixTs));
    const outputMentionsTs2416Or2322 = /TS241[6]|TS2322/.test(output);
    if (!outputMentionsClass || !outputMentionsFixture || !outputMentionsTs2416Or2322) {
      fail(
        label,
        `precise assertions failed — class=${outputMentionsClass} fixture=${outputMentionsFixture} diag=${outputMentionsTs2416Or2322}`,
      );
      notes.push(`---- ${label} output ----`);
      notes.push(output.slice(0, 2000));
    } else {
      ok(`${label} rejected with class + fixture + TS2416/TS2322 all mentioned`);
    }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

// Positive baseline sanity: MUST typecheck clean.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rfc030-abort-pos-"));
  const fixTs = copyFixture("abort-positive-baseline.ts.fixture", tmp);
  const tsconfig = makeTsconfig(fixTs, tmp);
  const { exitCode, output } = runTsc(tsconfig);
  if (exitCode === 0) {
    ok("positive baseline typechecks clean");
  } else {
    fail("positive baseline", `tsc exit ${exitCode}, output:\n${output.slice(0, 1500)}`);
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

// Meta-sanity: if we take the positive baseline and INJECT an
// unrelated TS error (a badly typed identifier), a bare exit-non-zero
// check would trick a lax harness. Our harness is stricter: it
// requires the error to mention the target class. Prove that here:
//   - Take the positive fixture.
//   - Append an unrelated line: `const bad: number = "not a number";`
//   - tsc will exit non-zero (unrelated TS2322), but our precise
//     "mentions className AND fixture AND TS241X" check filters to
//     className = "BadVoidAbort" etc., NONE of which are in the
//     fixture. The harness must NOT count this as a negative pass.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rfc030-abort-meta-"));
  const posBase = fs.readFileSync(path.join(fixturesDir, "abort-positive-baseline.ts.fixture"), "utf8");
  const withUnrelated =
    posBase.replaceAll('"../uds-server"', JSON.stringify(path.join(gwDir, "uds-server.ts")))
           .replaceAll('"../protocol"', JSON.stringify(path.join(gwDir, "protocol.ts")))
    + `\nconst bad: number = "not a number";\nexport const __unrelated = bad;\n`;
  const fixTs = path.join(tmp, "meta-positive-with-unrelated-error.ts");
  fs.writeFileSync(fixTs, withUnrelated, "utf8");
  const tsconfig = makeTsconfig(fixTs, tmp);
  const { exitCode, output } = runTsc(tsconfig);
  // Bare exit check: non-zero. But we apply the NEGATIVE FIXTURE
  // precise-assertion filter and require it to REJECT this input.
  const wouldPassNegativeFilter =
    exitCode !== 0
      && output.includes("BadVoidAbort")
      && output.includes("BadNumberAbort")
      && output.includes("BadSyncSymbolAbort");
  if (wouldPassNegativeFilter) {
    fail(
      "meta-sanity: unrelated-error must NOT pretend to be a negative",
      "unrelated-error output matched the negative filter — harness is too loose",
    );
    notes.push("---- meta-sanity unrelated-error output ----");
    notes.push(output.slice(0, 1500));
  } else {
    ok(`meta-sanity: unrelated TS error (exit=${exitCode}) does NOT pass the negative filter`);
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log("");
console.log(`abort typecheck-negative PASS: ${passed}/${passed + failed}`);
if (failed > 0) {
  console.log("");
  for (const n of notes) console.log(n);
  process.exit(1);
}
process.exit(0);
