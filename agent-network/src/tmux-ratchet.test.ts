import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

// #505 ratchet — every tmux invocation goes through src/tmux.ts (agent-network)
// or its byte-identical copy agent-node/src/tmux.ts. A raw
// `execFileSync("tmux", …)` / `spawn("tmux", …)` / `execSync("tmux …")`
// bypasses the socket isolation and the kill-server refusal.
//
// Existing TEST files that call tmux directly are allowlisted; each was read
// for #505: the -L ones use a private server; the others only touch sessions
// they name themselves and never kill-server. The list may only shrink — a
// stale entry is red so it gets removed.

const REPO = join(import.meta.dir, "..", "..");
const ROOTS = ["agent-network/bin", "agent-network/src", "agent-network/tests", "agent-node/src"];
const EXTENSIONS = /\.(ts|mts|cts|js|mjs|cjs|tsx)$/;

const HELPERS = new Set(["agent-network/src/tmux.ts", "agent-node/src/tmux.ts"]);
/** This file holds raw-call samples for the criterion selftest. */
const SELF = "agent-network/src/tmux-ratchet.test.ts";
const ALLOWLIST = new Set([
  "agent-network/src/codex-copresence-launch-readiness.test.ts",
  "agent-network/src/codex-home-tmux-server-env.test.ts", // -L private socket
  "agent-network/src/tmux-exact-target.test.ts",
  "agent-network/src/tmux-pane-target.test.ts",
  "agent-node/src/runtime/opencode-copresence/attach-tui.test.ts", // -L private socket
]);

/** A call whose program is the literal tmux: execFileSync("tmux", …), spawn(`tmux …`), execSync('tmux …'), … */
const RAW_TMUX_CALL = /\b(?:execFileSync|execFile|spawnSync|spawn|execSync|exec)\s*\(\s*["'`]tmux(?=["'`\s])/;

function stripLineComment(line: string): string {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") ? "" : line;
}

export function findRawTmuxCalls(source: string): number[] {
  const hits: number[] = [];
  source.split("\n").forEach((line, i) => {
    if (RAW_TMUX_CALL.test(stripLineComment(line))) hits.push(i + 1);
  });
  // multi-line form: `execFileSync(\n  "tmux",`
  const multi = /\b(?:execFileSync|execFile|spawnSync|spawn|execSync|exec)\s*\(\s*\n\s*["'`]tmux(?=["'`\s])/g;
  for (let m; (m = multi.exec(source)); ) hits.push(source.slice(0, m.index).split("\n").length);
  return [...new Set(hits)].sort((a, b) => a - b);
}

export function collectSources(repo: string, roots: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (EXTENSIONS.test(name)) out.push(relative(repo, p));
    }
  };
  for (const r of roots) walk(join(repo, r));
  return out.sort();
}

describe("#505 tmux ratchet — criterion", () => {
  test("flags each raw form", () => {
    for (const src of [
      `execFileSync("tmux", ["kill-server"])`,
      `spawnSync('tmux', ["-V"])`,
      "spawn(`tmux`, args)",
      `execSync("tmux list-sessions")`,
      `const x = execFileSync(\n  "tmux",\n  ["new-session"])`,
    ]) expect(findRawTmuxCalls(src).length).toBe(1);
  });

  test("does not flag the helper, comments, or other programs", () => {
    for (const src of [
      `execTmux(["list-sessions"])`,
      `// execFileSync("tmux", ["kill-server"])`,
      ` * spawn("tmux", args)`,
      `execFileSync("tmuxinator", [])`,
      `execFileSync("ss", ["-ltn"])`,
    ]) expect(findRawTmuxCalls(src)).toEqual([]);
  });
});

describe("#505 tmux ratchet — collection", () => {
  test("recurses into nested directories and skips node_modules", () => {
    const repo = mkdtempSync(join(tmpdir(), "anet-tmux-ratchet-"));
    try {
      mkdirSync(join(repo, "pkg/src/runtime/deep"), { recursive: true });
      mkdirSync(join(repo, "pkg/src/node_modules/x"), { recursive: true });
      writeFileSync(join(repo, "pkg/src/runtime/deep/a.ts"), "");
      writeFileSync(join(repo, "pkg/src/b.mjs"), "");
      writeFileSync(join(repo, "pkg/src/node_modules/x/c.ts"), "");
      expect(collectSources(repo, ["pkg/src"])).toEqual(["pkg/src/b.mjs", "pkg/src/runtime/deep/a.ts"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("the real scan sees the known call sites (denominator is not empty)", () => {
    const files = collectSources(REPO, ROOTS);
    expect(files.length).toBeGreaterThan(300);
    for (const known of [
      "agent-network/bin/cli.ts",
      "agent-node/src/runtime/opencode-copresence/attach-tui.ts",
      ...HELPERS,
      ...ALLOWLIST,
      SELF,
    ]) expect(files).toContain(known);
  });
});

describe("#505 tmux ratchet — repo", () => {
  const offenders: string[] = [];
  const allowHits = new Set<string>();
  for (const f of collectSources(REPO, ROOTS)) {
    if (HELPERS.has(f) || f === SELF) continue;
    const hits = findRawTmuxCalls(readFileSync(join(REPO, f), "utf8"));
    if (hits.length === 0) continue;
    if (ALLOWLIST.has(f)) { allowHits.add(f); continue; }
    offenders.push(`${f}:${hits.join(",")}`);
  }

  test("no raw tmux invocation outside src/tmux.ts", () => {
    // Fix: import { execTmux, spawnSyncTmux, spawnTmux } from "<pkg>/src/tmux".
    expect(offenders).toEqual([]);
  });

  test("allowlist has no stale entries (it only shrinks)", () => {
    expect([...ALLOWLIST].filter((f) => !allowHits.has(f))).toEqual([]);
  });
});

describe("#505 helper copies are byte-identical across packages", () => {
  test("agent-network/src/tmux.ts == agent-node/src/tmux.ts", () => {
    const ours = readFileSync(join(REPO, "agent-network/src/tmux.ts"), "utf8");
    const theirs = readFileSync(join(REPO, "agent-node/src/tmux.ts"), "utf8");
    expect(ours.length).toBeGreaterThan(1000);
    expect(ours).toBe(theirs);
  });

  test("the helper imports nothing package-local", () => {
    const src = readFileSync(join(REPO, "agent-network/src/tmux.ts"), "utf8");
    const specs = src.split("\n").filter((l) => /^\s*}?\s*from\s+["']|^import .* from ["']/.test(l))
      .map((l) => l.match(/["']([^"']+)["']/)?.[1]);
    expect(specs.length).toBeGreaterThan(0);
    for (const s of specs) expect(s?.startsWith("node:")).toBe(true);
  });
});
