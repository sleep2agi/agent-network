import { describe, expect, test } from "bun:test";
import {
  CAPACITY_RETRY_BACKOFF_MS,
  CAPACITY_RETRY_EXHAUSTED_TEXT,
  CAPACITY_RETRY_LIMIT,
  CAPACITY_RETRY_SIDE_EFFECT_TEXT,
  capacityRetryDecision,
  capacityRetryProgress,
  isCodexSideEffectItem,
  isOpencodeSideEffectPart,
  isRetryableCapacityError,
} from "./capacity-retry";

describe("capacity retry classifier", () => {
  test("retries temporary capacity, overload, 429, rate limit, and 5xx", () => {
    const retryable = [
      "Selected model is at capacity. Please try a different model.",
      "at capacity",
      "overloaded",
      "overloaded_error",
      "429",
      "error 429",
      "rate limit",
      "rate_limit",
      "rate-limit exceeded",
      "too many requests",
      "HTTP 500",
      "HTTP 503",
      "status 502",
      "internal server error",
      "bad gateway",
      "service unavailable",
      "gateway timeout",
      "503 Service",
      "HTTP/1.1 503",
      "status code 500",
      "status: 502",
    ];
    for (const text of retryable) {
      expect(isRetryableCapacityError(text)).toBe(true);
    }
  });

  test("does not retry auth, quota, durations, or a bare model-switch hint", () => {
    const permanent = [
      "",
      "401",
      "403 forbidden",
      "unauthorized",
      "invalid api key",
      "authentication_error",
      "insufficient_quota",
      "quota exceeded",
      "quota exhausted",
      "usage limit",
      "out of credits",
      "billing",
      "payment required",
      "503 insufficient_quota",
      "capacity-exceeded",
      "regional capacity-exceeded",
      "please try a different model",
      "took 500ms",
      "waited 503 ms",
      "5000",
      "error 5000",
      "503",
      "line 503",
      "port 500",
      "error 503",
      "http://127.0.0.1:500",
    ];
    for (const text of permanent) {
      expect(isRetryableCapacityError(text)).toBe(false);
    }
  });

  test("backoff is 30s, 60s, 120s, then one exhausted failure", () => {
    expect(CAPACITY_RETRY_LIMIT).toBe(3);
    expect([...CAPACITY_RETRY_BACKOFF_MS]).toEqual([30_000, 60_000, 120_000]);
    const raw = "Selected model is at capacity. Please try a different model.";
    expect(capacityRetryDecision(0, raw)).toEqual({
      action: "retry",
      attempt: 1,
      waitMs: 30_000,
      progress: "模型满载，第 1 次重试中",
    });
    expect(capacityRetryDecision(1, raw).action === "retry" && capacityRetryDecision(1, raw)).toMatchObject({
      attempt: 2,
      waitMs: 60_000,
      progress: capacityRetryProgress(2),
    });
    expect(capacityRetryDecision(2, raw)).toMatchObject({ action: "retry", attempt: 3, waitMs: 120_000 });
    expect(capacityRetryDecision(3, raw)).toEqual({ action: "exhaust" });
    expect(CAPACITY_RETRY_EXHAUSTED_TEXT).toBe("模型满载，已自动重试 3 次");
    expect(capacityRetryDecision(0, "401 unauthorized")).toEqual({ action: "give_up" });
  });

  test("a round that already ran a tool is not resubmitted", () => {
    const raw = "Selected model is at capacity. Please try a different model.";
    expect(capacityRetryDecision(0, raw, true)).toEqual({ action: "side_effect" });
    expect(capacityRetryDecision(2, raw, true)).toEqual({ action: "side_effect" });
    expect(capacityRetryDecision(0, raw, false).action).toBe("retry");
    expect(capacityRetryDecision(0, raw).action).toBe("retry");
    expect(capacityRetryDecision(0, "401 unauthorized", true)).toEqual({ action: "give_up" });
    expect(CAPACITY_RETRY_SIDE_EFFECT_TEXT).toBe("模型在执行中途出错，未自动重试，以免重复执行");
    expect(isCodexSideEffectItem("commandExecution")).toBe(true);
    expect(isCodexSideEffectItem("fileChange")).toBe(true);
    expect(isCodexSideEffectItem("mcpToolCall")).toBe(true);
    expect(isCodexSideEffectItem("unknownItem")).toBe(true);
    expect(isCodexSideEffectItem("userMessage")).toBe(false);
    expect(isCodexSideEffectItem("agentMessage")).toBe(false);
    expect(isCodexSideEffectItem("reasoning")).toBe(false);
    expect(isOpencodeSideEffectPart("tool")).toBe(true);
    expect(isOpencodeSideEffectPart("patch")).toBe(true);
    expect(isOpencodeSideEffectPart("text")).toBe(false);
    expect(isOpencodeSideEffectPart("step-start")).toBe(false);
    expect(isOpencodeSideEffectPart("reasoning")).toBe(false);
  });
});
