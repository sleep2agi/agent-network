import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

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
  it("sends protocolVersion as a number (agy's Go ACP server rejects grok's string \"1\")", () => {
    // 真机实测 2026-11-20：不传这个会报 -32602 unmarshal string into Go struct field …int。
    expect(src).toContain("protocolVersion: 1");
  });
});
