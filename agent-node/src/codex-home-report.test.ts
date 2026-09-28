import { expect, test } from "bun:test";
import { reportedCodexHome, reportedCodexHomeField } from "./codex-home-report";

test("codex and codex-app-server report an absolute CODEX_HOME", () => {
  expect(reportedCodexHome("codex", "/srv/node/codex-home")).toBe("/srv/node/codex-home");
  expect(reportedCodexHome("codex-app-server", "D:\\nodes\\codex-home")).toBe("D:\\nodes\\codex-home");
  expect(reportedCodexHomeField("codex-app-server", "/data/codex-home")).toEqual({ codex_home: "/data/codex-home" });
});

test("other runtimes and unsafe values are omitted", () => {
  expect(reportedCodexHome("grok", "/srv/node/codex-home")).toBeUndefined();
  expect(reportedCodexHome("claude", "/srv/node/codex-home")).toBeUndefined();
  expect(reportedCodexHome("codex", "relative/codex-home")).toBeUndefined();
  expect(reportedCodexHome("codex", "/tmp/ntok_secret")).toBeUndefined();
  expect(reportedCodexHome("codex", "/tmp/a\nb")).toBeUndefined();
  expect(reportedCodexHome("codex", `/${"a".repeat(1100)}`)).toBeUndefined();
  expect(reportedCodexHome("codex", "  ")).toBeUndefined();
  expect(reportedCodexHomeField("opencode", "/srv/node/codex-home")).toEqual({});
});
