import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isAliasSseConnected, sseConnectionCountForAlias } from "./sse-session-match";

describe("sse-session-match", () => {
  test("matches network-scoped keys emitted by Hub GET /api/stats/sse", () => {
    const sessions = {
      "net_alpha:bot-a": 1,
      "net_alpha:中文节点": 2,
      "global:legacy-bot": 1,
    };
    expect(isAliasSseConnected(sessions, "bot-a", "net_alpha")).toBe(true);
    expect(sseConnectionCountForAlias(sessions, "中文节点", "net_alpha")).toBe(2);
    expect(isAliasSseConnected(sessions, "legacy-bot")).toBe(true);
    expect(isAliasSseConnected(sessions, "legacy-bot", null)).toBe(true);
  });

  test("does not leak connection state across different networks", () => {
    const sessions = {
      "net_other:shared-alias": 1,
      "net_alpha:offline-alias": 0,
    };
    expect(isAliasSseConnected(sessions, "shared-alias", "net_alpha")).toBe(false);
    expect(isAliasSseConnected(sessions, "offline-alias", "net_alpha")).toBe(false);
    expect(isAliasSseConnected(sessions, "shared-alias", undefined)).toBe(false);
  });

  test("keeps backward compatibility with bare alias keys in legacy/mock hubs", () => {
    const sessions = { "mock-bot": 1 };
    expect(isAliasSseConnected(sessions, "mock-bot", "net_alpha")).toBe(true);
    expect(isAliasSseConnected(sessions, "mock-bot")).toBe(true);
    expect(isAliasSseConnected(sessions, "missing-bot", "net_alpha")).toBe(false);
  });

  test("handles empty or missing inputs safely", () => {
    expect(isAliasSseConnected(undefined, "bot-a", "net_alpha")).toBe(false);
    expect(isAliasSseConnected({}, "", "net_alpha")).toBe(false);
  });

  test("bin/cli.ts uses isAliasSseConnected instead of bare sseDetail.sessions[alias]", () => {
    const cli = readFileSync(join(import.meta.dir, "..", "bin", "cli.ts"), "utf8");
    expect(cli).toContain("isAliasSseConnected(");
    expect(cli).not.toContain("sseDetail.sessions[displayName]");
    expect(cli).not.toContain("sseDetail.sessions[alias]");
    expect(cli).not.toContain("detail.sessions[a]");
  });
});
