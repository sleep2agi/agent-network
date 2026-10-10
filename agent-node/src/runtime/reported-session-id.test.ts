import { describe, expect, test } from "bun:test";
import { reportedSessionId } from "./reported-session-id";

describe("reportedSessionId", () => {
  test("cursor reports the updated session, not the boot id", () => {
    expect(reportedSessionId("cursor", {
      cursor: "sess-new",
      boot: "sess-old",
    })).toBe("sess-new");
  });

  test("a cursor process with no session yet does not publish the empty boot id", () => {
    expect(reportedSessionId("cursor", { cursor: "", boot: "" })).toBeUndefined();
  });

  test("claude and grok keep their mutable ids, other runtimes keep the boot id", () => {
    expect(reportedSessionId("claude", { claude: "c1", boot: "boot" })).toBe("c1");
    expect(reportedSessionId("grok", { grok: "g1", boot: "boot" })).toBe("g1");
    expect(reportedSessionId("codex", { boot: "boot", cursor: "ignored" })).toBe("boot");
  });
});
