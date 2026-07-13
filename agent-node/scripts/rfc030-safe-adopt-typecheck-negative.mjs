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
  { basename: "safe-adopt-negative-async.ts.fixture", kind: "negative", expectedCode: /TS234[25]/ },
  { basename: "safe-adopt-negative-promise-return.ts.fixture", kind: "negative", expectedCode: /TS234[25]/ },
  { basename: "safe-adopt-negative-return-mistyped.ts.fixture", kind: "negative", expectedCode: /TS2322/ },
  { basename: "safe-adopt-positive-baseline.ts.fixture", kind: "positive" },
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
        const codeMatched = fixDiags.some((d) => fx.expectedCode.test(d.code));
        if (!codeMatched) {
          fail(label, `expected code ${fx.expectedCode}; got ${fixDiags.map((d) => d.code).join(",")}`);
        } else {
          ok(`${label} rejected with expected TS code`);
        }
      }
    }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

// Meta-sanity: unrelated TS error appended to positive baseline.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rfc030-safe-adopt-meta-"));
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
    fail("meta-sanity: unrelated error mutation", "mutation produced no diag");
  } else {
    const mentionsSafeAdoptCallback = fixDiags.some((d) => /safeAdoptConsume|Promise\s*<\s*void\s*>|Promise\s*<\s*unknown\s*>/.test(d.message));
    if (!mentionsSafeAdoptCallback) {
      ok(`meta-sanity: unrelated TS2322 (exit=${exitCode}) does NOT reference the safeAdoptConsume contract`);
    } else {
      fail("meta-sanity: unrelated error slipped past filter", "output mentions safeAdoptConsume contract");
      notes.push("---- meta-sanity output ----");
      notes.push(output.slice(0, 1500));
    }
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
