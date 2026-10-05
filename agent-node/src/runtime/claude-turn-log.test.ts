import { describe, expect, it } from "bun:test";
import { createClaudeResultTracker, formatClaudeTurnCost, modelInUseNotice } from "./claude-turn-log";

describe("#557 ① modelInUseNotice — the model actually in use comes from the SDK init message", () => {
  it("names the model the init message reports", () => {
    expect(modelInUseNotice({ session_id: "s1", model: "claude-opus-5-5" }, undefined))
      .toBe("[claude] model in use: claude-opus-5-5");
  });

  it("says it once per session, again for a new session", () => {
    expect(modelInUseNotice({ session_id: "s1", model: "claude-opus-5-5" }, "s1")).toBeNull();
    expect(modelInUseNotice({ session_id: "s2", model: "claude-opus-5-5" }, "s1"))
      .toBe("[claude] model in use: claude-opus-5-5");
  });

  it("invents nothing when the init message carries no model", () => {
    expect(modelInUseNotice({ session_id: "s1" }, undefined)).toBeNull();
    expect(modelInUseNotice({ session_id: "s1", model: "" }, undefined)).toBeNull();
  });
});

describe("#557 ② result tracker — only the LAST result of a query decides 'empty'", () => {
  it("canary shape: extra empty result, then the real one → not an empty turn", () => {
    const t = createClaudeResultTracker<string>();
    expect(t.push("empty-1", true)).toBeNull();
    // The real result supersedes the intermediate empty one.
    expect(t.push("real", false)).toBe("empty-1");
    expect(t.pendingEmpty()).toBeNull();
  });

  it("a genuinely empty turn (only result is empty) is still reported empty", () => {
    const t = createClaudeResultTracker<string>();
    t.push("empty-only", true);
    expect(t.pendingEmpty()).toBe("empty-only");
  });

  it("the last result being empty wins even after a non-empty one", () => {
    const t = createClaudeResultTracker<string>();
    t.push("real", false);
    t.push("empty-last", true);
    expect(t.pendingEmpty()).toBe("empty-last");
  });

  it("two empties then nothing → the last empty is the verdict", () => {
    const t = createClaudeResultTracker<string>();
    t.push("e1", true);
    expect(t.push("e2", true)).toBe("e1");
    expect(t.pendingEmpty()).toBe("e2");
  });

  it("no results at all → nothing to report as empty", () => {
    expect(createClaudeResultTracker<string>().pendingEmpty()).toBeNull();
  });
});

describe("#557 ③ formatClaudeTurnCost — per-turn delta from a cumulative session total", () => {
  it("second turn of a session logs the delta, labelled, with the session total", () => {
    expect(formatClaudeTurnCost(0.86, 0.84, true)).toBe("$0.0200 (session $0.8600)");
  });

  it("first turn of a fresh session: the total IS the turn's cost", () => {
    expect(formatClaudeTurnCost(0.05, undefined, false)).toBe("$0.0500 (session $0.0500)");
  });

  it("resumed session with no known previous total: per-turn is unknown, not the session total", () => {
    expect(formatClaudeTurnCost(0.86, undefined, true)).toBe("$? (session $0.8600)");
  });

  it("a total below the previous one (counter reset) is treated as a fresh total", () => {
    expect(formatClaudeTurnCost(0.01, 0.5, true)).toBe("$0.0100 (session $0.0100)");
  });

  it("missing total → '$?'", () => {
    expect(formatClaudeTurnCost(undefined, 0.5, true)).toBe("$?");
  });
});
