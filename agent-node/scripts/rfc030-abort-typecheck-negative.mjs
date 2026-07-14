#!/usr/bin/env node
// RFC-030 Wave 1A P0.2 Commit 2 corrective round 3 (副指挥 cdd20559
// P1). Per-fixture typecheck-negative harness for the abort()
// Promise<void> contract, with PRECISE diagnostic-line binding:
//
//   For each negative fixture:
//     1. Copy to a tmp dir with a `.ts` extension.
//     2. Rewrite the relative imports to absolute paths.
//     3. Run `tsc --strict --noEmit`.
//     4. Parse diagnostics into `{file, line, col, code, message}`.
//     5. Filter to diagnostics whose `file` == the fixture path.
//     6. For EACH fixture diagnostic:
//         - Assert code is TS2416 or TS2322 (the shape errors we
//           expect for a bad `abort` field).
//         - Assert `line` maps to a source line that MATCHES the
//           fixture's `expectedLineRegex` (i.e. actually points at
//           the `abort:` property line, not at another member).
//     7. Assert at least ONE fixture diagnostic exists (otherwise
//        the bad implementation was not rejected).
//     8. Assert NO unexpected diagnostics slip through — every
//        diagnostic in the fixture file must be an abort-line one.
//   Meta-mutation: take a positive fixture, mutate a NON-abort
//     property to fail typecheck, run through the SAME predicate,
//     and assert the harness turns RED. Proves the harness isn't
//     fooled by an unrelated TS error in the same class.
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

function copyFixtureContent(basename, tmpDir, mutate) {
  const src = path.join(fixturesDir, basename);
  const dst = path.join(tmpDir, basename.replace(".ts.fixture", ".ts"));
  let content = fs.readFileSync(src, "utf8");
  content = content.replaceAll('"../uds-server"', JSON.stringify(path.join(gwDir, "uds-server.ts")));
  content = content.replaceAll('"../protocol"', JSON.stringify(path.join(gwDir, "protocol.ts")));
  if (mutate) content = mutate(content);
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

// Parse `file(line,col): error TSxxxx: message` lines. tsc's format
// is stable enough for this narrow use.
function parseTscDiagnostics(output) {
  const diags = [];
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(/^(.+?)\((\d+),(\d+)\):\s+error\s+TS(\d+):\s+(.+)$/);
    if (m) {
      diags.push({
        file: m[1],
        line: Number(m[2]),
        col: Number(m[3]),
        code: `TS${m[4]}`,
        message: m[5],
      });
    }
  }
  return diags;
}

/**
 * Precise per-fixture predicate. Returns
 *   {ok: true}
 *   {ok: false, reason: string}
 */
function assessNegativeFixture(fixTsPath, className, expectedLineRegex, output) {
  const diags = parseTscDiagnostics(output);
  const fixDiags = diags.filter((d) => d.file === fixTsPath || path.resolve(d.file) === fixTsPath);
  if (fixDiags.length === 0) {
    return { ok: false, reason: "no diagnostics on fixture file" };
  }
  // Read source to bind line numbers to actual lines.
  const src = fs.readFileSync(fixTsPath, "utf8").split(/\r?\n/);
  for (const d of fixDiags) {
    const codeOk = d.code === "TS2416" || d.code === "TS2322";
    if (!codeOk) {
      return { ok: false, reason: `unexpected diag code ${d.code} at line ${d.line}: ${d.message}` };
    }
    const lineContent = src[d.line - 1] ?? "";
    if (!expectedLineRegex.test(lineContent)) {
      return {
        ok: false,
        reason: `diag at line ${d.line} does not match abort-property regex ${expectedLineRegex}; line content: ${lineContent.trim()}`,
      };
    }
    if (!output.includes(className)) {
      return { ok: false, reason: `output does not mention class ${className}` };
    }
  }
  return { ok: true };
}

let passed = 0;
let failed = 0;
const notes = [];
function ok(name) { passed++; console.log(`  ok  ${name}`); }
function fail(name, why) { failed++; console.log(`  FAIL ${name}: ${why}`); }

const NEGATIVE_FIXTURES = [
  {
    basename: "abort-negative-void.ts.fixture",
    className: "BadVoidAbort",
    expectedLineRegex: /^\s*abort:\s*\(\)\s*=>\s*void/,
  },
  {
    basename: "abort-negative-number.ts.fixture",
    className: "BadNumberAbort",
    expectedLineRegex: /^\s*abort:\s*\(\)\s*=>\s*number/,
  },
  {
    basename: "abort-negative-syncsymbol.ts.fixture",
    className: "BadSyncSymbolAbort",
    expectedLineRegex: /^\s*abort:\s*\(\)\s*=>\s*typeof REVERTED_SYNC_ABORT/,
  },
];

for (const nf of NEGATIVE_FIXTURES) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rfc030-abort-neg-"));
  const fixTs = copyFixtureContent(nf.basename, tmp);
  const tsconfig = makeTsconfig(fixTs, tmp);
  const { exitCode, output } = runTsc(tsconfig);
  const label = `negative fixture ${nf.basename}`;
  if (exitCode === 0) {
    fail(label, "tsc exited 0 — the bad implementation was NOT rejected");
    notes.push(`---- ${label} output ----`);
    notes.push(output.slice(0, 2000));
  } else {
    const verdict = assessNegativeFixture(fixTs, nf.className, nf.expectedLineRegex, output);
    if (verdict.ok) {
      ok(`${label} rejected; every fixture diagnostic points at the abort property line and is TS2416/TS2322`);
    } else {
      fail(label, verdict.reason);
      notes.push(`---- ${label} output ----`);
      notes.push(output.slice(0, 2000));
    }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

// Positive baseline: MUST typecheck clean.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rfc030-abort-pos-"));
  const fixTs = copyFixtureContent("abort-positive-baseline.ts.fixture", tmp);
  const tsconfig = makeTsconfig(fixTs, tmp);
  const { exitCode, output } = runTsc(tsconfig);
  if (exitCode === 0) {
    ok("positive baseline typechecks clean");
  } else {
    fail("positive baseline", `tsc exit ${exitCode}, output:\n${output.slice(0, 1500)}`);
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

// Meta-sanity variant #1: unrelated TS error appended to positive
// baseline. Harness precise-filter must NOT accept.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rfc030-abort-meta-un-"));
  const fixTs = copyFixtureContent("abort-positive-baseline.ts.fixture", tmp, (content) =>
    content + `\nconst bad: number = "not a number";\nexport const __unrelated = bad;\n`,
  );
  const tsconfig = makeTsconfig(fixTs, tmp);
  const { exitCode, output } = runTsc(tsconfig);
  // Apply the negative-fixture predicate for one of the Bad*Abort
  // fixtures. It must NOT return {ok:true} because this file
  // does not contain a bad abort — the diag is on a `const bad`
  // line, not an `abort:` line.
  const verdictAgainstNegativeFilter = assessNegativeFixture(
    fixTs, "BadVoidAbort", NEGATIVE_FIXTURES[0].expectedLineRegex, output,
  );
  if (exitCode !== 0 && verdictAgainstNegativeFilter.ok === false) {
    ok(`meta-sanity #1: unrelated TS error (exit=${exitCode}) rejected by precise abort-line filter (${verdictAgainstNegativeFilter.reason})`);
  } else {
    fail(
      "meta-sanity #1: unrelated TS error slipped past the negative filter",
      `exitCode=${exitCode}, verdict.ok=${verdictAgainstNegativeFilter.ok}`,
    );
    notes.push("---- meta-sanity #1 output ----");
    notes.push(output.slice(0, 1500));
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

// Meta-sanity variant #2: bad NON-abort property in the same class.
// Take a positive baseline, but mutate the `close` field to have
// wrong return type. The bare "exit != 0 + class-name mention" old
// harness would have accepted this; the precise abort-line filter
// MUST reject.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rfc030-abort-meta-close-"));
  // The positive baseline already implements close as `async close(): Promise<void>`.
  // Replace it with `close(): void {}` — that will produce a TS2416
  // on the close method, still inside GoodTransport, but NOT on the
  // abort line. Precise filter must reject.
  const fixTs = copyFixtureContent("abort-positive-baseline.ts.fixture", tmp, (content) =>
    content.replace(/async close\(\): Promise<void> \{\}/, "close(): void {}"),
  );
  const tsconfig = makeTsconfig(fixTs, tmp);
  const { exitCode, output } = runTsc(tsconfig);
  const verdict = assessNegativeFixture(
    fixTs, "GoodTransport", /^\s*abort:\s*\(\)\s*=>\s*void/, output,
  );
  if (exitCode !== 0 && verdict.ok === false) {
    ok(`meta-sanity #2: bad NON-abort property (close) rejected by precise abort-line filter (${verdict.reason})`);
  } else if (exitCode === 0) {
    // 副指挥 cdd20559 pre-submit #3: mutation MUST cause a diag —
    // otherwise the meta test has no signal. This is a HARD FAIL,
    // not a "skipped PASS".
    fail(
      "meta-sanity #2: mutation did NOT cause a tsc diag; meta test has no signal",
      "the `close(): void {}` mutation was expected to produce TS2416 but tsc exited 0",
    );
    notes.push("---- meta-sanity #2 output ----");
    notes.push(output.slice(0, 1500));
  } else {
    fail(
      "meta-sanity #2: bad non-abort property slipped past filter",
      `verdict.ok=${verdict.ok} — filter treated a close-line diag as an abort-line negative`,
    );
    notes.push("---- meta-sanity #2 output ----");
    notes.push(output.slice(0, 1500));
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
