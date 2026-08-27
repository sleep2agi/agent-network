// 第 4 条地基 —— runtime → 复用哪种外部登录，单一来源。
//
// 这份知识此前散在三处：Vendor.requiresAuth 的类型联合（"claude"|"codex"，
// 缺 grok）、两行 VENDORS 的字面量、以及 --batch 自定义分支里手写的
// if/else 映射。第三处只覆盖 codex-sdk 与 claude-code-cli，于是 grok /
// codex-app-server 走那条路时会被当成「需要 API key」。
import { describe, expect, test } from "bun:test";
import {
  reusedLoginFor,
  RUNTIME_REUSED_LOGIN,
  SUPPORTED_RUNTIME_NAMES,
  type RuntimeName,
} from "./normalize-runtime";

describe("RUNTIME_REUSED_LOGIN", () => {
  test("Vincent 点名的三类都复用登录，不需要 API key", () => {
    expect(reusedLoginFor("claude-code-cli")).toBe("claude");
    expect(reusedLoginFor("codex-app-server")).toBe("codex");
    expect(reusedLoginFor("grok-build-cli")).toBe("grok");
  });

  test("同一家的两个 runtime 复用同一个登录态", () => {
    expect(reusedLoginFor("codex-sdk")).toBe(reusedLoginFor("codex-app-server"));
    expect(reusedLoginFor("grok-build-acp")).toBe(reusedLoginFor("grok-build-cli"));
  });

  test("🔴 key 型 runtime 必须【不在】表里 —— 这条防的是顺手把 opencode 加进来", () => {
    // opencode 的 vendor preset 从 ANTHROPIC_API_KEY / OPENAI_API_KEY 读，
    // 不复用任何登录；claude-agent-sdk 同理走 token。
    expect(reusedLoginFor("opencode-cli")).toBeUndefined();
    expect(reusedLoginFor("claude-agent-sdk")).toBeUndefined();
  });

  test("表里的键都是合法 runtime 名（防拼错造成永远 undefined）", () => {
    for (const k of Object.keys(RUNTIME_REUSED_LOGIN)) {
      expect(SUPPORTED_RUNTIME_NAMES).toContain(k as RuntimeName);
    }
  });

  test("覆盖面断言：7 个 runtime 每一个都被明确归类，没有漏网的", () => {
    const classified = SUPPORTED_RUNTIME_NAMES.map((rt) => [rt, reusedLoginFor(rt) ?? "api-key"] as const);
    // 分母写死成 7：将来加 runtime 而忘了归类，这里会红并列出全部分类结果。
    expect(classified.length).toBe(7);
    expect(Object.fromEntries(classified)).toEqual({
      "claude-agent-sdk": "api-key",
      "claude-code-cli": "claude",
      "codex-sdk": "codex",
      "codex-app-server": "codex",
      "grok-build-acp": "grok",
      "grok-build-cli": "grok",
      "opencode-cli": "api-key",
    });
  });
});
