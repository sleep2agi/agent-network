import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildAcpInitParams } from "../grok-build-acp/runtime";

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
