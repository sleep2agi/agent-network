// 2026-10-31 —— 「缺失必须拒绝启动，而不是加兜底」。
//
// 这个断言只测**判据**（requireEnv），不测启动副作用：启动路径里 process.exit(2)
// 会让测试进程直接退出，那是另一类证据（子进程），不该混在这里。
import { describe, expect, test } from "bun:test";
import { requireEnv } from "./env-required.js";

describe("upload-file stdio MCP refuses to start without its required env", () => {
  test("两个都缺 ⇒ 点名两个（不是只说『配置错误』）", () => {
    const r = requireEnv({});
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.missing).toHaveLength(2);
    expect(r.missing.join(" ")).toContain("COMMHUB_URL");
    expect(r.missing.join(" ")).toContain("COMMHUB_TOKEN");
  });

  test("只缺 token ⇒ 只点 token（缺什么说什么）", () => {
    const r = requireEnv({ COMMHUB_URL: "https://hub.example.test" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.missing).toHaveLength(1);
    expect(r.missing[0]).toContain("COMMHUB_TOKEN");
  });

  test("空字符串不算「配了」（`export X=` 是最常见的半配置）", () => {
    const r = requireEnv({ COMMHUB_URL: "", COMMHUB_TOKEN: "" });
    expect(r.ok).toBe(false);
  });

  test("兼容名 AUTH_TOKEN 可替代 token，但 URL 仍然必填", () => {
    const withAlias = requireEnv({ COMMHUB_URL: "https://hub.example.test", AUTH_TOKEN: "t" });
    expect(withAlias.ok).toBe(true);
    if (!withAlias.ok) throw new Error("unreachable");
    expect(withAlias.token).toBe("t");

    const noUrl = requireEnv({ AUTH_TOKEN: "t" });
    expect(noUrl.ok).toBe(false);
  });

  test("URL 末尾斜杠被规范掉（否则拼出的 /api/upload 会变成 //api/upload）", () => {
    const r = requireEnv({ COMMHUB_URL: "https://hub.example.test///", COMMHUB_TOKEN: "t" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.hub).toBe("https://hub.example.test");
  });
});
