import { describe, expect, test } from "bun:test";
import { runtimeIsOpencode } from "./opencode-runtime.js";

describe("runtimeIsOpencode (#3641/#4825 共用判定)", () => {
  test("opencode* 是 OpenCode", () => {
    expect(runtimeIsOpencode({ runtime: "opencode-sdk" })).toBe(true);
    expect(runtimeIsOpencode({ runtime: "opencode-cli" })).toBe(true);
  });
  test("runtime 为空 → 不能判死", () => {
    expect(runtimeIsOpencode({ runtime: "" })).toBe(true);
    expect(runtimeIsOpencode({ runtime: null })).toBe(true);
  });
  test("runtime 空但报了代际 / opencode_server → 仍是 OpenCode", () => {
    expect(runtimeIsOpencode({ runtime: null, generation: "v2" })).toBe(true);
    expect(runtimeIsOpencode({ runtime: "", opencodeServer: "http://127.0.0.1:4096" })).toBe(true);
  });
  test("明确不是 opencode* → false", () => {
    expect(runtimeIsOpencode({ runtime: "codex-cli" })).toBe(false);
    expect(runtimeIsOpencode({ runtime: "codex-app-server-sdk" })).toBe(false);
    expect(runtimeIsOpencode({ runtime: "grok-sdk" })).toBe(false);
  });
});
