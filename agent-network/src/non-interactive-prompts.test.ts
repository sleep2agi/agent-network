// #2293 —— 非交互环境里**不发起提问**：客户端把 CLI 当子进程拉起时，stdin 是一条一直被握着的管道。
//
// 缺陷形状（这是实测读数，不是推理）：
//   spawn("anet init", stdio:["pipe", ...]) 且不写 stdin、不关它
//   ⇒ 6 秒后进程仍在，stdout 只有一行 `CommHub URL (e.g. http://YOUR_IP:9200): `
//   ⇒ 客户端看到的既不是成功也不是失败，而是**卡住**；而且那行提示看起来像「还在正常工作」。
//
// 为什么这条要单独一个文件：`bare-resume-non-tty` 用的是 `input: ""`（stdin 立刻 EOF），
// 那种情况下 `rl.question` 会**立即**返回空串 —— 于是「会等」的缺陷在那种测试里看不出来。
// 必须有第二种 stdin 形状：**打开且不关闭**。同一个「非 TTY」，两种完全不同的行为。
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI = join(import.meta.dir, "..", "bin", "cli.ts");

/** 拉起子进程，**保持 stdin 打开**，最多等 killAfterMs。 */
function runWithOpenStdin(args: string[], killAfterMs = 8000): Promise<{ exited: boolean; code: number | null; out: string }> {
  const home = mkdtempSync(join(tmpdir(), "anet-2293-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "anet-2293-cwd-"));
  return new Promise((resolve) => {
    const child = spawn("bun", [CLI, ...args], {
      cwd,
      env: { PATH: process.env.PATH ?? "", HOME: home },
      stdio: ["pipe", "pipe", "pipe"], // ← 关键：管道一直被握着，没有 EOF
    });
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (out += String(d)));
    let done = false;
    const finish = (exited: boolean, code: number | null) => {
      if (done) return;
      done = true;
      try { child.kill("SIGKILL"); } catch {}
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
      resolve({ exited, code, out });
    };
    child.on("exit", (c) => finish(true, c));
    setTimeout(() => finish(false, null), killAfterMs);
  });
}

describe("#2293 非 TTY（打开且不关闭的 stdin）下不得等待输入", () => {
  test("🔴 `anet init` 没有 --hub：立刻报错并给出 `--hub`，而不是卡住", async () => {
    const r = await runWithOpenStdin(["init"]);
    // 修复前：这里 exited=false（一直等），stdout 只有提示串
    expect(r.exited).toBe(true);
    expect(r.code).not.toBe(0);
    // 判据落在「告诉了用户怎么办」上，而不是只判它失败
    expect(r.out).toContain("--hub");
    expect(r.out).toContain("anet init --hub");
  }, 20_000);

  test("分界没被推宽：给了 --hub 就不再走提问那条路", async () => {
    // hub 指向确定连不上的端口：护栏只读配置，这一步不该再问任何东西。
    const r = await runWithOpenStdin(["init", "--hub", "http://127.0.0.1:65535"]);
    expect(r.exited).toBe(true);
    // 它可能因为环境不同而后继提问；这里只钉「不再出现 hub 提示串」这一件事。
    expect(r.out).not.toContain("CommHub URL (e.g.");
  }, 20_000);

  test("通用兜底存在：非 TTY 的 ask() 不会把提示串当成功", async () => {
    // 用 node create 走另一条 ask 路径（缺 profile 时 interactiveCreateProfile 会提问）。
    // 它可能先被 hub 可达性拦住 —— 两种结局都行，**唯一不许的是「超时未退出」**。
    const r = await runWithOpenStdin(["node", "create", "probe-node-2293"]);
    expect(r.exited).toBe(true);
  }, 20_000);
});
