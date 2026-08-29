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
  });

  // #1469 f4 —— 裸 `--resume`（无 id）此前被判成「没请求 resume」。
  //
  // 后果不是「少推断一次」：runtime 保持默认 claude-agent-sdk，于是 cli.ts 里
  // 那整块 session 绑定逻辑（它以 `=== "claude-code-cli"` 为条件）**整段被跳过** ——
  // 连 TTY 下的交互选单也进不去。用户打了 --resume，拿到的是一个没有 resume 的
  // 默认 runtime 节点，全程零警告。
  //
  // 🔴 这条以前有一条测试**显式钉着旧行为**（`resume:"true"` → `{}`，注释写
  //    「不算 resume 请求」）。那是一个被编码的决定，不是疏漏，所以这里连同
  //    理由一起改：用户把这个 flag 打出来了，缺的是 id 不是意图。
  test("🔴 裸 --resume（无 id）也是 resume 请求 —— 不能静默当成没打过", () => {
    expect(resolveRuntimeForResume({ resume: "true" })).toEqual({
      inferredRuntime: "claude-code-cli",
    });
  });

  test("裸 --resume + 冲突的显式 runtime ⇒ 与带 id 时一样大声失败", () => {
    const r = resolveRuntimeForResume({ resume: "true", explicitRuntime: "codex-sdk" });
    expect(r.conflictError).toContain("codex-sdk");
    expect(r.inferredRuntime).toBeUndefined();
  });

  test("裸 --resume + 已显式 claude-code-cli ⇒ 无需改动", () => {
    expect(resolveRuntimeForResume({ resume: "true", explicitRuntime: "claude-code-cli" })).toEqual({});
  });

  test("真正没打 --resume 时仍然不推断（分界没有被推宽）", () => {
    expect(resolveRuntimeForResume({})).toEqual({});
    expect(resolveRuntimeForResume({ explicitRuntime: "codex-sdk" })).toEqual({});
    expect(resolveRuntimeForResume({ resume: "" })).toEqual({});
  });

  test("an already-resolved session skips inference (interactive picker path)", () => {
    // When opts.session is already set, the binding was resolved elsewhere and
    // this decision must stay out of the way.
    expect(resolveRuntimeForResume({ resume: "abc", session: "sess-1" })).toEqual({});
  });
});
