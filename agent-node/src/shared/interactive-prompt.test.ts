// 只做可观测：固定短语才报，宁漏不误；摘录必须脱敏
import { describe, expect, test } from "bun:test";
import { detectInteractivePrompt, mergePromptSignal, redactExcerpt } from "./interactive-prompt.js";

const at = 1767225600000;
const iso = new Date(at).toISOString();

describe("detectInteractivePrompt", () => {
  test("已知固定短语 → 分类正确", () => {
    expect(detectInteractivePrompt("Do you trust the files in this folder?", at))
      .toEqual({ kind: "codex_trust", excerpt: "Do you trust the files in this folder?", detected_at: iso });
    expect(detectInteractivePrompt("A new version of Codex is available", at)?.kind).toBe("codex_update");
    expect(detectInteractivePrompt("opencode 1.19.2 is available", at)?.kind).toBe("opencode_update");
    expect(detectInteractivePrompt("Please log in to continue", at)?.kind).toBe("login_required");
  });

  test("普通输出不报（宁漏不误）", () => {
    for (const line of ["", "idle", "update complete", "trust me, it works", "login succeeded"]) {
      expect(detectInteractivePrompt(line, at)).toBeNull();
    }
  });

  test("ANSI 颜色码不影响识别", () => {
    expect(detectInteractivePrompt("\u001b[33mUpdate available\u001b[0m", at)?.kind).toBe("codex_update");
  });

  test("摘录脱敏：token 形状抹掉、控制字符压平、超长截断", () => {
    const s = redactExcerpt("error ntok_abcdefgh12345678\n\tPlease log in");
    expect(s).not.toContain("ntok_");
    expect(s).toContain("[redacted]");
    expect(s).toContain("Please log in");
    expect(redactExcerpt("x".repeat(500)).length).toBe(200);
  });

  test("同类提示重复出现时保留首次时间", () => {
    const first = detectInteractivePrompt("Update available", at)!;
    const second = detectInteractivePrompt("Update available", at + 60_000)!;
    expect(mergePromptSignal(first, second).detected_at).toBe(first.detected_at);
    const other = detectInteractivePrompt("Please log in", at + 120_000)!;
    expect(mergePromptSignal(first, other).detected_at).toBe(other.detected_at);
  });
});

describe("createPromptTracker 生命周期", () => {
  test("观测到 → current 有值；clear 之后回到 null（不会永久显示旧提示）", () => {
    const { createPromptTracker } = require("./interactive-prompt.js") as typeof import("./interactive-prompt.js");
    const tr = createPromptTracker(() => at);
    expect(tr.current()).toBeNull();
    const seen = tr.observe("Update available", at);
    expect(seen?.first).toBe(true);
    expect(tr.current()?.kind).toBe("codex_update");
    // 同类重复：不算第一次
    expect(tr.observe("Update available", at)?.first).toBe(false);
    // 一轮正常跑完 → 清除
    expect(tr.clear("turn-completed")).toBe(true);
    expect(tr.current()).toBeNull();
    // 再清一次是 no-op
    expect(tr.clear("turn-completed")).toBe(false);
  });

  test("不同 kind 再次出现仍算第一次（要能重新 warn）", () => {
    const { createPromptTracker } = require("./interactive-prompt.js") as typeof import("./interactive-prompt.js");
    const tr = createPromptTracker(() => at);
    tr.observe("Update available", at);
    expect(tr.observe("Please log in", at)?.first).toBe(true);
  });
});
