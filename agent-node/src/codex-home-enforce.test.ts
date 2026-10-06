import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyNodeCodexHome,
  decodeProcNulBlock,
  descendantPids,
  envVarFromEnviron,
  linuxProcReader,
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

// #448 回归:/proc environ 曾按 latin1 读,非 ASCII 的 CODEX_HOME(节点别名是中文时 nodes/<别名>/codex-home)
// 读出来是 `æµè¯…` 乱码,永远 ≠ 期望值 → fail closed → 该节点每个任务都被拒。
describe("#448 non-ASCII CODEX_HOME: /proc environ is compared byte-correctly", () => {
  const CN_HOME = "/w/.anet/nodes/测试节点/codex-home";
  const OTHER_CN_HOME = "/w/.anet/nodes/另一节点/codex-home";
  const environBytes = (...entries: Array<string | Uint8Array>): Uint8Array => {
    const parts: Uint8Array[] = [];
    for (const e of entries) { parts.push(typeof e === "string" ? Buffer.from(e, "utf8") : e); parts.push(Uint8Array.of(0)); }
    return Buffer.concat(parts);
  };
  // 假的 /proc:给的是**原始字节**,经过和 linuxProcReader 同一个解码器。
  const byteReader = (envs: Record<number, Uint8Array>, parents: Array<[number, number]> = []): ProcReader => ({
    environ: (pid) => envs[pid] ? decodeProcNulBlock(envs[pid]) : null,
    parents: () => parents,
  });

  test("UTF-8 bytes of a Chinese path → ok (root + child)", () => {
    const v = verifyProcessTreeCodexHome({
      rootPid: 10, expected: CN_HOME, label: "owned app-server", platform: "linux",
      reader: byteReader({ 10: environBytes("PATH=/bin", `CODEX_HOME=${CN_HOME}`), 11: environBytes(`CODEX_HOME=${CN_HOME}`) }, [[11, 10]]),
    });
    expect(v).toEqual({ ok: true, checked: [10, 11] });
  });
  test("a different Chinese path → still refused", () => {
    const v = verifyProcessTreeCodexHome({
      rootPid: 10, expected: CN_HOME, label: "owned app-server", platform: "linux",
      reader: byteReader({ 10: environBytes(`CODEX_HOME=${OTHER_CN_HOME}`) }),
    });
    expect(v.ok).toBe(false);
    if (!v.ok) { expect(v.actual).toBe(OTHER_CN_HOME); expect(v.message).toContain(`CODEX_HOME=${OTHER_CN_HOME}, expected ${CN_HOME}`); }
  });
  test("invalid UTF-8 in CODEX_HOME → refused (fail closed), even against an expected value holding U+FFFD", () => {
    const bad = Buffer.concat([Buffer.from("CODEX_HOME=/w/.anet/nodes/", "utf8"), Uint8Array.of(0xff, 0xfe), Buffer.from("/codex-home", "utf8")]);
    for (const expected of [CN_HOME, "/w/.anet/nodes/\uFFFD\uFFFD/codex-home", "/w/.anet/nodes/\u00ff\u00fe/codex-home"]) {
      const v = verifyProcessTreeCodexHome({ rootPid: 10, expected, label: "t", platform: "linux", reader: byteReader({ 10: environBytes("PATH=/bin", bad) }) });
      expect(v.ok).toBe(false);
    }
    // 其余合法条目照常可读。
    expect(envVarFromEnviron(decodeProcNulBlock(environBytes("PATH=/bin", bad)), "PATH")).toBe("/bin");
  });
  test("an expected value that is not a well-formed string is refused outright", () => {
    const v = verifyProcessTreeCodexHome({ rootPid: 10, expected: "/w/\uDFFF", label: "t", platform: "linux", reader: byteReader({ 10: environBytes("CODEX_HOME=/w/") }) });
    expect(v.ok).toBe(false);
  });
  test("the old latin1 decode is exactly the production failure shape", () => {
    const bytes = environBytes(`CODEX_HOME=${CN_HOME}`);
    expect(envVarFromEnviron(Buffer.from(bytes).toString("latin1"), "CODEX_HOME")).not.toBe(CN_HOME);
    expect(envVarFromEnviron(decodeProcNulBlock(bytes), "CODEX_HOME")).toBe(CN_HOME);
  });
  test("decodeProcNulBlock keeps the NUL layout", () => {
    expect(decodeProcNulBlock(new Uint8Array())).toBe("");
    expect(decodeProcNulBlock(environBytes("A=1", "B=中"))).toBe("A=1\0B=中\0");
    expect(decodeProcNulBlock(Buffer.from("A=1\0B=2", "utf8"))).toBe("A=1\0B=2");
    expect(decodeProcNulBlock(Buffer.from("A=1\0\0B=2\0", "utf8"))).toBe("A=1\0\0B=2\0");
  });
});

describe.skipIf(process.platform !== "linux")("#448 real child with a Chinese CODEX_HOME (real /proc)", () => {
  test("linuxProcReader + verifyProcessTreeCodexHome → ok for the node's own non-ASCII home", async () => {
    const root = tmpRoot();
    const home = join(root, ".anet", "nodes", "测试节点", "codex-home");
    mkdirSync(home, { recursive: true });
    const c = spawn("sh", ["-c", "sleep 30 & wait"], { env: { ...process.env, CODEX_HOME: home }, stdio: "ignore" });
    children.push(c);
    for (let i = 0; i < 50 && descendantPids(c.pid!, linuxProcReader.parents()).length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    const v = verifyProcessTreeCodexHome({ rootPid: c.pid!, expected: home, label: "child" });
    expect(v).toEqual({ ok: true, checked: expect.any(Array) });
    if (v.ok) expect(v.checked.length).toBe(2);
    const other = verifyProcessTreeCodexHome({ rootPid: c.pid!, expected: join(root, ".anet", "nodes", "另一节点", "codex-home"), label: "child" });
    expect(other.ok).toBe(false);
  });
});
