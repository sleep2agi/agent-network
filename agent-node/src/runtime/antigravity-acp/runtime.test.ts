import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildAcpInitParams, selectAuthMethod } from "../grok-build-acp/runtime";
import { AGY_AUTH_METHOD_PREFERENCE } from "./runtime";

// 这一层不 spawn：只守「agy 的启动参数与模型策略」这两处差异，真正的 ACP 回合在 CI/真机跑。
const src = readFileSync(new URL("./runtime.ts", import.meta.url), "utf8");

describe("antigravity-acp turn wrapper", () => {
  it("starts `agy acp` instead of grok agent stdio", () => {
    expect(src).toContain("AGY_ACP_ARGV");
    expect(src).toContain("argv: [...AGY_ACP_ARGV]");
  });
  it("does not enforce the grok-only model readback", () => {
    expect(src).toContain("enforceModelReadback: false");
  });
  it("reuses the grok ACP turn implementation (no second protocol copy)", () => {
    expect(src).toContain('from "../grok-build-acp/runtime"');
    expect(src).not.toContain("new GrokAcpClient()");
  });
  it("wires its fixed protocolVersion through to the shared turn call", () => {
    // 弱校验，只守"接线没掉"——真正的类型行为由下面 buildAcpInitParams 的断言守。
    expect(src).toContain("protocolVersion: 1");
  });
});

// 2026-11-20 —— 行为断言，不只是字面量存在。真机踩过的坑：protocolVersion 原来写死
// 成字符串 "1"；grok 的服务端类型宽容所以一直没暴露，agy 是 Go 写的 ACP server，对
// JSON 类型敏感，字符串会报 `-32602 unmarshal string into Go struct field …int`。
// 这里直接断言 typeof，换个位置把 1 写成 "1" 这种回归会被这条测试挡住。
describe("buildAcpInitParams — protocolVersion type", () => {
  it("defaults to the string \"1\" (grok's existing, battle-tested behaviour; unchanged)", () => {
    const params = buildAcpInitParams({ backendToolsHintEnabled: false });
    expect(params.protocolVersion).toBe("1");
    expect(typeof params.protocolVersion).toBe("string");
  });
  it("agy's override is sent as a JSON number, not a string", () => {
    const params = buildAcpInitParams({ protocolVersion: 1, backendToolsHintEnabled: false });
    expect(params.protocolVersion).toBe(1);
    expect(typeof params.protocolVersion).toBe("number");
  });
});

// 2026-11-20 —— 真机踩的第二个坑（跟 protocolVersion 同一类：grok 的逻辑被复用时
// 没考虑 agy 的 method id）：selectAuthMethod() 原来只认 grok 自己的两个 id
// （xai.api_key / cached_token），agy advertise 的 oauth-personal 等从来不在那张表
// 里——于是即使 admin 已经在这台机器上 `agy acp --login` 登录过（真机实测：
// `agy models` 能正常列出模型，证明 keyring 里有有效凭据），headless 回合依然每次
// 报 "no supported non-interactive auth method"：不是没登录，是选择逻辑不认识 agy
// 的方式。行为断言，不是字面量存在性检查。
describe("selectAuthMethod — agy's advertised methods are recognized", () => {
  const advertise = (...ids: string[]) => ({ authMethods: ids.map((id) => ({ id })) });

  it("grok's own two built-in rules are unaffected when no preference list is passed", () => {
    expect(selectAuthMethod(advertise("cached_token"), {})).toBe("cached_token");
    expect(() => selectAuthMethod(advertise("oauth-personal"), {})).toThrow(/no supported non-interactive/);
  });
  it("without a preference list, agy's real advertised methods are rejected (the bug, pinned)", () => {
    expect(() => selectAuthMethod(advertise("oauth-personal", "oauth-business", "gemini-api-key", "agent-platform"), {}))
      .toThrow(/no supported non-interactive auth method/);
  });
  it("with agy's preference list, oauth-personal (a completed human login) is picked first", () => {
    expect(selectAuthMethod(
      advertise("oauth-personal", "oauth-business", "gemini-api-key", "agent-platform"),
      {},
      AGY_AUTH_METHOD_PREFERENCE,
    )).toBe("oauth-personal");
  });
  it("falls through the preference list in order when the first choice isn't advertised", () => {
    expect(selectAuthMethod(advertise("agent-platform"), {}, AGY_AUTH_METHOD_PREFERENCE)).toBe("agent-platform");
  });
  it("never picks gemini-api-key (no env wiring for it yet — selecting it would just fail elsewhere)", () => {
    expect(AGY_AUTH_METHOD_PREFERENCE).not.toContain("gemini-api-key");
  });
});
