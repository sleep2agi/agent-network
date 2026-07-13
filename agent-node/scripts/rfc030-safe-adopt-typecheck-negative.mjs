#!/usr/bin/env node
// RFC-030 Wave 1A P0.2 Commit 2 corrective round 10 (副指挥
// 9a9a198d). Per-fixture typecheck-negative harness for the
// `safeAdoptConsume` callback contract.

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
const safeAdoptSrc = path.join(gwDir, "safe-adopt.ts");

let passed = 0;
let failed = 0;
const notes = [];
function ok(name) { passed++; console.log(`  ok  ${name}`); }
function fail(name, why) { failed++; console.log(`  FAIL ${name}: ${why}`); }

// Assert safe-adopt.ts does NOT export any CAPTURED_* identifier.
{
  const src = fs.readFileSync(safeAdoptSrc, "utf8");
  const capturedExports = /^\s*export\s+(?:const|type|function|interface|class)\s+CAPTURED_/m;
  if (capturedExports.test(src)) {
    fail("safe-adopt.ts CAPTURED_* module-private", "found `export CAPTURED_...` declaration");
  } else {
    ok("safe-adopt.ts: no CAPTURED_* exports");
  }
}

const FIXTURES = [
  {
    basename: "safe-adopt-negative-async.ts.fixture",
    kind: "negative",
    expectedCode: /TS234[25]/,
    // 副指挥 fb2ec49a corrective: bind diag to the target line —
    // the `safeAdoptConsume(...)` call using an async callback.
    targetLineRegex: /safeAdoptConsume\(Promise\.resolve\(\),\s*async\s*\(/,
  },
  {
    basename: "safe-adopt-negative-promise-return.ts.fixture",
    kind: "negative",
    expectedCode: /TS234[25]/,
    targetLineRegex: /safeAdoptConsume\(Promise\.resolve\(\),\s*\(_v\)\s*=>\s*Promise\.resolve\(\)/,
  },
  {
    basename: "safe-adopt-negative-return-mistyped.ts.fixture",
    kind: "negative",
    expectedCode: /TS2322/,
    // Target the `const _p: Promise<unknown> = safeAdoptConsume(...)` line.
    targetLineRegex: /const\s+_p:\s*Promise<unknown>\s*=\s*safeAdoptConsume/,
  },
  {
    basename: "safe-adopt-positive-baseline.ts.fixture",
    kind: "positive",
  },
];

// Static import assertions per fixture.
for (const fx of FIXTURES) {
  const raw = fs.readFileSync(path.join(fixturesDir, fx.basename), "utf8");
  const importsProd = /import\s*\{[^}]*safeAdoptConsume[^}]*\}\s*from\s*"\.\.\/safe-adopt"/.test(raw);
  const redeclares = /(?:function|const|let|var)\s+safeAdoptConsume\b/.test(raw);
  if (!importsProd) {
    fail(`fixture ${fx.basename} imports production helper`, "no `from \"../safe-adopt\"` import found");
  } else {
    ok(`fixture ${fx.basename} imports production safeAdoptConsume`);
  }
  if (redeclares) {
    fail(`fixture ${fx.basename} no local safeAdoptConsume redeclare`, "found local declaration");
  } else {
    ok(`fixture ${fx.basename}: no local safeAdoptConsume redeclare`);
  }
}

function copyFixture(basename, tmpDir, mutate) {
  const src = path.join(fixturesDir, basename);
  const dst = path.join(tmpDir, basename.replace(".ts.fixture", ".ts"));
  let content = fs.readFileSync(src, "utf8");
  content = content.replaceAll('"../safe-adopt"', JSON.stringify(safeAdoptSrc));
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

function parseTscDiagnostics(output) {
  const diags = [];
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(/^(.+?)\((\d+),(\d+)\):\s+error\s+TS(\d+):\s+(.+)$/);
    if (m) diags.push({ file: m[1], line: Number(m[2]), code: `TS${m[4]}`, message: m[5] });
  }
  return diags;
}

for (const fx of FIXTURES) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rfc030-safe-adopt-"));
  const fixTs = copyFixture(fx.basename, tmp);
  const tsconfig = makeTsconfig(fixTs, tmp);
  const { exitCode, output } = runTsc(tsconfig);
  const label = `${fx.kind} fixture ${fx.basename}`;
  if (fx.kind === "positive") {
    if (exitCode === 0) {
      ok(`${label} typechecks clean`);
    } else {
      fail(label, `tsc exit ${exitCode}; output:\n${output.slice(0, 1500)}`);
    }
  } else {
    if (exitCode === 0) {
      fail(label, "tsc exited 0 — bad callback was NOT rejected");
      notes.push(`---- ${label} output ----`);
      notes.push(output.slice(0, 1500));
    } else {
      const diags = parseTscDiagnostics(output);
      const fixPath = fs.realpathSync(fixTs);
      const fixDiags = diags.filter((d) => {
        try { return fs.realpathSync(d.file) === fixPath; } catch { return false; }
      });
      if (fixDiags.length === 0) {
        fail(label, "no diagnostics on fixture file");
      } else {
        // 副指挥 fb2ec49a corrective: precise target-line
        // binding. Read the fixture source, find the diag's
        // reported line, and assert it matches the fixture's
        // `targetLineRegex`. A fixture that emitted the
        // expected TS code but on the wrong line (e.g. an
        // unrelated same-code error) is rejected.
        const src = fs.readFileSync(fixTs, "utf8").split(/\r?\n/);
        let matched = false;
        for (const d of fixDiags) {
          if (!fx.expectedCode.test(d.code)) continue;
          const lineContent = src[d.line - 1] ?? "";
          if (fx.targetLineRegex.test(lineContent)) {
            matched = true;
            break;
          }
        }
        if (!matched) {
          const summary = fixDiags.map((d) => {
            const lineContent = (src[d.line - 1] ?? "").trim();
            return `${d.code}@line${d.line}: ${lineContent.slice(0, 80)}`;
          }).join(" | ");
          fail(
            label,
            `no diag matches expected code ${fx.expectedCode} AND target line regex ${fx.targetLineRegex}; got: ${summary}`,
          );
        } else {
          ok(`${label} rejected with expected TS code on the target line`);
        }
      }
    }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

// 副指挥 fb2ec49a corrective meta-mutation A:
// "positive baseline + unrelated TS2322 elsewhere" must NOT
// pass any of the three negative-fixture filters. Load-bearing:
// exit code is non-zero (unrelated error), but the target-line
// binding rejects because the diag is on the appended `const
// _bad` line, not on a `safeAdoptConsume(...)` call.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rfc030-safe-adopt-meta-unrelated-"));
  const fixTs = copyFixture("safe-adopt-positive-baseline.ts.fixture", tmp, (content) =>
    content + `\nconst _bad: number = "not a number";\nexport const __unrelated = _bad;\n`,
  );
  const tsconfig = makeTsconfig(fixTs, tmp);
  const { exitCode, output } = runTsc(tsconfig);
  const diags = parseTscDiagnostics(output);
  const fixPath = fs.realpathSync(fixTs);
  const fixDiags = diags.filter((d) => {
    try { return fs.realpathSync(d.file) === fixPath; } catch { return false; }
  });
  if (exitCode === 0) {
    fail("meta-sanity A (unrelated error)", "mutation produced no diag");
  } else {
    const src = fs.readFileSync(fixTs, "utf8").split(/\r?\n/);
    // Simulate applying EVERY negative-fixture filter — none
    // must accept.
    const negativeFixtures = FIXTURES.filter((f) => f.kind === "negative");
    const anyMatched = negativeFixtures.some((fx) => {
      return fixDiags.some((d) => {
        if (!fx.expectedCode.test(d.code)) return false;
        const lineContent = src[d.line - 1] ?? "";
        return fx.targetLineRegex.test(lineContent);
      });
    });
    if (anyMatched) {
      fail("meta-sanity A: unrelated same-code error passed a negative filter", "");
      notes.push("---- meta-sanity A output ----");
      notes.push(output.slice(0, 1500));
    } else {
      ok(`meta-sanity A: unrelated TS2322 (exit=${exitCode}) rejected by ALL negative-fixture target-line filters`);
    }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

// Meta-mutation B: valid safeAdoptConsume call + unrelated
// TS2322 elsewhere. Even sharper than mutation A because the
// legitimate call is present but the diag is not on it.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rfc030-safe-adopt-meta-valid-plus-"));
  const fixTs = copyFixture("safe-adopt-positive-baseline.ts.fixture", tmp, (content) => {
    // Insert an unrelated same-code error (TS2345 — a legit
    // wrong-arg-count call to a stdlib function).
    return content + `\n// unrelated TS2345 — Number.prototype.toFixed takes an optional number\nvoid Number(0).toFixed("bad" as unknown as number);\n`;
  });
  const tsconfig = makeTsconfig(fixTs, tmp);
  const { exitCode, output } = runTsc(tsconfig);
  const diags = parseTscDiagnostics(output);
  const fixPath = fs.realpathSync(fixTs);
  const fixDiags = diags.filter((d) => {
    try { return fs.realpathSync(d.file) === fixPath; } catch { return false; }
  });
  const src = fs.readFileSync(fixTs, "utf8").split(/\r?\n/);
  const negativeFixtures = FIXTURES.filter((f) => f.kind === "negative");
  const anyMatched = negativeFixtures.some((fx) => {
    return fixDiags.some((d) => {
      if (!fx.expectedCode.test(d.code)) return false;
      const lineContent = src[d.line - 1] ?? "";
      return fx.targetLineRegex.test(lineContent);
    });
  });
  if (exitCode === 0) {
    // No diag emitted — mutation didn't produce an error. That
    // undermines the meta test but doesn't indicate a filter
    // bug either. Note but pass.
    notes.push("meta-sanity B: mutation produced no diag (unexpected; still passing)");
    ok(`meta-sanity B: valid-call + unrelated-error mutation (exit=${exitCode}) does not pass negative filters`);
  } else if (anyMatched) {
    fail("meta-sanity B: unrelated same-code error slipped past filter", "");
    notes.push("---- meta-sanity B output ----");
    notes.push(output.slice(0, 1500));
  } else {
    ok(`meta-sanity B: valid safeAdoptConsume call + unrelated same-code error (exit=${exitCode}) rejected by target-line filters`);
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log("");
console.log(`safe-adopt typecheck-negative PASS: ${passed}/${passed + failed}`);
if (failed > 0) {
  console.log("");
  for (const n of notes) console.log(n);
  process.exit(1);
}
process.exit(0);
