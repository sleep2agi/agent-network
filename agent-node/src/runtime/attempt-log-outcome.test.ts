import { describe, expect, it } from "bun:test";
import { formatAttemptOutcome } from "./attempt-log-outcome";
import { classifyRuntimeResult } from "./classify-result";

describe("formatAttemptOutcome", () => {
  it("passes the vendor's own label through when the vendor did not claim success", () => {
    // Nothing to contradict — `error_max_turns` is already honest.
    expect(formatAttemptOutcome("error_max_turns", null)).toBe("error_max_turns");
    expect(formatAttemptOutcome("error_during_execution", null)).toBe("error_during_execution");
  });

  it("says success only when the node's own classifier agrees", () => {
    expect(formatAttemptOutcome("success", { kind: "success" })).toBe("success");
  });

  it("does not print a bare 'success' when the node rejected the turn", () => {
    const line = formatAttemptOutcome("success", { kind: "soft-fail-empty" });
    // The point of the module: a log grep for a successful turn must not match.
    expect(line).not.toBe("success");
    expect(line).toContain("rejected");
    expect(line).toContain("soft-fail-empty");
    // The vendor's claim is kept, so the reader can tell this was a rejected
    // claim of success rather than a plain vendor-side error.
    expect(line).toContain("success");
  });

  it("names which kind of rejection it was", () => {
    expect(formatAttemptOutcome("success", { kind: "soft-fail-quota" })).toContain("soft-fail-quota");
    expect(formatAttemptOutcome("success", { kind: "error" })).toContain("rejected:error");
  });
});

describe("the live incident this module exists for", () => {
  // TMCode副责人, 2026-08-18 02:09 — a node configured with a model name that
  // does not exist. Numbers below are the ones the pane actually printed.
  const observed = { result: "", usage: { input_tokens: 0, output_tokens: 0 }, totalCostUsd: 0 };

  it("classifies the observed turn as a rejection", () => {
    // Assert the premise, not just the conclusion: if this ever starts coming
    // back "success", the log line below would be honest and this whole module
    // would be pointless — so pin it.
    expect(classifyRuntimeResult(observed, {}).kind).not.toBe("success");
  });

  it("would have printed a line that does not claim success", () => {
    const cls = classifyRuntimeResult(observed, {});
    const line = formatAttemptOutcome("success", cls);
    expect(line).not.toBe("success");
    expect(line.startsWith("success→rejected:")).toBe(true);
  });

  it("keeps the old behaviour reachable when the turn is genuinely fine", () => {
    const good = { result: "done", usage: { input_tokens: 120, output_tokens: 40 }, totalCostUsd: 0.01 };
    expect(formatAttemptOutcome("success", classifyRuntimeResult(good, {}))).toBe("success");
  });
});
