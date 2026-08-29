// #1469 f4 —— 裸 `--resume`（无 id）在非 TTY 里必须报错，而不是静默建一个
// 没有 resume 的默认 runtime 节点。
//
// 缺陷形状：parseCliOptions 把无值 flag 记成 "true"，而 resolveRuntimeForResume
// 曾把 "true" 排除在 resume 请求之外。后果不是「少推断一次」—— runtime 保持
// 默认 claude-agent-sdk，于是 cli.ts 里以 `=== "claude-code-cli"` 为条件的整块
// session 绑定逻辑被跳过，连 TTY 的选单都进不去。用户打了 --resume，拿到的是
// 一个没有 resume 的节点，零警告。
import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI = join(import.meta.dir, "..", "bin", "cli.ts");

// hub 指向一个确定连不上的端口：护栏只检查配置里有没有 hub，不在这一步发请求，
// 所以测试零网络访问，也不会碰到本机可能正在跑的真 hub。
const CFG = {
  hub: "http://127.0.0.1:65535",
  token: "utok_test_only_not_a_real_credential",
  network_id: "net_test_only",
};

function runCreate(extra: string[]) {
  const home = mkdtempSync(join(tmpdir(), "anet-1469f4-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "anet-1469f4-cwd-"));
  try {
    mkdirSync(join(home, ".anet"), { recursive: true });
    writeFileSync(join(home, ".anet", "config.json"), JSON.stringify(CFG), { mode: 0o600 });
    const r = spawnSync("bun", [CLI, "node", "create", "probe-node", ...extra], {
      cwd,
      env: { PATH: process.env.PATH ?? "", HOME: home },
      encoding: "utf8",
      timeout: 20_000,
      input: "",            // 空 stdin ⇒ 非 TTY
    });
    return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe("#1469 f4 非 TTY 下的裸 --resume", () => {
  test("🔴 裸 --resume 被当成 resume 请求 —— 推断出 claude-code-cli", () => {
    const r = runCreate(["--resume"]);
    // 修复前 runtime 保持默认 claude-agent-sdk，这一行根本不会打印
    expect(r.stdout).toContain("--resume 推断 runtime=claude-code-cli");
  });

  test("🔴 非 TTY 且没有 id ⇒ 给出可执行的下一步，而不是静默建节点", () => {
    const r = runCreate(["--resume"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("--resume 没有给 session id");
    // 判据落在「告诉了用户怎么办」上，不是只判它失败
    expect(r.stderr).toContain("--resume <session-id>");
    expect(r.stderr).toContain("--resume-latest");
  });

  test("分界没被推宽：根本没打 --resume 时不受影响", () => {
    // claude-code-cli + 非 TTY + 无 resume ⇒ 建新 session 是既有的正确行为。
    // 这条防的是我把新报错写得太宽、把它一起打红。
    const r = runCreate(["--runtime", "claude-code-cli"]);
    expect(r.stderr).not.toContain("--resume 没有给 session id");
  });
});
