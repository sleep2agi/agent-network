// Unit coverage for the agent-selection hot path.
//
// The contract these tests pin down (all three were verified against a real
// OpenCode V2 server, so they are not guesses):
//   1. A successful switch is only "applied" when the readback reports the new
//      agent. 204 alone means nothing — PATCH /api/session/{id} also returns
//      204 for fields it silently drops.
//   2. `null` is rejected: the server exposes no "clear agent", so writing a
//      guessed value would change behaviour behind the user's back.
//   3. Nothing here degrades to a restart: a restart would reopen the previous
//      agent and look like success while doing nothing.

import { describe, expect, test } from "bun:test";
import { applyAgentConfig } from "./agent-config-apply";

const session = (overrides: Partial<Parameters<typeof applyAgentConfig>[0]> = {}) => {
  const calls: Array<{ kind: string; id?: string; agent?: string }> = [];
  const base = {
    isRunning: true,
    sessionId: "ses_test",
    async selectedSessionAgent(id: string) {
      calls.push({ kind: "read", id });
      return "build";
    },
    async selectSessionAgent(id: string, agent: string) {
      calls.push({ kind: "write", id, agent });
      return { status: "applied" as const, agent };
    },
  };
  return { session: { ...base, ...overrides }, calls };
};

describe("applyAgentConfig", () => {
  test("switches the bound session and reports applied", async () => {
    const { session: s, calls } = session();
    const result = await applyAgentConfig(s as any, "plan");
    expect(result).toEqual({ status: "applied", agent: "plan" });
    expect(calls).toEqual([{ kind: "read", id: "ses_test" }, { kind: "write", id: "ses_test", agent: "plan" }]);
  });

  test("same agent short-circuits without writing", async () => {
    const { session: s, calls } = session();
    const result = await applyAgentConfig(s as any, "build");
    expect(result).toEqual({ status: "applied", agent: "build" });
    expect(calls.filter((c) => c.kind === "write")).toHaveLength(0);
  });

  test("null is rejected, never guessed", async () => {
    const { session: s, calls } = session();
    expect(await applyAgentConfig(s as any, null)).toEqual({ status: "rejected", reason: "unsupported" });
    expect(calls.filter((c) => c.kind === "write")).toHaveLength(0);
  });

  test("missing runtime methods are unsupported, not a restart", async () => {
    expect(await applyAgentConfig(undefined, "plan")).toEqual({ status: "rejected", reason: "unsupported" });
    expect(await applyAgentConfig({ isRunning: false, sessionId: "ses_x" } as any, "plan"))
      .toEqual({ status: "rejected", reason: "unsupported" });
  });

  test("scope read failure is rejected as scope", async () => {
    const { session: s } = session({ async selectedSessionAgent() { throw new Error("410 gone"); } } as any);
    expect(await applyAgentConfig(s as any, "plan")).toEqual({ status: "rejected", reason: "scope" });
  });

  test("write failure surfaces as unknown (never as success)", async () => {
    const { session: s } = session({ async selectSessionAgent() { throw new Error("ECONNRESET"); } } as any);
    expect(await applyAgentConfig(s as any, "plan")).toEqual({ status: "unknown" });
  });

  test("invalid agent names are rejected before any write", async () => {
    const { session: s, calls } = session();
    expect(await applyAgentConfig(s as any, "")).toEqual({ status: "rejected", reason: "invalid" });
    expect(await applyAgentConfig(s as any, "x".repeat(201))).toEqual({ status: "rejected", reason: "invalid" });
    expect(calls.filter((c) => c.kind === "write")).toHaveLength(0);
  });
});
