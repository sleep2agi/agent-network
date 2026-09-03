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
