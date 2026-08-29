// #1469 f1 —— 无名的 `anet node create` 交互向导必须走和带名路径同一套环境护栏，
// 且顺序一致：**先验环境，再向用户要输入**。
//
// 缺陷形状：`createCommand` 里 `if (!id) return createInteractiveCommand()` 短路得
// 比那两道门更早，于是最傻瓜的新手入口反而设防最少 —— hub 自探跳过、
// 「先验 hub 再问 model/key」的刻意顺序反过来、network 缺失时抛未捕获错。
//
// 🔴 测法上有一个环境限制，写在这里免得下一个人以为是漏测：
//    「hub 不通」那条**没法在本机端到端测** —— 自探硬编码 127.0.0.1:9200，
//    而开发/生产机上通常正跑着 hub，测试会真的连上它：既让用例因错误原因变绿，
//    又是在打生产。所以下面改用**等价且零网络**的判据：护栏必须在向导横幅
//    之前生效。横幅是向导的第一次输出，护栏先于它 = 顺序对了。
import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI = join(import.meta.dir, "..", "bin", "cli.ts");
const BANNER = "[anet] Create a node";

/** 起真的 CLI，HOME/cwd 都是一次性目录；global config 由调用方决定内容。 */
function runCreate(globalConfig: Record<string, unknown>) {
  const home = mkdtempSync(join(tmpdir(), "anet-1469-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "anet-1469-cwd-"));
  try {
    mkdirSync(join(home, ".anet"), { recursive: true });
    writeFileSync(join(home, ".anet", "config.json"), JSON.stringify(globalConfig), { mode: 0o600 });
    const r = spawnSync("bun", [CLI, "node", "create"], {
      cwd,
      env: { PATH: process.env.PATH ?? "", HOME: home },
      encoding: "utf8",
      timeout: 20_000,
      input: "",            // 非交互：stdin 立刻 EOF
    });
    return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe("#1469 f1 交互向导与带名路径共用环境护栏", () => {
  test("🔴 未登录 ⇒ 在打出向导横幅【之前】就给出可操作退出", () => {
    // hub 已配置（所以不会去 fetch 任何东西），但没有 token。
    const r = runCreate({ hub: "http://127.0.0.1:65535" });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("Not logged in");
    expect(r.stderr).toContain("anet login");
    // 判据落在**顺序**上：修复前向导会先打横幅、问 runtime、问厂商和 key，
    // 直到 requestNodeToken 才炸。
    expect(r.stdout).not.toContain(BANNER);
  });

  test("🔴 network_id 缺失 ⇒ 可操作退出，不是未捕获的 throw", () => {
    const r = runCreate({ hub: "http://127.0.0.1:65535", token: "utok_test_only_not_a_real_credential" });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("missing network_id");
    expect(r.stderr).toContain("anet network ls");
    expect(r.stderr).toContain("anet network use");
    // 修复前这里是 requestNodeToken 抛的 Error —— 用户看到堆栈而不是下一步
    expect(r.stderr).not.toContain("at requestNodeToken");
    expect(r.stdout).not.toContain(BANNER);
  });

  test("护栏只有一份实现 —— 两条路径共用，不会各自漂开", async () => {
    const src = await Bun.file(CLI).text();
    // 🔴 这两句提示在整个 cli.ts 里本来就出现多次（hub start / node start 等
    //    别的命令也用），所以「全文只出现一次」是我一开始凭空假设的判据，错的。
    //    真正要守的是：**创建路径**只有一份实现 —— 两个 helper 各定义一次，
    //    且 createCommand 与 createInteractiveCommand 都只通过调用使用它们。
    expect(src.split("async function ensureHubConfigured(").length - 1).toBe(1);
    expect(src.split("function ensureLoginAndNetwork(").length - 1).toBe(1);
    // 两条路径各自都在引用（各 1 次调用，共 2 次出现：1 定义 + 2 调用）
    expect(src.split("ensureHubConfigured(").length - 1).toBe(3);
    expect(src.split("ensureLoginAndNetwork(").length - 1).toBe(3);
    // 而且交互向导里，护栏调用必须排在横幅之前
    const iStart = src.indexOf("async function createInteractiveCommand()");
    expect(iStart).toBeGreaterThan(-1);
    const iGuard = src.indexOf("ensureHubConfigured(loadGlobal())", iStart);
    const iBanner = src.indexOf(BANNER, iStart);
    expect(iGuard).toBeGreaterThan(-1);
    expect(iBanner).toBeGreaterThan(-1);
    expect(iGuard).toBeLessThan(iBanner);
  });
});
