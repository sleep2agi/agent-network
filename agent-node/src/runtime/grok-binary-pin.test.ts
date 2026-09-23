// #1615 钉版:三级优先 + 钉的路径失效时的退回与说明。
// 跑法:cd agent-node && bun test src/runtime/grok-binary-pin.test.ts
import { describe, expect, test } from "bun:test";
import { chooseGrokBinary, grokBinaryPinToRecord } from "./grok-binary-pin";

const exists = (set: string[]) => (p: string) => set.includes(p);

describe("chooseGrokBinary", () => {
  test("GROK_BINARY 环境变量永远优先(既有语义不变)", () => {
    expect(chooseGrokBinary({ env: { GROK_BINARY: "/opt/grok-1.0.5" }, config: { grokBinary: "/home/u/.grok/downloads/grok-1.0.5" }, existsSync: exists(["/home/u/.grok/downloads/grok-1.0.5"]) }))
      .toEqual({ binary: "/opt/grok-1.0.5", source: "env" });
  });
  test("无 env、config 钉了且文件还在 → 用钉的", () => {
    expect(chooseGrokBinary({ env: {}, config: { grokBinary: "/home/u/.grok/downloads/grok-1.0.5" }, existsSync: exists(["/home/u/.grok/downloads/grok-1.0.5"]) }))
      .toEqual({ binary: "/home/u/.grok/downloads/grok-1.0.5", source: "config" });
  });
  test("钉的文件没了 → 退回 PATH,并说清为什么", () => {
    const c = chooseGrokBinary({ env: {}, config: { grokBinary: "/home/u/.grok/downloads/grok-1.0.5" }, existsSync: exists([]) });
    expect(c.binary).toBe("grok"); expect(c.source).toBe("path"); expect(c.warning).toMatch(/no longer exists/);
  });
  test("钉的不是绝对路径 → 无视并说明(防止 config 里塞个 PATH 相对名当钉)", () => {
    const c = chooseGrokBinary({ env: {}, config: { grokBinary: "grok" }, existsSync: exists(["grok"]) });
    expect(c.binary).toBe("grok"); expect(c.warning).toMatch(/not an absolute path/);
  });
  test("什么都没有 → 老行为:PATH 上的 grok", () => {
    expect(chooseGrokBinary({ env: {}, config: null, existsSync: exists([]) })).toEqual({ binary: "grok", source: "path" });
  });
  test("空串 env 不算指定", () => {
    expect(chooseGrokBinary({ env: { GROK_BINARY: "  " }, config: null, existsSync: exists([]) }).source).toBe("path");
  });
});

describe("grokBinaryPinToRecord", () => {
  test("只记绝对路径", () => {
    expect(grokBinaryPinToRecord("grok", "grok 1.0.5 (5115b46bc9)")).toBeNull();
    expect(grokBinaryPinToRecord("/home/u/.grok/downloads/grok-1.0.5", "grok 1.0.5 (5115b46bc9) [stable]\n"))
      .toEqual({ grokBinary: "/home/u/.grok/downloads/grok-1.0.5", grokBinaryVersion: "grok 1.0.5 (5115b46bc9) [stable]" });
  });
});

// ── #1615 恢复提示:在本机找验证过的旧 build 并写进报错 ─────────────────────────
import { findVerifiedGrokCandidates, grokRecoveryHint } from "./grok-binary-pin";

describe("#1615 recovery hint for an unverified PATH grok", () => {
  const fs: Record<string, string[]> = {
    "/h/.grok/downloads": ["grok-1.0.13-linux-x86_64", "grok-1.0.5-linux-x86_64", "grok-x.part", "notes.txt"],
    "/h/.grok/bin": ["grok", "grok-1.0.5"],
  };
  const versions: Record<string, string> = {
    "/h/.grok/downloads/grok-1.0.13-linux-x86_64": "grok 1.0.13 (5e9a58528b76)",
    "/h/.grok/downloads/grok-1.0.5-linux-x86_64": "grok 1.0.5 (5115b46bc9)",
    "/h/.grok/bin/grok": "grok 1.0.13 (5e9a58528b76)",
    "/h/.grok/bin/grok-1.0.5": "grok 1.0.5 (5115b46bc9)",
  };
  const verified = new Set(["grok 1.0.5 (5115b46bc9)"]);
  const base = {
    home: "/h",
    listDir: (d: string) => { if (!(d in fs)) throw new Error("ENOENT"); return fs[d]!; },
    isRegularFile: (p: string) => p in versions,
    probeVersion: (p: string) => versions[p],
    isVerified: (v: string) => verified.has(v),
  };

  test("finds only verified builds, skips partial downloads and the failing binary", () => {
    const c = findVerifiedGrokCandidates({ ...base, exclude: "/h/.grok/bin/grok" });
    expect(c.map((x) => x.path)).toEqual(["/h/.grok/downloads/grok-1.0.5-linux-x86_64", "/h/.grok/bin/grok-1.0.5"]);
    expect(c.every((x) => x.version === "grok 1.0.5 (5115b46bc9)")).toBe(true);
  });

  test("the hint is a copyable command naming the node alias", () => {
    const c = findVerifiedGrokCandidates(base);
    const h = grokRecoveryHint(c, "grok-node-a");
    expect(h).toContain("GROK_BINARY=/h/.grok/downloads/grok-1.0.5-linux-x86_64 anet node start grok-node-a");
    expect(h).toContain("pins it on the next successful start");
  });

  test("missing directories and no verified builds give an explicit no-candidate hint, not a throw", () => {
    const none = findVerifiedGrokCandidates({ ...base, home: "/nowhere" });
    expect(none).toEqual([]);
    expect(grokRecoveryHint(none, undefined)).toContain("No verified grok build was found");
  });

  test("probe budget bounds the number of --version calls", () => {
    let calls = 0;
    findVerifiedGrokCandidates({ ...base, isVerified: () => false, probeVersion: (p) => { calls++; return versions[p]; }, maxProbes: 2 });
    expect(calls).toBe(2);
  });
});
