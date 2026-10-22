// #2028 —— 结构化失败码优先于「文本里有 vendor 特征」的重放判定。
//
// 背景：processTask 把 think() 的失败压成回复文本，通用 vendor 重放只看
// 文本 + failed 布尔。OpenCode 的 timeout / ownership / provider 失败只要
// 文本里带 vendor 特征（例如同时出现 "错误" 与 "API error"）就会被重放，
// 等于绕过 runtime 的归属与副作用判断。这里锁定：结构化码命中时一律不重放。
import { describe, expect, test } from "bun:test";
import { isNonReplayableRuntimeFailure, isTransientVendorError } from "./vendor-error";

// 同时命中 ≥2 个 vendor 特征、且不含 401/403/quota/429 的文本：
// 在只按文本判定的旧实现里它一定会触发重放（这正是我们要拦的场景）。
const VENDORISH = 'claude 错误: "error":{"type":"invalid_request"} "choices":null';

describe("isNonReplayableRuntimeFailure", () => {
  test("known OpenCode runtime failures are non-replayable", () => {
    for (const code of [
      "opencode_copresence_timeout",
      "opencode_copresence_owner_left",
      "opencode_provider_error",
      "opencode_v1_borrowed_admission_refused",
      "opencode_v1_borrowed_cli_refused",
      "opencode_v1_host_admission_refused",
      "opencode_v1_host_start_refused",
      "opencode_v1_migration_plan_refused",
      "opencode_v1_owned_safe_topology_refused",
    ]) {
      expect(isNonReplayableRuntimeFailure(code)).toBe(true);
    }
  });

  test("unknown or missing codes do not change the existing vendor policy", () => {
    for (const code of [undefined, null, "", "codex_task_skipped", "some_unknown_code", 42]) {
      expect(isNonReplayableRuntimeFailure(code)).toBe(false);
    }
  });
});

describe("isTransientVendorError with a structured runtime code", () => {
  test("the vendor-ish text alone still triggers the existing retry (baseline)", () => {
    expect(isTransientVendorError(VENDORISH, true)).toBe(true);
  });

  test("a structured OpenCode failure suppresses the vendor replay", () => {
    expect(isTransientVendorError(VENDORISH, true, "opencode_copresence_timeout")).toBe(false);
    expect(isTransientVendorError(VENDORISH, true, "opencode_copresence_owner_left")).toBe(false);
    expect(isTransientVendorError(VENDORISH, true, "opencode_provider_error")).toBe(false);
    expect(isTransientVendorError(VENDORISH, true, "opencode_v1_host_start_refused")).toBe(false);
  });

  test("no runtime code keeps the old behaviour for genuine vendor blips", () => {
    expect(isTransientVendorError(VENDORISH, true, null)).toBe(true);
    expect(isTransientVendorError(VENDORISH, true, "")).toBe(true);
    expect(isTransientVendorError(VENDORISH, true, "codex_task_skipped")).toBe(true);
  });

  test("auth/quota/rate-limit exclusions are unchanged", () => {
    expect(isTransientVendorError(`${VENDORISH} 401`, true)).toBe(false);
    expect(isTransientVendorError(`${VENDORISH} quota`, true)).toBe(false);
    expect(isTransientVendorError(`${VENDORISH} 429`, true)).toBe(false);
  });
});
