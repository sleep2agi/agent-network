// Unit tests for opinion-spread prompts module (issue #72 Phase 1, my demo马 part).
//
// Pure structural / lookup assertions — no LLM, no network, no infra.
// The full e2e demo run (`anet demo opinion-spread`) test is downstream of
// 通信工程马's cli wire and will be added by 通信测试马 in a separate
// `tests/testNN-opinion-spread-e2e/` once the joint PR ships preview.

import { expect, test, describe } from "bun:test";
import {
  OPINION_TOPICS,
  resolveOpinionTopic,
  opinionSpreadPrompt,
} from "./opinion-spread-prompts";

describe("OPINION_TOPICS preset list", () => {
  test("has 5-10 entries (curated, not exhaustive)", () => {
    expect(OPINION_TOPICS.length).toBeGreaterThanOrEqual(5);
    expect(OPINION_TOPICS.length).toBeLessThanOrEqual(10);
  });

  test("every entry has value + label + topic", () => {
    for (const t of OPINION_TOPICS) {
      expect(typeof t.value).toBe("string");
      expect(t.value.length).toBeGreaterThan(0);
      expect(typeof t.label).toBe("string");
      expect(t.label.length).toBeGreaterThan(0);
      expect(typeof t.topic).toBe("string");
    }
  });

  test("values are unique slugs (kebab-case)", () => {
    const values = OPINION_TOPICS.map(t => t.value);
    expect(new Set(values).size).toBe(values.length);
    for (const v of values) {
      expect(v).toMatch(/^[a-z0-9-]+$/);
    }
  });

  test("custom trailing + has empty topic (wizard re-prompts)", () => {
    const last = OPINION_TOPICS[OPINION_TOPICS.length - 1];
    expect(last.value).toBe("custom");
    expect(last.topic).toBe("");
  });

  test("ai-regulation is present (通信龙 default example)", () => {
    const found = OPINION_TOPICS.find(t => t.value === "ai-regulation");
    expect(found).toBeDefined();
    expect(found!.topic).toContain("AI 监管");
  });
});

describe("resolveOpinionTopic()", () => {
  test("known preset value → preset topic", () => {
    expect(resolveOpinionTopic("ai-regulation")).toContain("AI 监管");
    expect(resolveOpinionTopic("work-996")).toContain("996");
  });

  test("empty input → first preset (default)", () => {
    expect(resolveOpinionTopic("")).toBe(OPINION_TOPICS[0].topic);
  });

  test("custom value passes through (wizard already resolved to user string)", () => {
    expect(resolveOpinionTopic("用户自定义议题 X")).toBe("用户自定义议题 X");
  });
});

describe("opinionSpreadPrompt() — leader (主持人) branch", () => {
  const out = opinionSpreadPrompt("leader", 0, 51, "AI 监管 (是否应该立法限制)", undefined);

  test("identifies as 主持人 + injects topic", () => {
    expect(out).toContain("alias=主持人");
    expect(out).toContain("AI 监管");
  });

  test("declares cohort split (25 + 25 for total=51)", () => {
    expect(out).toContain("支持1号");
    expect(out).toContain("支持25号");
    expect(out).toContain("反对1号");
    expect(out).toContain("反对25号");
  });

  test("references active fan-out tools (commhub_send_task / get_inbox / send_reply)", () => {
    expect(out).toContain("commhub_send_task");
    expect(out).toContain("commhub_get_inbox");
    expect(out).toContain("commhub_send_reply");
  });

  test("specifies round-based workflow + final summary structure", () => {
    expect(out).toContain("Round 1");
    expect(out).toContain("Round 2");
    expect(out).toContain("立场动摇人数");
  });

  test("anti-echo guard (要真在主持, 不是 echo 占位)", () => {
    expect(out).toContain("不是");
    expect(out).toContain("echo 占位");
  });
});

describe("opinionSpreadPrompt() — worker 支持 cohort branch", () => {
  const out = opinionSpreadPrompt("worker", 7, 51, "AI 监管", "支持");

  test("identifies as 支持7号 (cohort-indexed alias)", () => {
    expect(out).toContain("alias=支持7号");
  });

  test("declares 坚定支持 stance", () => {
    expect(out).toContain("坚定支持");
    expect(out).toContain("AI 监管");
  });

  test("references opposite cohort + 主持人", () => {
    expect(out).toContain("反对");
    expect(out).toContain("主持人");
  });

  test("round 1 = 50 字陈述, round 2+ = 阅读他人 reply 后判断", () => {
    expect(out).toContain("Round 1");
    expect(out).toContain("Round 2+");
    expect(out).toContain("立场动摇");
  });

  test("uses commhub_reply (not send_task) to reply leader", () => {
    expect(out).toContain("commhub_reply");
  });
});

describe("opinionSpreadPrompt() — worker 反对 cohort branch", () => {
  const out = opinionSpreadPrompt("worker", 12, 51, "AI 监管", "反对");

  test("identifies as 反对12号", () => {
    expect(out).toContain("alias=反对12号");
  });

  test("declares 坚定反对 stance", () => {
    expect(out).toContain("坚定反对");
  });

  test("references opposite (支持) cohort", () => {
    expect(out).toContain("支持");
  });
});

describe("opinionSpreadPrompt() — cohort symmetry", () => {
  const topic = "996 工作制";
  const sup = opinionSpreadPrompt("worker", 1, 51, topic, "支持");
  const opp = opinionSpreadPrompt("worker", 1, 51, topic, "反对");

  test("both branches inject topic", () => {
    expect(sup).toContain(topic);
    expect(opp).toContain(topic);
  });

  test("支持 branch never says 坚定反对", () => {
    expect(sup).not.toContain("坚定反对");
    expect(sup).toContain("坚定支持");
  });

  test("反对 branch never says 坚定支持", () => {
    expect(opp).not.toContain("坚定支持");
    expect(opp).toContain("坚定反对");
  });
});

describe("opinionSpreadPrompt() — cohort split math (variable total)", () => {
  test("total=51 → leader text shows 25+25 split", () => {
    const out = opinionSpreadPrompt("leader", 0, 51, "X", undefined);
    expect(out).toContain("支持 cohort: 支持1号 .. 支持25号 (共 25 人)");
    expect(out).toContain("反对 cohort: 反对1号 .. 反对25号 (共 25 人)");
  });

  test("total=11 → leader text shows 5+5 split", () => {
    const out = opinionSpreadPrompt("leader", 0, 11, "X", undefined);
    expect(out).toContain("支持 cohort: 支持1号 .. 支持5号 (共 5 人)");
    expect(out).toContain("反对 cohort: 反对1号 .. 反对5号 (共 5 人)");
  });

  test("total=21 → leader text shows 10+10 split", () => {
    const out = opinionSpreadPrompt("leader", 0, 21, "X", undefined);
    expect(out).toContain("支持 cohort: 支持1号 .. 支持10号 (共 10 人)");
    expect(out).toContain("反对 cohort: 反对1号 .. 反对10号 (共 10 人)");
  });

  test("odd worker count (total=12 → 11 workers) → 5 支持 + 6 反对 (反对 absorbs)", () => {
    const out = opinionSpreadPrompt("leader", 0, 12, "X", undefined);
    expect(out).toContain("支持 cohort: 支持1号 .. 支持5号 (共 5 人)");
    expect(out).toContain("反对 cohort: 反对1号 .. 反对6号 (共 6 人)");
  });
});

describe("opinionSpreadPrompt() — defensive: unknown cohortPrefix", () => {
  test("falls back to 支持 branch (does not crash, does not produce empty prompt)", () => {
    const out = opinionSpreadPrompt("worker", 1, 51, "X", "unknown-cohort");
    expect(out.length).toBeGreaterThan(100);
    expect(out).toContain("坚定支持");
  });

  test("undefined cohortPrefix on worker (programmer error) → 支持 branch fallback", () => {
    const out = opinionSpreadPrompt("worker", 1, 51, "X", undefined);
    expect(out).toContain("坚定支持");
  });
});
