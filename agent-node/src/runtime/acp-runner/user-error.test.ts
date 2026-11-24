import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatJsonRpcErrorForTest } from "./client";
import { attachAcpUserReplyText, formatAcpUserError } from "./user-error";
import { runtimeErrorReplyText } from "../unverified-reply-text";
import { runAgyAcpTurn } from "../antigravity-acp/runtime";

const REAL_AGY_NO_BROWSER_ERROR =
  "No browser is available here (no graphical display is available to open a browser). " +
  "Run `agy acp --login` in a terminal on this machine, then retry; or use a Gemini API key.";

describe("formatAcpUserError —— 报错归并纯函数", () => {
  test("Antigravity 未登录（真机 -32603 原文）→ 人话 + 下一步，不露 -32603 / ACP / grok", () => {
    const raw = new Error(`antigravity ACP error -32603: ${REAL_AGY_NO_BROWSER_ERROR}`);
    const out = formatAcpUserError("antigravity", raw);
    expect(out).toBe(
      "这台机器上的 Antigravity 还没有登录。请在那台机器的终端里运行 `agy acp --login` 完成登录，然后再发一次。",
    );
    expect(out).not.toContain("-32603");
    expect(out).not.toContain("ACP");
    expect(out?.toLowerCase()).not.toContain("grok");
  });

  test("authenticate 无可用非交互方式 → 按运行时区分登录命令", () => {
    const agyOut = formatAcpUserError(
      "antigravity",
      new Error('antigravity ACP authenticate failed: no supported non-interactive auth method (advertised=["gemini-api-key"])'),
    );
    expect(agyOut).toContain("Antigravity 还没有登录");
    expect(agyOut).toContain("`agy acp --login`");

    const grokOut = formatAcpUserError(
      "grok",
      new Error('grok ACP authenticate failed: no supported non-interactive auth method (advertised=[])'),
    );
    expect(grokOut).toContain("Grok 还没有登录");
    expect(grokOut).toContain("`grok login`");
  });

  test("没装 CLI（ENOENT）→ 人话 + 安装提示（不露 PATH / AGY_BIN / ACP）", () => {
    const enoent = Object.assign(new Error("spawn agy ENOENT"), { code: "ENOENT" });
    const agyOut = formatAcpUserError("antigravity", enoent);
    expect(agyOut).toBe("这台机器上找不到 Antigravity 程序。请确认已安装，再发一次。");
    expect(agyOut).not.toContain("ACP");
    expect(agyOut).not.toContain("PATH");
    expect(agyOut).not.toContain("AGY_BIN");

    const grokOut = formatAcpUserError("grok", new Error("spawn grok ENOENT"));
    expect(grokOut).toBe("这台机器上找不到 Grok 程序。请确认已安装，再发一次。");
  });

  test("额度用完（#1941 真机 402 原文）→ 人话，不露 -32603 / ACP / JSON", () => {
    const err = Object.assign(new Error("grok ACP error -32603: Internal error"), {
      code: -32603,
      data: {
        message: "API error (status 402 Payment Required): Grok Build usage balance exhausted",
        http_status: 402,
      },
    });
    const out = formatAcpUserError("grok", err);
    expect(out).toBe("这台机器上 Grok 账号的额度已经用完了。请充值或换一个还有额度的账号，然后再发一次。");
    expect(out).not.toContain("-32603");
    expect(out).not.toContain("ACP");
    expect(out).not.toContain("{");
  });

  test("网络不通（Grok reqwest 原文）→ 人话 + 检查网络/代理", () => {
    const err = Object.assign(new Error("grok ACP error -32603: Internal error"), {
      code: -32603,
      data: {
        message: "reqwest error stream: error sending request for url (https://cli-chat-proxy.grok.com/v1/responses)",
      },
    });
    const out = formatAcpUserError("grok", err);
    expect(out).toBe("这台机器暂时连不上 Grok 服务。请检查这台机器的网络或代理设置，然后再发一次。");
    expect(out).not.toContain("-32603");
    expect(out).not.toContain("ACP");
  });

  test("未知报错 → 返回 null（不乱编）", () => {
    expect(formatAcpUserError("antigravity", new Error("antigravity ACP error -32602: invalid params"))).toBeNull();
    expect(formatAcpUserError("grok", new Error("something unexpected"))).toBeNull();
  });

  test("attachAcpUserReplyText 保留原始 err.message 给节点日志，并给用户回复挂 userReplyText", () => {
    const rawMsg = `antigravity ACP error -32603: ${REAL_AGY_NO_BROWSER_ERROR}`;
    const err = attachAcpUserReplyText(new Error(rawMsg), "antigravity");
    // 日志仍拿得到完整原文
    expect(err.message).toBe(rawMsg);
    // 用户看到的回复是短人话，没有 -32603 / ACP / grok
    const userReply = runtimeErrorReplyText("antigravity", err);
    expect(userReply).toBe(
      "这台机器上的 Antigravity 还没有登录。请在那台机器的终端里运行 `agy acp --login` 完成登录，然后再发一次。",
    );
  });

  test("formatJsonRpcError 按实际 runtimeLabel 拼前缀，antigravity 不再出现 grok 标签", () => {
    const text = formatJsonRpcErrorForTest(
      { code: -32603, message: REAL_AGY_NO_BROWSER_ERROR },
      "antigravity",
    );
    expect(text).toStartWith("antigravity ACP error -32603:");
    expect(text.toLowerCase()).not.toContain("grok");

    const quota = formatJsonRpcErrorForTest(
      { code: -32603, message: "Internal error", data: { http_status: 402, message: "402 Payment Required" } },
      "antigravity",
    );
    expect(quota).toStartWith("antigravity ACP error -32603:");
    expect(quota.toLowerCase()).not.toContain("grok");
  });
});

describe("runAgyAcpTurn 假 CLI 端到端复现（未登录 -32603）", () => {
  test("假 CLI 返回真机 -32603 未登录报错：日志保留 antigravity 原文，用户只看到人话", async () => {
    if (process.platform === "win32") return;
    const cwd = mkdtempSync(join(tmpdir(), "agy-unlogged-repro-"));
    const fakeBin = join(cwd, "fake-agy.js");
    writeFileSync(
      fakeBin,
      `#!/usr/bin/env node
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, authMethods: [{ id: "oauth-personal" }] } });
    return;
  }
  if (msg.method === "authenticate") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32603, message: ${JSON.stringify(REAL_AGY_NO_BROWSER_ERROR)} },
    });
    setTimeout(() => process.exit(0), 20);
  }
});
`,
      { mode: 0o755 },
    );
    chmodSync(fakeBin, 0o755);

    try {
      let caught: any;
      try {
        await runAgyAcpTurn({
          prompt: "hello",
          cwd,
          binary: fakeBin,
          handshakeTimeoutMs: 5_000,
          timeoutMs: 5_000,
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeTruthy();
      // 1. 节点日志拿到的原始 err.message 标签是 antigravity（不是 grok）
      expect(caught.message).toContain("antigravity ACP error -32603:");
      expect(caught.message).toContain("No browser is available here");
      expect(caught.message.toLowerCase()).not.toContain("grok");
      // 2. 用户看到的回复说人话、给下一步，不出现 -32603 / ACP / grok
      const reply = runtimeErrorReplyText("antigravity", caught);
      expect(reply).toBe(
        "这台机器上的 Antigravity 还没有登录。请在那台机器的终端里运行 `agy acp --login` 完成登录，然后再发一次。",
      );
      expect(reply).not.toContain("-32603");
      expect(reply).not.toContain("ACP");
      expect(reply.toLowerCase()).not.toContain("grok");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
