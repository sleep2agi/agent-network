import { describe, expect, test } from "bun:test";
import { windowsChildPath, withWindowsChildPath } from "./windows-child-env.js";

const root = "C:\\Windows";

describe("windowsChildPath — 只补缺，不重复，不猜盘符", () => {
  test("PATH 里没有 PowerShell ⇒ 补 System32 + WindowsPowerShell\\v1.0", () => {
    const out = windowsChildPath("C:\\Tools", { execDir: "C:\\node", systemRoot: root, platform: "win32" });
    expect(out).toBe("C:\\node;C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0;C:\\Tools");
  });

  test("已经在 PATH 里的大小写变体不重复加", () => {
    const existing = "c:\\windows\\system32;c:\\windows\\system32\\windowspowershell\\v1.0;C:\\Tools";
    const out = windowsChildPath(existing, { execDir: "C:\\node", systemRoot: root, platform: "win32" });
    expect(out).toBe("C:\\node;" + existing);
  });

  test("SystemRoot 缺失或非绝对路径 ⇒ 只补 execDir（不猜目录）", () => {
    for (const bad of [undefined, "", "Windows", "..\\Windows"]) {
      expect(windowsChildPath("C:\\Tools", { execDir: "C:\\node", systemRoot: bad, platform: "win32" })).toBe("C:\\node;C:\\Tools");
    }
  });

  test("空 PATH 也不产生空条目", () => {
    expect(windowsChildPath(undefined, { execDir: "C:\\node", systemRoot: root, platform: "win32" }))
      .toBe("C:\\node;C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0");
  });

  test("非 win32 原样返回（不参与 POSIX 的 PATH 组装）", () => {
    expect(windowsChildPath("/usr/bin", { execDir: "/n", systemRoot: root, platform: "linux" })).toBe("/usr/bin");
  });
});

describe("withWindowsChildPath — 只改子进程 PATH", () => {
  test("win32 用 SystemRoot 推导，其它键原样保留", () => {
    const env = { PATH: "C:\\Tools", SystemRoot: root, FOO: "bar" } as NodeJS.ProcessEnv;
    const out = withWindowsChildPath(env, { execDir: "C:\\node", platform: "win32" });
    expect(out.PATH).toContain("C:\\Windows\\System32\\WindowsPowerShell\\v1.0");
    expect(out.FOO).toBe("bar");
    expect(out.SystemRoot).toBe(root);
    expect(env.PATH).toBe("C:\\Tools"); // 不改调用方对象
  });

  test("win32 没有 SystemRoot 时退回 windir", () => {
    const env = { PATH: "C:\\Tools", windir: "D:\\Win" } as NodeJS.ProcessEnv;
    expect(withWindowsChildPath(env, { execDir: "D:\\node", platform: "win32" }).PATH)
      .toContain("D:\\Win\\System32\\WindowsPowerShell\\v1.0");
  });

  test("linux 完全不动 env", () => {
    const env = { PATH: "/usr/bin" } as NodeJS.ProcessEnv;
    expect(withWindowsChildPath(env, { platform: "linux" })).toBe(env);
  });
});
