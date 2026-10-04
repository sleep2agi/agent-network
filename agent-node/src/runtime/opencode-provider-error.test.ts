import { describe, expect, test } from "bun:test";
import { runtimeErrorReplyText } from "./unverified-reply-text";
import {
  OpenCodeProviderError,
  isOpenCodeFreeTierRejection,
  openCodeTurnError,
  withOpenCodeFreeTierHint,
} from "./opencode-provider-error";

// Shape captured from opencode-ai@1.18.1 `POST /session/:id/message` with
// `opencode/nemotron-3-ultra-free` and one tool disabled (Docker, #540).
const FREE_TIER_MESSAGE = {
  info: {
    role: "assistant",
    providerID: "opencode",
    modelID: "nemotron-3-ultra-free",
    error: {
      name: "APIError",
      data: {
        message: "Error from provider (Console): OpenCode's free tier can only be used from within OpenCode",
        statusCode: 403,
        isRetryable: false,
        responseBody: "{\"type\":\"error\",\"error\":{\"type\":\"FreeTierError\"}}",
      },
    },
  },
  parts: [],
};

describe("#540 opencode provider errors", () => {
  test("no error field means no turn error (empty success stays a success)", () => {
    expect(openCodeTurnError({ info: { role: "assistant" }, parts: [] })).toBeNull();
    expect(openCodeTurnError({ info: { role: "assistant", error: null } })).toBeNull();
    expect(openCodeTurnError(null)).toBeNull();
  });

  test("reads the upstream name and message from the real 1.18.1 shape", () => {
    expect(openCodeTurnError(FREE_TIER_MESSAGE)).toEqual({
      name: "APIError",
      message: "Error from provider (Console): OpenCode's free tier can only be used from within OpenCode",
    });
  });

  test("falls back for other error shapes without dropping the failure", () => {
    expect(openCodeTurnError({ info: { error: { name: "MessageOutputLengthError", data: {} } } })).toEqual({
      name: "MessageOutputLengthError",
      message: JSON.stringify({ name: "MessageOutputLengthError", data: {} }),
    });
    expect(openCodeTurnError({ info: { error: "boom" } })).toEqual({ name: "Error", message: "boom" });
  });

  test("free-tier rejection becomes the readable safe-preset hint, keeping the upstream text", () => {
    const err = new OpenCodeProviderError(openCodeTurnError(FREE_TIER_MESSAGE)!);
    expect(err.freeTierRejected).toBe(true);
    const reply = runtimeErrorReplyText("opencode", err);
    expect(reply).toStartWith("opencode 错误: ");
    expect(reply).toContain("flags.opencodeUnsafeTools=true");
    expect(reply).toContain("anet opencode auth-login");
    expect(reply).toContain("free tier can only be used from within OpenCode");
  });

  test("other provider errors keep the upstream text and any partial reply", () => {
    const err = new OpenCodeProviderError({ name: "ProviderAuthError", message: "bad key" }, "half an answer");
    expect(err.freeTierRejected).toBe(false);
    expect(err.message).toContain("ProviderAuthError: bad key");
    expect(err.message).toContain("half an answer");
    expect(err.message).not.toContain("opencodeUnsafeTools");
  });

  test("ACP lane: the JSON-RPC error text is mapped, other errors pass through untouched", () => {
    const acp = new Error("Internal error: Error from provider (Console): OpenCode's free tier can only be used from within OpenCode");
    const mapped = withOpenCodeFreeTierHint(acp) as Error;
    expect(mapped).not.toBe(acp);
    expect(mapped.message).toContain("flags.opencodeUnsafeTools=true");
    expect(mapped.message).toContain("Internal error: Error from provider");
    const other = new Error("connection reset");
    expect(withOpenCodeFreeTierHint(other)).toBe(other);
    expect(isOpenCodeFreeTierRejection("some other 403")).toBe(false);
  });
});
