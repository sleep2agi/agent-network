import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { formatCliVersion } from "./cli-version-display";

describe("formatCliVersion (#1645)", () => {
  test("三家真实输出原样保留 —— 不解析、不归一", () => {
    expect(formatCliVersion("codex-cli 0.149.1\n")).toBe("codex-cli 0.149.1");
    expect(formatCliVersion("1.4.0")).toBe("1.4.0");
    expect(formatCliVersion("2.0.1 (Claude Code)\n")).toBe("2.0.1 (Claude Code)");
  });

  test("多行只取第一行非空", () => {
    expect(formatCliVersion("\n\n  codex-cli 0.149.1  \nsome banner\n")).toBe("codex-cli 0.149.1");
  });

  test("🔴 拿不到就说「版本未输出」,不返回空串", () => {
    // 空串会让输出变成 `✅ Codex CLI ()` —— 一个看起来像有值的空括号。
    for (const bad of ["", "   \n \n", undefined, null, 123, {}]) {
      expect(formatCliVersion(bad as unknown)).toBe("版本未输出");
    }
  });

  test("超长输出截断并带省略号(有些 CLI 会打一整段横幅)", () => {
    const long = "x".repeat(200);
    const out = formatCliVersion(long);
    expect(out.length).toBe(60);
    expect(out.endsWith("...")).toBe(true);
  });

  test("边界用边界值校准:60 不截断,61 截断", () => {
    expect(formatCliVersion("y".repeat(60))).toBe("y".repeat(60));
    expect(formatCliVersion("y".repeat(61))).toBe(`${"y".repeat(57)}...`);
  });
});

describe("接线守卫", () => {
  // 🔴 纯函数的单测看不见调用点。剥掉注释行再断言 —— 源码里既有那个东西,
  //    也有关于它的说明(今天在别的 PR 上因为这个基线直接红过一次)。
  const cli = readFileSync(new URL("../bin/cli.ts", import.meta.url), "utf8")
    .split("\n")
    .filter(l => { const c = l.trim(); return !c.startsWith("//") && !c.startsWith("*") && !c.startsWith("/*"); })
    .join("\n");

  test("doctor 里三个 CLI 都带版本 detail", () => {
    for (const cmd of ["claude --version", "codex --version", "bun --version"]) {
      expect(cli).toContain(`cliVer("${cmd}")`);
    }
  });

  test("🔴 而且确实用了 formatCliVersion —— 「带 detail」也可能是塞了个别的串", () => {
    expect(cli).toContain("formatCliVersion(String(execSync(cmd");
  });

  test("🔴 不再有「只检查在不在」的旧写法", () => {
    expect(cli).not.toContain('execSync("codex --version", { stdio: "pipe" }); check');
  });
});
