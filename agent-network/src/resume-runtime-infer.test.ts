import { describe, expect, test } from "bun:test";
import { resolveRuntimeForResume, CLAUDE_CODE_CLI } from "./resume-runtime-infer";

// #1390 — --resume implies claude-code-cli. These pin the create-time
// inference: the flag must never be silently dropped, and must never leave
// the node on the default claude-agent-sdk runtime.
describe("resolveRuntimeForResume (#1390)", () => {
  test("--resume with no explicit runtime → infers claude-code-cli", () => {
    const r = resolveRuntimeForResume({ resume: "abc-123" });
    expect(r.inferredRuntime).toBe(CLAUDE_CODE_CLI);
    expect(r.conflictError).toBeUndefined();
  });

  test("--resume-latest with no explicit runtime → infers claude-code-cli", () => {
    const r = resolveRuntimeForResume({ resumeLatest: true });
    expect(r.inferredRuntime).toBe(CLAUDE_CODE_CLI);
  });

  test("--resume with explicit claude-code-cli → no change (already right)", () => {
    const r = resolveRuntimeForResume({ resume: "abc", explicitRuntime: CLAUDE_CODE_CLI });
    expect(r.inferredRuntime).toBeUndefined();
    expect(r.conflictError).toBeUndefined();
  });

  test("--resume with a conflicting explicit runtime → loud conflict, not silent drop", () => {
    const r = resolveRuntimeForResume({ resume: "abc", explicitRuntime: "claude-agent-sdk" });
    expect(r.inferredRuntime).toBeUndefined();
    expect(r.conflictError).toContain("claude-agent-sdk");
    expect(r.conflictError).toContain(CLAUDE_CODE_CLI);
  });

  test("no resume flag → no inference (leaves default runtime alone)", () => {
    expect(resolveRuntimeForResume({})).toEqual({});
    expect(resolveRuntimeForResume({ explicitRuntime: "codex-sdk" })).toEqual({});
    // bare --resume with no value (opts.resume === "true") is not a resume request
    expect(resolveRuntimeForResume({ resume: "true" })).toEqual({});
  });

  test("an already-resolved session skips inference (interactive picker path)", () => {
    // When opts.session is already set, the binding was resolved elsewhere and
    // this decision must stay out of the way.
    expect(resolveRuntimeForResume({ resume: "abc", session: "sess-1" })).toEqual({});
  });
});
