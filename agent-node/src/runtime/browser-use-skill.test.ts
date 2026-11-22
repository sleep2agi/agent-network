// #5152 —— 默认浏览器能力：skill 目录 + wrapper（平台差异 / 先关 daemon）
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROWSER_USE_SKILL_MD, browserUseWrapperScript, installBrowserUseSkill } from "./browser-use-skill.js";

describe("#5152 browser-use skill", () => {
  test("四种 runtime 的通集都铺到：.agents/skills 与 .claude/skills 各一份", () => {
    const dir = mkdtempSync(join(tmpdir(), "bu-skill-"));
    try {
      const written = installBrowserUseSkill(dir, { platform: "linux" });
      const skill = join(dir, ".agents/skills/browser-use/SKILL.md");
      const claude = join(dir, ".claude/skills/browser-use/SKILL.md");
      expect(written).toContain(skill);
      expect(written).toContain(claude);
      expect(readFileSync(skill, "utf8")).toBe(BROWSER_USE_SKILL_MD);
      expect(readFileSync(claude, "utf8")).toBe(BROWSER_USE_SKILL_MD);
      // wrapper 可执行
      const wrapper = join(dir, ".anet/bin/browser-use");
      expect(statSync(wrapper).mode & 0o777).toBe(0o755);
      expect(readFileSync(wrapper, "utf8")).toContain("--no-sandbox");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("Linux 带 --no-sandbox；macOS 不带；都先 close 残留 daemon", () => {
    const linux = browserUseWrapperScript("linux");
    expect(linux).toContain('--args "--no-sandbox"');
    expect(linux.indexOf("agent-browser close")).toBeLessThan(linux.indexOf("agent-browser open"));
    const mac = browserUseWrapperScript("darwin");
    const macExec = mac.split("\n").filter(l => l.trim().startsWith("exec")).join("\n");
    expect(macExec).not.toContain("--no-sandbox");   // 注释里提到是给人看的，执行行才算数
    expect(mac).toContain("agent-browser close");
  });

  test("Windows 用 .cmd 形状（不写 sh 语法），且不带 linux 专属参数", () => {
    const win = browserUseWrapperScript("win32");
    expect(win.startsWith("@echo off")).toBe(true);
    expect(win).not.toContain("#!/bin/sh");
    expect(win).not.toContain("--no-sandbox");
    expect(win).toContain("%*");
  });

  test("SKILL.md 明确「只走 wrapper、不直调 agent-browser」", () => {
    expect(BROWSER_USE_SKILL_MD).toContain("不要直接调 `agent-browser`");
    expect(BROWSER_USE_SKILL_MD).toContain("browser-use");
  });
});
