import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { applyOwnerScheduleIntent, finalizeOwnerScheduleIntent, systemCrontabAdapter } from "./owner-schedule-control.js";

// 这条测试要验证的是「systemCrontabAdapter 能不能正确读改写一份 crontab 文本」。
// 它**不需要**用用户真实的那一份 —— adapter 走 spawnSync("crontab", …)，也就是走 PATH。
//
// 原来的写法直接用真实 crontab，清理还用 `crontab -r`（整份删除）。
// 2026-11-13 实证后果：谁在开发机上跑一次 agent-node 测试，谁的机器就丢掉整份 crontab：
//   (vansin) DELETE 11-10 09:31/09:32/09:38、11-13 07:30/07:35/07:40/07:47
// 连带 hub-backup / 磁盘守卫 / 各类巡检停摆数十小时，而"没报错"与"没在跑"在日志里同形。
//
// 现在：默认把 PATH 前面插一个 `crontab` 替身（临时目录里的小脚本），
// 覆盖照样真跑（1 pass），真实 crontab 一个字节都不会被碰。
// 只有在容器里**显式**要打真机时才设 ANET_TEST_REAL_CRONTAB=1 —— 那时也改成
// 「先快照、后还原」，绝不用 `crontab -r`（删除 ≠ 还原）。
const REAL_CRONTAB = process.env.ANET_TEST_REAL_CRONTAB === "1";

let shimDir: string | null = null;
let savedCrontab: string | null = null;

/** 把 crontab 换成一个只读写状态文件的替身：-l 打印 / - 写入 / -r 删除。 */
function installShim(): void {
  shimDir = mkdtempSync(join(tmpdir(), "anet-crontab-shim-"));
  const state = join(shimDir, "state.txt");
  const script = [
    "#!/bin/sh",
    `f='${state}'`,
    'case "$1" in',
    '  -l) [ -f "$f" ] && cat "$f" || { echo "no crontab" >&2; exit 1; };;',
    '  -r) rm -f "$f"; exit 0;;',
    '  -)  cat > "$f.tmp" && mv "$f.tmp" "$f"; exit 0;;',
    '  *)  echo "crontab-shim: unsupported args: $*" >&2; exit 2;;',
    "esac",
    "",
  ].join("\n");
  const path = join(shimDir, "crontab");
  writeFileSync(path, script, { mode: 0o755 });
  process.env.PATH = `${shimDir}:${process.env.PATH ?? ""}`;
}

const restoreCrontab = () => {
  if (savedCrontab === null) spawnSync("crontab", ["-r"]);
  else spawnSync("crontab", ["-"], { input: savedCrontab, encoding: "utf8" });
};

beforeAll(() => {
  if (!REAL_CRONTAB) installShim();
  const r = spawnSync("crontab", ["-l"], { encoding: "utf8" });
  savedCrontab = r.status === 0 ? r.stdout : null;
});

afterAll(() => {
  restoreCrontab();
  if (shimDir) rmSync(shimDir, { recursive: true, force: true });
});

describe("owner schedule real crontab adapter", () => {
  test("round-trips an exact managed marker through the container crontab", () => {
    const root = mkdtempSync(join(tmpdir(), "anet-real-crontab-"));
    chmodSync(root, 0o700);
    const configPath = join(root, "config.json");
    writeFileSync(configPath, "{}\n", { mode: 0o600 });
    const tail = " /usr/bin/grok-news --latest";
    const hash = createHash("sha256").update(tail).digest("hex");
    const before = [
      `# ANET-MANAGED-SCHEDULE node_id=n_real_cron id=news-pull revision=3 command_sha256=${hash}`,
      `0 */6 * * *${tail}`,
      "# ANET-MANAGED-SCHEDULE-END node_id=n_real_cron id=news-pull",
      "",
    ].join("\n");
    const adapter = systemCrontabAdapter();
    try {
      adapter.install(before);
      const result = applyOwnerScheduleIntent({
        configPath,
        expectedNodeId: "n_real_cron",
        intent: {
          intent_id: "sei_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          node_id: "n_real_cron",
          schedule_id: "news-pull",
          base_revision: 3,
          patch: { cron: "15 */12 * * *", enabled: false },
        },
      });
      const actual = adapter.read();
      expect(actual).toContain("revision=4");
      expect(actual).toContain(`# ANET-DISABLED 15 */12 * * *${tail}`);
      expect(actual).not.toContain("command=");
      finalizeOwnerScheduleIntent(configPath, result.status === "applied" ? "sei_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" : "");
    } finally {
      restoreCrontab();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
