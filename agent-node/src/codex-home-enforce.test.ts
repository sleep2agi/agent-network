import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyNodeCodexHome,
  descendantPids,
  envVarFromEnviron,
  looksLikeAnetNodeCodexHome,
  resolveNodeCodexHome,
  verifyProcessTreeCodexHome,
  type ProcReader,
} from "./codex-home-enforce";

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) { try { c.kill("SIGKILL"); } catch {} }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function tmpRoot(): string {
  const r = mkdtempSync(join(tmpdir(), "anet-448-"));
  roots.push(r);
  return r;
}

describe("#448 resolveNodeCodexHome — only the node's own config/dir decide", () => {
  test("co-presence node → <nodeDir>/codex-home even before the dir exists", () => {
    const r = resolveNodeCodexHome({ nodeDir: "/w/.anet/nodes/a", config: { codexCopresence: true }, exists: () => false });
    expect(r).toEqual({ codexHome: "/w/.anet/nodes/a/codex-home", source: "node-codex-home" });
  });
  test("existing <nodeDir>/codex-home wins for a node without the flag", () => {
    const r = resolveNodeCodexHome({ nodeDir: "/w/.anet/nodes/a", config: {}, exists: (p) => p === "/w/.anet/nodes/a/codex-home" });
    expect(r.source).toBe("node-codex-home");
  });
  test("persisted config.codexHome outranks the default dir", () => {
    const r = resolveNodeCodexHome({ nodeDir: "/w/.anet/nodes/a", config: { codexHome: "/custom/home", codexCopresence: true }, exists: () => true });
    expect(r).toEqual({ codexHome: "/custom/home", source: "config.codexHome" });
  });
  test("profile env CODEX_HOME (a plain string) is the node's own config", () => {
    const r = resolveNodeCodexHome({ nodeDir: "/w/.anet/nodes/a", config: { env: { CODEX_HOME: "/p/home" } }, exists: () => false });
    expect(r).toEqual({ codexHome: "/p/home", source: "config.env" });
  });
  test("relative / envRef-shaped values are ignored, not trusted", () => {
    const r = resolveNodeCodexHome({ nodeDir: "/w/.anet/nodes/a", config: { codexHome: "rel", env: { CODEX_HOME: { _envRef: "X" } } }, exists: () => false });
    expect(r).toEqual({ codexHome: null, source: "none" });
  });
  test("the process environment never participates", () => {
    const before = process.env.CODEX_HOME;
    process.env.CODEX_HOME = "/w/.anet/nodes/OTHER/codex-home";
    try {
      const r = resolveNodeCodexHome({ nodeDir: "/w/.anet/nodes/a", config: {}, exists: () => false });
      expect(r.codexHome).toBeNull();
    } finally {
      if (before === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = before;
    }
  });
});

describe("#448 applyNodeCodexHome", () => {
  test("a wrong inherited CODEX_HOME is overwritten with the node's own and said out loud", () => {
    const env: Record<string, string | undefined> = { CODEX_HOME: "/w/.anet/nodes/OTHER/codex-home" };
    const r = applyNodeCodexHome(env, { codexHome: "/w/.anet/nodes/a/codex-home", source: "node-codex-home" });
    expect(env.CODEX_HOME).toBe("/w/.anet/nodes/a/codex-home");
    expect(r.note).toContain("not this node's");
  });
  test("matching inherited value → no note", () => {
    const env: Record<string, string | undefined> = { CODEX_HOME: "/w/.anet/nodes/a/codex-home" };
    expect(applyNodeCodexHome(env, { codexHome: "/w/.anet/nodes/a/codex-home", source: "node-codex-home" }).note).toBeNull();
  });
  test("no own home + inherited another node's home → dropped", () => {
    const env: Record<string, string | undefined> = { CODEX_HOME: "/w/.anet/nodes/OTHER/codex-home" };
    const r = applyNodeCodexHome(env, { codexHome: null, source: "none" });
    expect("CODEX_HOME" in env).toBe(false);
    expect(r.codexHome).toBeUndefined();
    expect(r.note).toContain("another anet node");
  });
  test("no own home + operator's own plain path → kept (plain codex nodes unchanged), but named", () => {
    const env: Record<string, string | undefined> = { CODEX_HOME: "/srv/codex" };
    const r = applyNodeCodexHome(env, { codexHome: null, source: "none" });
    expect(env.CODEX_HOME).toBe("/srv/codex");
    expect(r.note).toContain("launching environment");
  });
  test("looksLikeAnetNodeCodexHome: positive and negative controls", () => {
    expect(looksLikeAnetNodeCodexHome("/x/.anet/nodes/b/codex-home")).toBe(true);
    expect(looksLikeAnetNodeCodexHome("/x/.anet/nodes/b/codex-home/")).toBe(true);
    expect(looksLikeAnetNodeCodexHome("/x/.codex")).toBe(false);
    expect(looksLikeAnetNodeCodexHome("/x/.anet/nodes/b")).toBe(false);
  });
});

describe("#448 verifyProcessTreeCodexHome (fake /proc)", () => {
  const reader = (envs: Record<number, string | null>, parents: Array<[number, number]>): ProcReader => ({
    environ: (pid) => envs[pid] ?? null,
    parents: () => parents,
  });
  const env = (h?: string) => ["PATH=/bin", ...(h === undefined ? [] : [`CODEX_HOME=${h}`])].join("\0") + "\0";

  test("root + descendants all match → ok, lists what it checked", () => {
    const v = verifyProcessTreeCodexHome({
      rootPid: 10, expected: "/a", label: "t", platform: "linux",
      reader: reader({ 10: env("/a"), 11: env("/a"), 12: env() }, [[11, 10], [12, 11], [99, 1]]),
    });
    expect(v).toEqual({ ok: true, checked: [10, 11] });
  });
  test("root mismatch → refuses and names both values", () => {
    const v = verifyProcessTreeCodexHome({ rootPid: 10, expected: "/a", label: "app-server", platform: "linux", reader: reader({ 10: env("/b") }, []) });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.message).toBe("app-server pid 10 runs with CODEX_HOME=/b, expected /a");
  });
  test("root without CODEX_HOME is a mismatch, not a pass", () => {
    const v = verifyProcessTreeCodexHome({ rootPid: 10, expected: "/a", label: "t", platform: "linux", reader: reader({ 10: env() }, []) });
    expect(v.ok).toBe(false);
  });
  test("a grandchild carrying another node's home is caught", () => {
    const v = verifyProcessTreeCodexHome({
      rootPid: 10, expected: "/a", label: "bridge", platform: "linux",
      reader: reader({ 10: env("/a"), 11: env("/a"), 12: env("/other") }, [[11, 10], [12, 11]]),
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.pid).toBe(12);
  });
  test("unreadable root / non-linux → skipped (must be printed, never silently green)", () => {
    const a = verifyProcessTreeCodexHome({ rootPid: 10, expected: "/a", label: "t", platform: "linux", reader: reader({}, []) });
    expect(a).toEqual({ ok: true, checked: [], skipped: "pid 10 environ unreadable" });
    const b = verifyProcessTreeCodexHome({ rootPid: 10, expected: "/a", label: "t", platform: "win32" });
    expect(b.ok && b.skipped).toContain("not linux");
  });
  test("helpers", () => {
    expect(envVarFromEnviron(null, "X")).toBeUndefined();
    expect(envVarFromEnviron("A=1\0X=2\0", "X")).toBe("2");
    expect(envVarFromEnviron("A=1\0XX=2\0", "X")).toBeNull();
    expect(descendantPids(1, [[2, 1], [3, 2], [4, 9], [2, 1]])).toEqual([2, 3]);
  });
});

describe.skipIf(process.platform !== "linux")("#448 real child: env carries a WRONG CODEX_HOME, the child still gets the node's own", () => {
  const spawnSleeper = (env: NodeJS.ProcessEnv): ChildProcess => {
    // 带一个孙进程,覆盖「后代也要核对」那一层。
    const c = spawn("sh", ["-c", "sleep 30 & wait"], { env, stdio: "ignore" });
    children.push(c);
    return c;
  };
  const waitForChildren = async (pid: number) => {
    for (let i = 0; i < 50; i++) {
      const { linuxProcReader } = await import("./codex-home-enforce");
      if (descendantPids(pid, linuxProcReader.parents()).length > 0) return;
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  test("applyNodeCodexHome on the spawn env → /proc environ of the child tree is the node's own", async () => {
    const root = tmpRoot();
    const nodeDir = join(root, ".anet", "nodes", "mine");
    mkdirSync(join(nodeDir, "codex-home"), { recursive: true });
    const wrong = join(root, ".anet", "nodes", "neighbour", "codex-home");
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: wrong };
    const resolution = resolveNodeCodexHome({ nodeDir, config: {} });
    applyNodeCodexHome(env as Record<string, string | undefined>, resolution);
    const child = spawnSleeper(env);
    await waitForChildren(child.pid!);
    const v = verifyProcessTreeCodexHome({ rootPid: child.pid!, expected: join(nodeDir, "codex-home"), label: "child" });
    expect(v).toEqual({ ok: true, checked: expect.any(Array) });
    if (v.ok) expect(v.checked.length).toBe(2); // sh + sleep
  });

  test("witnessed red: the same spawn WITHOUT the fix is refused by the /proc check", async () => {
    const root = tmpRoot();
    const nodeDir = join(root, ".anet", "nodes", "mine");
    const wrong = join(root, ".anet", "nodes", "neighbour", "codex-home");
    const child = spawnSleeper({ ...process.env, CODEX_HOME: wrong });
    await waitForChildren(child.pid!);
    const v = verifyProcessTreeCodexHome({ rootPid: child.pid!, expected: join(nodeDir, "codex-home"), label: "child" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.actual).toBe(wrong);
  });
});
