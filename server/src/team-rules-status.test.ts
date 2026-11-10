// #2211 — the four states, as decisions rather than as prose.
//
// The point of these cases is that "behind" and "failed" are different words:
// v1 injects at full start, so a node that simply has not restarted is `outdated`.
// Calling that `failed` would send someone to debug a node that is doing fine.
import { describe, expect, test } from "bun:test";
import { deriveTeamRulesView } from "./team-rules-status";

const report = (o: Record<string, unknown>) => o as any;

describe("deriveTeamRulesView (#2211)", () => {
  test("a node that never attempted is omitted entirely (not reported as null state)", () => {
    expect(deriveTeamRulesView(null, 3)).toBeNull();
    expect(deriveTeamRulesView(undefined, 3)).toBeNull();
    expect(deriveTeamRulesView(report({}), 3)).toBeNull();
  });

  test("applied revision equals the network's current revision → current", () => {
    const v = deriveTeamRulesView(report({ revision: 3, status: "injected", at: "2026-10-24T12:00:00Z" }), 3)!;
    expect(v).toMatchObject({ state: "current", applied_revision: 3, current_revision: 3 });
  });

  test("behind the current revision → outdated, with the reason kept for context", () => {
    const v = deriveTeamRulesView(report({ revision: 2, status: "unchanged" }), 3)!;
    expect(v.state).toBe("outdated");
    expect(v.applied_revision).toBe(2);
    expect(v.current_revision).toBe(3);
  });

  test("an error is failed even when it also happens to carry the current revision", () => {
    const v = deriveTeamRulesView(report({ revision: 3, status: "error", reason: "expected exactly one BEGIN" }), 3)!;
    expect(v.state).toBe("failed");
    expect(v.reason).toBe("expected exactly one BEGIN");
  });

  test("skipped with no revision (disabled / hub unreachable) → never, reason preserved", () => {
    const v = deriveTeamRulesView(report({ revision: null, status: "skipped", reason: "hub_timeout" }), 3)!;
    expect(v).toMatchObject({ state: "never", applied_revision: null, reason: "hub_timeout" });
  });

  test("the network lost its rules but the node still carries a block → outdated", () => {
    const v = deriveTeamRulesView(report({ revision: 4, status: "injected" }), null)!;
    expect(v.state).toBe("outdated");
    expect(v.current_revision).toBeNull();
  });

  test("a hub rollback (node ahead of the current revision) is not called current", () => {
    const v = deriveTeamRulesView(report({ revision: 5, status: "injected" }), 3)!;
    expect(v.state).toBe("outdated");
  });

  test("malformed input never throws and never fabricates a revision", () => {
    const v = deriveTeamRulesView(report({ revision: "3" as any, status: 42 as any, reason: 7 as any }), 3);
    expect(v).not.toBeNull();
    expect(v!.state).toBe("never");
    expect(v!.applied_revision).toBeNull();
    expect(v!.reason).toBeNull();
  });
});
