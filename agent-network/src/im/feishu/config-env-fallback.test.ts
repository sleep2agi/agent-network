// 跨机节点的飞书密钥从哪来：**不是把 .env 拷过去**，是 Hub 保险库推到
// <nodeDir>/node-secrets.json，下次启动灌进 process.env。
//
// 这条测试钉的是读取顺序，因为两个方向都会出事：
//   · 只读 .env  ⇒ 跨机节点永远配不起来（试点节点在别人的 Space 上）
//   · env 优先   ⇒ 一个陈旧的 .env 会悄悄盖掉刚推下来的新密钥（排查时看不到）
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFeishuChannelConfig } from "./config";

const dirs: string[] = [];
function channelDir(envFile?: string, accessFile?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "feishu-cfg-"));
  dirs.push(dir);
  if (envFile !== undefined) writeFileSync(join(dir, ".env"), envFile);
  writeFileSync(join(dir, "access.json"), accessFile ?? JSON.stringify({ allowFrom: ["ou_x"], allowChats: [] }));
  return dir;
}
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe("#3682 飞书凭据：.env 优先，process.env 兜底", () => {
  test("只有 .env ⇒ 用 .env（今天的行为不变）", () => {
    const cfg = loadFeishuChannelConfig(channelDir("FEISHU_APP_ID=cli_file\nFEISHU_APP_SECRET=sec_file\n"), {});
    expect(cfg.appId).toBe("cli_file");
    expect(cfg.appSecret).toBe("sec_file");
  });

  test("没有 .env，但进程 env 里有 ⇒ 用它（跨机节点靠这条）", () => {
    const cfg = loadFeishuChannelConfig(channelDir(undefined), { FEISHU_APP_ID: "cli_env", FEISHU_APP_SECRET: "sec_env" });
    expect(cfg.appId).toBe("cli_env");
    expect(cfg.appSecret).toBe("sec_env");
  });

  test("🔴 两边都有 ⇒ **以 .env 为准**（不许让刚推下来的 env 悄悄改变语义，反之亦然）", () => {
    const cfg = loadFeishuChannelConfig(
      channelDir("FEISHU_APP_ID=cli_file\nFEISHU_APP_SECRET=sec_file\n"),
      { FEISHU_APP_ID: "cli_env", FEISHU_APP_SECRET: "sec_env" },
    );
    expect(cfg.appId).toBe("cli_file");
    expect(cfg.appSecret).toBe("sec_file");
  });

  test("文件里有一项、env 里有另一项 ⇒ 逐项兜底（不要求成对出现）", () => {
    const cfg = loadFeishuChannelConfig(channelDir("FEISHU_APP_ID=cli_file\n"), {
      FEISHU_APP_SECRET: "sec_env",
    });
    expect(cfg.appId).toBe("cli_file");
    expect(cfg.appSecret).toBe("sec_env");
  });

  test("两边都没有 ⇒ 抛错，且错误里**不含**任何值（只描述缺什么）", () => {
    let message = "";
    try {
      loadFeishuChannelConfig(channelDir(undefined), { FEISHU_APP_ID: "cli_only" });
    } catch (e: any) {
      message = String(e?.message || e);
    }
    expect(message).toContain("FEISHU_APP_ID / FEISHU_APP_SECRET missing");
    expect(message).not.toContain("cli_only");
  });

  test("空字符串不算「有」（env 里写了 FEISHU_APP_ID= 等于没配）", () => {
    expect(() => loadFeishuChannelConfig(channelDir(undefined), { FEISHU_APP_ID: "", FEISHU_APP_SECRET: "x" }))
      .toThrow(/missing/);
  });
});

describe("凭据别名：运维侧的 SF_APP_ID / SF_APP_KEY", () => {
  const dir = (envFile?: string) => {
    const d = mkdtempSync(join(tmpdir(), "feishu-alias-"));
    dirs.push(d);
    if (envFile !== undefined) writeFileSync(join(d, ".env"), envFile);
    writeFileSync(join(d, "access.json"), JSON.stringify({ allowFrom: ["ou_x"], allowChats: [] }));
    return d;
  };

  test(".env 里用 SF_APP_ID / SF_APP_KEY 也能读到", () => {
    const cfg = loadFeishuChannelConfig(dir("SF_APP_ID=cli_sf\nSF_APP_KEY=sec_sf\n"), {});
    expect(cfg.appId).toBe("cli_sf");
    expect(cfg.appSecret).toBe("sec_sf");
  });

  test("主名优先：两者都在时用 FEISHU_*", () => {
    const cfg = loadFeishuChannelConfig(
      dir("FEISHU_APP_ID=cli_main\nSF_APP_ID=cli_alias\nFEISHU_APP_SECRET=sec_main\nSF_APP_KEY=sec_alias\n"),
      {},
    );
    expect(cfg.appId).toBe("cli_main");
    expect(cfg.appSecret).toBe("sec_main");
  });

  test("别名也可来自 process.env（保险库推下来时常用这种名字）", () => {
    const cfg = loadFeishuChannelConfig(dir(undefined), { SF_APP_ID: "cli_env", SF_APP_KEY: "sec_env" });
    expect(cfg.appId).toBe("cli_env");
    expect(cfg.appSecret).toBe("sec_env");
  });

  test("一个主名一个别名混着也能拼起来", () => {
    const cfg = loadFeishuChannelConfig(dir("FEISHU_APP_ID=cli_main\n"), { SF_APP_KEY: "sec_env" });
    expect(cfg.appId).toBe("cli_main");
    expect(cfg.appSecret).toBe("sec_env");
  });
});
