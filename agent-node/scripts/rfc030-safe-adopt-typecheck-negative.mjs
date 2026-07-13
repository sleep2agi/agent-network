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
    // 副指挥 fb2ec49a: target-line binding.
    targetLineRegex: /safeAdoptConsume\(Promise\.resolve\(\),\s*async\s*\(/,
    // 副指挥 7535c7cb: bind to the CONTRACT-VIOLATION sub-message
    // "Type 'Promise<void>' is not assignable to type 'undefined'".
    // parseTscDiagnostics captures multi-line messages so this
    // sub-line is visible. Contravariance / wrong-arg-count
    // errors on the same line do NOT include this sub-message.
    expectedMessageRegex: /Type 'Promise<void>' is not assignable to type 'undefined'/,
  },
  {
    basename: "safe-adopt-negative-promise-return.ts.fixture",
    kind: "negative",
    expectedCode: /TS234[25]/,
    targetLineRegex: /safeAdoptConsume\(Promise\.resolve\(\),\s*\(_v\)\s*=>\s*Promise\.resolve\(\)/,
    expectedMessageRegex: /Type 'Promise<void>' is not assignable to type 'undefined'/,
  },
  {
    basename: "safe-adopt-negative-return-mistyped.ts.fixture",
    kind: "negative",
    expectedCode: /TS2322/,
    targetLineRegex: /const\s+_p:\s*Promise<unknown>\s*=\s*safeAdoptConsume/,
    expectedMessageRegex: /is not assignable to type 'Promise<unknown>'|Type 'void' is not assignable to type 'Promise<unknown>'/,
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
  // 副指挥 7535c7cb: capture MULTI-LINE tsc messages. Header
  // is `file(line,col): error TSNNNN: <headline>`; sub-messages
  // are subsequent lines beginning with whitespace. Message
  // binding needs full text so a sub-line like
  //   "Type 'Promise<void>' is not assignable to type 'undefined'."
  // is distinguishable from a header that merely quotes the
  // type in its parameter stringification.
  const diags = [];
  const lines = output.split(/\r?\n/);
  let cur = null;
  const flush = () => {
    if (cur) {
      diags.push(cur);
      cur = null;
    }
  };
  for (const line of lines) {
    const m = line.match(/^(.+?)\((\d+),(\d+)\):\s+error\s+TS(\d+):\s+(.+)$/);
    if (m) {
      flush();
      cur = { file: m[1], line: Number(m[2]), code: `TS${m[4]}`, message: m[5] };
    } else if (cur && /^\s+\S/.test(line)) {
      cur.message += " " + line.trim();
    } else if (/^\S/.test(line)) {
      flush();
    }
  }
  flush();
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
        // 副指挥 fb2ec49a + 7535c7cb: match code + target line
        // + MESSAGE. Rejects a fixture that emits an unrelated
        // same-code error on the target line pattern.
        const src = fs.readFileSync(fixTs, "utf8").split(/\r?\n/);
        let matched = false;
        for (const d of fixDiags) {
          if (!fx.expectedCode.test(d.code)) continue;
          const lineContent = src[d.line - 1] ?? "";
          if (!fx.targetLineRegex.test(lineContent)) continue;
          if (fx.expectedMessageRegex && !fx.expectedMessageRegex.test(d.message)) continue;
          matched = true;
          break;
        }
        if (!matched) {
          const summary = fixDiags.map((d) => {
            const lineContent = (src[d.line - 1] ?? "").trim();
            return `${d.code}@line${d.line}: ${lineContent.slice(0, 60)} :: ${d.message.slice(0, 60)}`;
          }).join(" | ");
          fail(
            label,
            `no diag matches code ${fx.expectedCode} AND target-line ${fx.targetLineRegex} AND message ${fx.expectedMessageRegex}; got: ${summary}`,
          );
        } else {
          ok(`${label} rejected with expected TS code + target line + message`);
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

// Meta-mutation B (副指挥 7535c7cb corrective): the previous
// `"bad" as unknown as number` variant was type-legal — the
// cast made `toFixed` accept the string at compile time, so
// tsc exit=0 and the harness treated "no diag" as pass. That
// hid the mutation. New meta-B:
//
//   Append an EXTRA `safeAdoptConsume(...)` call whose 4th arg
//   (`onCallbackError`) has a `number`-return type instead of
//   `undefined`. That is a REAL contract violation → TS2345
//   emitted on the appended call line. But the appended line
//   contains a plain (non-async, non-Promise-returning)
//   fulfilled callback — so it matches NEITHER the async
//   fixture's `targetLineRegex` NOR the promise-return
//   fixture's regex NOR the return-mistyped fixture's regex.
//   The message binding is also different.
//
//   Filter MUST reject; harness MUST see a real diag; exit=0
//   is a HARD FAIL.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rfc030-safe-adopt-meta-valid-plus-"));
  const fixTs = copyFixture("safe-adopt-positive-baseline.ts.fixture", tmp, (content) => {
    // Real TS2345: 4th arg has `number` return instead of `undefined`.
    return content + `
// meta-B mutation: same TS code as the async-fixture target
// (TS2345) but on an unrelated same-line pattern with an
// UNRELATED message. Must NOT slip past the negative filters.
void safeAdoptConsume(
  Promise.resolve("val"),
  (_v) => undefined,
  (_r) => undefined,
  (_r): number => 42,
);
`;
  });
  const tsconfig = makeTsconfig(fixTs, tmp);
  const { exitCode, output } = runTsc(tsconfig);
  const diags = parseTscDiagnostics(output);
  const fixPath = fs.realpathSync(fixTs);
  const fixDiags = diags.filter((d) => {
    try { return fs.realpathSync(d.file) === fixPath; } catch { return false; }
  });
  if (exitCode === 0 || fixDiags.length === 0) {
    // 副指挥 7535c7cb corrective: NO more "unexpected; still
    // passing" — that was the exact loophole that let the
    // cast-trick mutation silently pass. Hard FAIL.
    fail(
      "meta-sanity B",
      `mutation produced no diag (exit=${exitCode}, ${fixDiags.length} fixture diags) — evidence gate has no signal`,
    );
    notes.push("---- meta-sanity B raw tsc output ----");
    notes.push(output.slice(0, 1500));
  } else {
    const src = fs.readFileSync(fixTs, "utf8").split(/\r?\n/);
    const negativeFixtures = FIXTURES.filter((f) => f.kind === "negative");
    // Apply the FULL current filter (code + target line +
    // expectedMessageRegex). None of the negative fixtures
    // should accept this mutation.
    const anyMatched = negativeFixtures.some((fx) => {
      return fixDiags.some((d) => {
        if (!fx.expectedCode.test(d.code)) return false;
        const lineContent = src[d.line - 1] ?? "";
        if (!fx.targetLineRegex.test(lineContent)) return false;
        if (fx.expectedMessageRegex && !fx.expectedMessageRegex.test(d.message)) return false;
        return true;
      });
    });
    if (anyMatched) {
      fail("meta-sanity B: unrelated same-code error on similar line slipped past filter", "");
      notes.push("---- meta-sanity B raw tsc output ----");
      notes.push(output.slice(0, 1500));
    } else {
      const summary = fixDiags.map((d) => `${d.code}@line${d.line}`).join(",");
      ok(`meta-sanity B: real diag emitted (${summary}, exit=${exitCode}) — rejected by ALL negative-fixture filters (code + target-line + message)`);
    }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

// Meta-mutation C (副指挥 7535c7cb): temporarily weakened
// helper contract + same-target-line SAME-CODE error must
// STILL be rejected by the message-binding filter. Copies
// safe-adopt.ts to a temp path, mutates the callback return
// type from `=> undefined` to `=> void` (weakening), imports
// that weakened copy from the fixture, and asserts the
// harness catches this via the message regex — a same-code
// diag with an unrelated message on the SAME target line
// must not pass.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rfc030-safe-adopt-meta-weakened-"));
  // Weakened helper copy — undefined → void on all three
  // callback types.
  const helperSrc = fs.readFileSync(safeAdoptSrc, "utf8");
  const weakenedHelper = helperSrc
    .replace(/export type SafeAdoptFulfilledCallback = \(value: unknown\) => undefined;/, "export type SafeAdoptFulfilledCallback = (value: unknown) => void;")
    .replace(/export type SafeAdoptRejectedCallback = \(reason: unknown\) => undefined;/, "export type SafeAdoptRejectedCallback = (reason: unknown) => void;")
    .replace(/export type SafeAdoptCallbackErrorCallback = \(reason: unknown\) => undefined;/, "export type SafeAdoptCallbackErrorCallback = (reason: unknown) => void;");
  const weakenedPath = path.join(tmp, "safe-adopt.ts");
  fs.writeFileSync(weakenedPath, weakenedHelper, "utf8");
  // Fixture imports from the LOCAL weakened copy AND uses the
  // async-callback shape (which would be legal under the
  // weakened contract). Then it introduces an UNRELATED
  // TS2345 on the exact same target line: too many arguments.
  const fixTs = path.join(tmp, "safe-adopt-negative-async-under-weakened.ts");
  fs.writeFileSync(
    fixTs,
    [
      `// Meta-mutation C — weakened contract (undefined→void) +`,
      `// same-target-line same-CODE UNRELATED error via contravariance.`,
      `// Under weakened contract, an async callback returning`,
      `// Promise<void> is legal (void accepts Promise), so the`,
      `// ORIGINAL contract-violation diag disappears. But we pass a`,
      `// callback whose parameter type is NARROWER (string) than the`,
      `// callback contract's (unknown) → strictFunctionTypes rejects`,
      `// with TS2345 on the SAME target line, but the message is about`,
      `// parameter contravariance ("Type 'unknown' is not assignable to`,
      `// type 'string'."), NOT about the return type. The async-fixture`,
      `// filter's expectedMessageRegex requires "Promise<void>" or`,
      `// "assignable to undefined" — this must NOT match.`,
      `import { safeAdoptConsume } from "./safe-adopt";`,
      `void safeAdoptConsume(Promise.resolve(), async (_v: string) => {});`,
    ].join("\n") + "\n",
    "utf8",
  );
  // tsconfig: fixture only (relative import will resolve to
  // the sibling weakened helper). Bring the whole runtime dir
  // via typeRoots to keep DOM/node types available.
  const tsconfig = makeTsconfig(fixTs, tmp);
  const { exitCode, output } = runTsc(tsconfig);
  const diags = parseTscDiagnostics(output);
  const fixPath = fs.realpathSync(fixTs);
  const fixDiags = diags.filter((d) => {
    try { return fs.realpathSync(d.file) === fixPath; } catch { return false; }
  });
  if (exitCode === 0 || fixDiags.length === 0) {
    fail(
      "meta-sanity C",
      `weakened-contract mutation produced no fixture diag (exit=${exitCode}, ${fixDiags.length} diags) — signal missing`,
    );
    notes.push("---- meta-sanity C raw tsc output ----");
    notes.push(output.slice(0, 1500));
  } else {
    const src = fs.readFileSync(fixTs, "utf8").split(/\r?\n/);
    // Apply the async fixture's FULL filter — code + target
    // line + expectedMessageRegex. Even though the diag is on
    // (roughly) the same-shape target line, its MESSAGE will
    // NOT match `Promise<void>|assignable to undefined`
    // because the error is about a non-callable second arg.
    const asyncFx = FIXTURES.find((f) => f.basename === "safe-adopt-negative-async.ts.fixture");
    const matched = fixDiags.some((d) => {
      if (!asyncFx.expectedCode.test(d.code)) return false;
      const lineContent = src[d.line - 1] ?? "";
      if (!asyncFx.targetLineRegex.test(lineContent)) return false;
      if (asyncFx.expectedMessageRegex && !asyncFx.expectedMessageRegex.test(d.message)) return false;
      return true;
    });
    if (matched) {
      fail("meta-sanity C: weakened contract + unrelated same-code same-line error slipped past filter", "");
      notes.push("---- meta-sanity C raw tsc output ----");
      notes.push(output.slice(0, 1500));
    } else {
      const summary = fixDiags.map((d) => `${d.code}@line${d.line}:${d.message.slice(0, 60)}`).join(" | ");
      ok(`meta-sanity C: weakened contract + same-line same-code UNRELATED error (${summary}) rejected by message-bound async-fixture filter`);
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
