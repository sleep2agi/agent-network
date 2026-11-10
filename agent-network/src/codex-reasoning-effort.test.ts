import { describe, expect, test } from "bun:test";
import {
  CODEX_MODEL_REASONING_EFFORT_KEY,
  codexReasoningEffortConfigOverride,
  isReasoningEffortValue,
  mergeModelReasoningEffortIntoToml,
  REASONING_EFFORT_VALUES,
} from "./codex-reasoning-effort";

describe("codex-reasoning-effort", () => {
  test("isReasoningEffortValue accepts known union", () => {
    for (const v of REASONING_EFFORT_VALUES) expect(isReasoningEffortValue(v)).toBe(true);
    expect(isReasoningEffortValue("max")).toBe(false);
    expect(isReasoningEffortValue("")).toBe(false);
  });

  test("codexReasoningEffortConfigOverride uses model_reasoning_effort key", () => {
    expect(codexReasoningEffortConfigOverride("high")).toBe(`${CODEX_MODEL_REASONING_EFFORT_KEY}=high`);
  });

  test("mergeModelReasoningEffortIntoToml inserts top-level key", () => {
    const out = mergeModelReasoningEffortIntoToml('model = "gpt-5"\n', "medium");
    expect(out).toContain('model_reasoning_effort = "medium"');
    expect(out).toContain('model = "gpt-5"');
  });

  test("mergeModelReasoningEffortIntoToml replaces existing line outside sections", () => {
    const in_ = 'model_reasoning_effort = "low"\nmodel = "x"\n';
    const out = mergeModelReasoningEffortIntoToml(in_, "xhigh");
    expect(out.match(/model_reasoning_effort/g)?.length).toBe(1);
    expect(out).toContain('model_reasoning_effort = "xhigh"');
  });
});
