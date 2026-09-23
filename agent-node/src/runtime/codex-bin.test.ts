// #1969 — codex binary selection for the codex-sdk runtime.
// Real fake `codex` executables (shell scripts) are used so the version probe,
// its timeout and its failure fall-through are exercised for real.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, accessSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bundledCodexVersion,
  compareCodexVersions,
  createCodex,
  formatCodexBinLog,
  parseCodexVersion,
  probeCodexVersion,
  resolveCodexBin,
  whichCodexOnPath,
} from "./codex-bin";

const root = mkdtempSync(join(tmpdir(), "codex-bin-1969-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function fakeCodex(name: string, body: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "codex");
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

const v155 = fakeCodex("v155", 'echo "codex-cli 0.155.1"');
const v120 = fakeCodex("v120", 'echo "codex-cli 0.120.0"');
const v133 = fakeCodex("v133", 'echo "codex-cli 0.133.0"');
const broken = fakeCodex("broken", "exit 3");
const slow = fakeCodex("slow", 'sleep 5; echo "codex-cli 9.9.9"');
const garbage = fakeCodex("garbage", 'echo "hello"');

describe("#1969 codex binary selection", () => {
  test("parses and compares codex versions numerically", () => {
    expect(parseCodexVersion("codex-cli 0.155.1")).toBe("0.155.1");
    expect(parseCodexVersion("0.133.0-linux-x64")).toBe("0.133.0");
    expect(parseCodexVersion("nope")).toBeUndefined();
    expect(compareCodexVersions("0.155.1", "0.133.0")).toBeGreaterThan(0);
    expect(compareCodexVersions("0.99.0", "0.133.0")).toBeLessThan(0); // numeric, not lexical
    expect(compareCodexVersions("0.133.0", "0.133.0")).toBe(0);
  });

  test("real probe: reads --version, fails through on non-zero exit, garbage and timeout", () => {
    expect(probeCodexVersion(v155, 2000)).toBe("0.155.1");
    expect(probeCodexVersion(broken, 2000)).toBeUndefined();
    expect(probeCodexVersion(garbage, 2000)).toBeUndefined();
    const t0 = Date.now();
    expect(probeCodexVersion(slow, 300)).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(probeCodexVersion(join(root, "missing", "codex"), 2000)).toBeUndefined();
  });

  test("selection order: config beats env beats PATH beats bundled", () => {
    const base = { bundledVersion: "0.133.0", timeoutMs: 2000 };
    expect(resolveCodexBin({ ...base, configBin: v120, envBin: v155, pathBin: v155 })).toMatchObject({ path: v120, source: "config", version: "0.120.0" });
    expect(resolveCodexBin({ ...base, envBin: v120, pathBin: v155 })).toMatchObject({ path: v120, source: "env" });
    expect(resolveCodexBin({ ...base, pathBin: v155 })).toMatchObject({ path: v155, source: "path", version: "0.155.1" });
    { const b = resolveCodexBin({ ...base }); expect(b).toMatchObject({ source: "bundled", version: "0.133.0" }); expect(b.path).toBeUndefined(); }
  });

  test("a PATH codex older than the bundled one is never chosen; equal is allowed", () => {
    const older = resolveCodexBin({ pathBin: v120, bundledVersion: "0.133.0", timeoutMs: 2000 });
    expect(older.source).toBe("bundled");
    expect(older.path).toBeUndefined();
    expect(older.skipped.join("\n")).toContain("older than bundled 0.133.0");
    expect(resolveCodexBin({ pathBin: v133, bundledVersion: "0.133.0", timeoutMs: 2000 }).source).toBe("path");
    // Unknown bundled version: do not guess, keep the SDK default.
    expect(resolveCodexBin({ pathBin: v155, bundledVersion: undefined, timeoutMs: 2000 }).source).toBe("bundled");
  });

  test("probe failures and timeouts fall through to the next option", () => {
    const r = resolveCodexBin({ configBin: broken, envBin: slow, pathBin: v155, bundledVersion: "0.133.0", timeoutMs: 300 });
    expect(r).toMatchObject({ path: v155, source: "path" });
    expect(r.skipped.length).toBe(2);
    expect(r.skipped[0]).toContain("config");
    expect(r.skipped[1]).toContain("env");
    // blank / non-string config values are ignored, not probed
    expect(resolveCodexBin({ configBin: "  ", envBin: "", pathBin: undefined, bundledVersion: "0.133.0" }).source).toBe("bundled");
    expect(resolveCodexBin({ configBin: 42 as unknown, bundledVersion: "0.133.0" }).source).toBe("bundled");
  });

  test("whichCodexOnPath walks PATH in order and needs an executable", () => {
    const isX = (p: string) => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } };
    const dirs = [join(root, "missing"), join(root, "v120"), join(root, "v155")].join(":");
    expect(whichCodexOnPath(dirs, isX)).toBe(v120);
    expect(whichCodexOnPath(undefined, isX)).toBeUndefined();
  });

  test("the chosen override reaches the SDK constructor; bundled passes none", () => {
    const seen: any[] = [];
    class FakeCodex { constructor(opts: any) { seen.push(opts); } }
    const cfg = { model_auto_compact_token_limit: 1 };
    createCodex(FakeCodex as any, cfg, { path: v155, version: "0.155.1", source: "path", skipped: [] });
    createCodex(FakeCodex as any, cfg, { version: "0.133.0", source: "bundled", skipped: [] });
    expect(seen[0]).toEqual({ config: cfg, codexPathOverride: v155 });
    expect(seen[1]).toEqual({ config: cfg });
    expect("codexPathOverride" in seen[1]).toBe(false);
  });

  test("startup log line has path, version and source", () => {
    expect(formatCodexBinLog({ path: "/x/codex", version: "0.155.1", source: "env", skipped: [] }))
      .toBe("[codex] binary: /x/codex (0.155.1) source=env");
    expect(formatCodexBinLog({ version: "0.133.0", source: "bundled", skipped: [] }))
      .toBe("[codex] binary: (bundled @openai/codex) (0.133.0) source=bundled");
  });

  test("cli.ts constructs every Codex through the resolver seam", () => {
    const src = readFileSync(join(import.meta.dir, "..", "cli.ts"), "utf8");
    const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
    expect(code).not.toMatch(/new\s+(sdkMod\.)?Codex\s*\(/);
    expect((code.match(/createCodex\((sdkMod\.)?Codex, CODEX_CONFIG, getCodexBinResolution\(\)\)/g) ?? []).length).toBe(3);
  });
});

describe("#1969 bundled codex version lookup (Node resolution, exports maps ignored)", () => {
  test("finds the codex the SDK sits next to, nested before hoisted", () => {
    const base = mkdtempSync(join(tmpdir(), "codex-bin-layout-"));
    try {
      const pkg = (dir: string, version: string, exportsMap?: object) => {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version, ...(exportsMap ? { exports: exportsMap } : {}) }));
      };
      const app = join(base, "lib", "node_modules", "@sleep2agi", "agent-node");
      mkdirSync(join(app, "dist"), { recursive: true });
      pkg(join(app, "node_modules", "@openai", "codex-sdk"), "0.133.0", { ".": { import: "./dist/index.js" } });
      pkg(join(base, "lib", "node_modules", "@openai", "codex"), "0.155.1", { ".": "./bin/codex.js" });
      const from = new URL(`file://${join(app, "dist", "cli.js")}`).href;
      // hoisted codex (the old global layout)
      expect(bundledCodexVersion(from)).toBe("0.155.1");
      // nested codex wins over hoisted (the clean-install layout from #1969)
      pkg(join(app, "node_modules", "@openai", "codex"), "0.133.0", { ".": "./bin/codex.js" });
      expect(bundledCodexVersion(from)).toBe("0.133.0");
      // no sdk at all → unknown
      expect(bundledCodexVersion(new URL(`file://${join(base, "elsewhere", "x.js")}`).href)).toBeUndefined();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
