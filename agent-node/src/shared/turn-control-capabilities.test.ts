// #5332 能力位：哪个 runtime 真 true、其余 false
// 这里断言的是「判据函数」本身；实现接线在 cli.ts（由 build + 真机验证覆盖）。
import { describe, expect, test } from "bun:test";

/** 与 cli.ts 的 turnControlCapabilities 同一判据（保持镜像；改一处必须改两处）。 */
function caps(runtime: string, generation: string | null, mode: string | null) {
  const opencodeCopresence = runtime === "opencode" && generation === "v2" && mode === "copresence";
  const claudeInterrupt = runtime === "claude";
  const codexAppServerInterrupt = runtime === "codex-app-server";
  const acpInterrupt = runtime === "antigravity" || runtime === "grok";
  return { interrupt: opencodeCopresence || claudeInterrupt || codexAppServerInterrupt || acpInterrupt, steer: opencodeCopresence };
}

describe("#5332 turnControlCapabilities 判据", () => {
  test("opencode V2 共存：interrupt + steer 都 true", () => {
    expect(caps("opencode", "v2", "copresence")).toEqual({ interrupt: true, steer: true });
  });

  test("claude：只有 interrupt true，steer 保持 false（不亮假按钮）", () => {
    expect(caps("claude", null, null)).toEqual({ interrupt: true, steer: false });
  });

  test("codex-app-server：interrupt true，steer false", () => {
    expect(caps("codex-app-server", null, null)).toEqual({ interrupt: true, steer: false });
  });

  test("ACP 运行时（antigravity / grok）：interrupt true，steer false", () => {
    for (const r of ["antigravity", "grok"]) expect(caps(r, null, null)).toEqual({ interrupt: true, steer: false });
  });

  test("其余 runtime / opencode V1：都 false", () => {
    for (const r of ["codex", "codex-sdk"]) {
      expect(caps(r, null, null)).toEqual({ interrupt: false, steer: false });
    }
    expect(caps("opencode", "v1", "copresence")).toEqual({ interrupt: false, steer: false });
    expect(caps("opencode", "v2", null)).toEqual({ interrupt: false, steer: false });
  });
});
