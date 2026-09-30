// anet 的密码登录 / 注册都要带 client_label(2026-09-30:生产 admin 2617 条登录会话 client_label 全空,
// app「登录设备」里只能显示成「未命名」)。判据 + 取集分开:
//   判据 —— anetClientLabel 的格式、长度、清洗;
//   取集 —— cli.ts 里**每一个**打 /api/auth/login 或 /api/auth/register 的 fetch 都算进来,数对个数,逐个看 body。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { anetClientLabel, CLIENT_LABEL_MAX } from "./login-client-label";

describe("anetClientLabel", () => {
  test("tool + version · host · subcommand", () => {
    expect(anetClientLabel({ version: "2.5.0-preview.90", host: "build-box", command: "login" })).toBe("anet 2.5.0-preview.90 · build-box · login");
  });
  test("missing version / host still says what it is", () => {
    expect(anetClientLabel({ version: "", host: null, command: "register" })).toBe("anet dev · unknown-host · register");
  });
  test("long host names are shortened so the subcommand survives the hub's 64-char cut", () => {
    const label = anetClientLabel({ version: "2.5.0-preview.90", host: "ecs-0000example0000-very-long-cloud-hostname", command: "node create --batch" });
    expect(label.length).toBeLessThanOrEqual(CLIENT_LABEL_MAX);
    expect(label.endsWith(" · node create --batch")).toBe(true);
  });
  test("never longer than the hub keeps, control characters removed", () => {
    const label = anetClientLabel({ version: "1.0.0\n\u0007", host: "h\tost", command: "x".repeat(200) });
    expect(label.length).toBe(CLIENT_LABEL_MAX);
    expect(/[\u0000-\u001f\u007f]/.test(label)).toBe(false);
    expect(label.startsWith("anet 1.0.0 · h ost · ")).toBe(true);
  });
});

describe("cli.ts wiring", () => {
  const cli = readFileSync(join(import.meta.dir, "..", "bin", "cli.ts"), "utf8").replace(/\r\n?/g, "\n");
  // 每个 `fetch(`${…}/api/auth/login|register`, {` 调用,取到它的 body: 那一行为止。
  const calls = [...cli.matchAll(/fetch\(`\$\{[^}]+\}\/api\/auth\/(login|register)`, \{[\s\S]*?\n\s*body: ([^\n]+)/g)]
    .map(m => ({ kind: m[1], body: m[2], line: cli.slice(0, m.index).split("\n").length }));

  test("found every auth call site (取集: the count is pinned — a new one must be looked at)", () => {
    // 2026-09-30:hub start 的探活(__probe__)、hub start 建默认账号、anet register、anet login、demo sci-team、node create --batch。
    expect(calls.length).toBe(6);
  });
  test("every real login / register sends a client_label; only the __probe__ liveness check does not", () => {
    const missing = calls.filter(c => !c.body.includes("client_label: loginClientLabel(") && !c.body.includes('"__probe__"'));
    expect(missing.map(c => `cli.ts:${c.line} ${c.body.trim()}`)).toEqual([]);
    expect(calls.filter(c => c.body.includes('"__probe__"')).length).toBe(1);
  });
  test("each label names its own subcommand", () => {
    const names = calls.map(c => /loginClientLabel\("([^"]+)"\)/.exec(c.body)?.[1]).filter(Boolean).sort();
    expect(names).toEqual(["demo sci-team", "hub start", "login", "node create --batch", "register"]);
  });
});
