import { describe, expect, test } from "bun:test";
import { createAgyCatalogCache, parseAgyModels, probeAgy } from "./agy-catalog.js";

describe("#5321 agy 模型清单 + 登录状态", () => {
  test("成功：解析模型行，登录态 logged_in", () => {
    const r = probeAgy({ binary: "agy", run: () => ({ status: 0, stdout: "claude-opus-5-5-high\ngemini-4-neon-high\n", stderr: "" }) });
    expect(r.loginState).toBe("logged_in");
    expect(r.models).toEqual(["claude-opus-5-5-high", "gemini-4-neon-high"]);
  });

  test("成功但没有可用模型行 ⇒ 不报清单（不编造）", () => {
    const r = probeAgy({ binary: "agy", run: () => ({ status: 0, stdout: "Available models:\n", stderr: "" }) });
    expect(r.models).toBeNull();
    expect(r.loginState).toBe("logged_in");
  });

  test("明确未登录 ⇒ needs_login、不报模型", () => {
    const r = probeAgy({ binary: "agy", run: () => ({ status: 1, stdout: "", stderr: "Please log in to continue" }) });
    expect(r).toEqual({ models: null, loginState: "needs_login" });
  });

  test("没装 / 命令不存在 / 非登录错误 ⇒ unknown（不是 needs_login）", () => {
    for (const out of [
      { status: null, stdout: "", stderr: "spawnSync agy ENOENT" },
      { status: 127, stdout: "", stderr: "command not found" },
      { status: 1, stdout: "", stderr: "boom" },
    ]) {
      expect(probeAgy({ binary: "agy", run: () => out })).toEqual({ models: null, loginState: "unknown" });
    }
  });

  test("探测本身抛异常 ⇒ unknown（绝不向上抛，心跳不受影响）", () => {
    expect(probeAgy({ binary: "agy", run: () => { throw new Error("kaboom"); } })).toEqual({ models: null, loginState: "unknown" });
  });

  test("缓存：TTL 内不重复探测；未探测过是 unknown", async () => {
    let calls = 0;
    const cache = createAgyCatalogCache({ binary: "agy", run: () => { calls++; return { status: 0, stdout: "m1\n", stderr: "" }; } }, 1000);
    expect(cache.current(1000)).toEqual({ models: null, loginState: "unknown" });
    await cache.refresh(1000);
    expect(calls).toBe(1);
    await cache.refresh(1500);           // TTL 内 ⇒ 不重探
    expect(calls).toBe(1);
    expect(cache.current(1500).models).toEqual(["m1"]);
    await cache.refresh(3000);           // 过期 ⇒ 重探
    expect(calls).toBe(2);
  });

  test("模型行形状：畸形行丢弃，不把说明性文字当模型", () => {
    expect(parseAgyModels("Usage: agy models\nclaude-opus-5-5-high\n[bad line\n")).toEqual(["claude-opus-5-5-high"]);
  });

  test("真机 agy models 制表符两列输出（<slug>\\t<显示名>）正常提取全部模型 slug 并过滤 Fetching 行", () => {
    const stdout = [
      "Fetching available models...",
      "gemini-4-neon-high\tGemini 4 Neon (High)",
      "claude-opus-5-5-high\tClaude Opus 5.5 (High)",
      "gpt-oss-120b-medium  GPT-OSS 120B (Medium)",
      "gemini-4-neon-high\tGemini 4 Neon (High)",
    ].join("\n");
    const r = probeAgy({ binary: "agy", run: () => ({ status: 0, stdout, stderr: "" }) });
    expect(r.loginState).toBe("logged_in");
    expect(r.models).toEqual(["gemini-4-neon-high", "claude-opus-5-5-high", "gpt-oss-120b-medium"]);
  });
});
