import { describe, expect, it } from "bun:test";
import { parseDbTimestampMs } from "./db-timestamp.js";

const NAIVE = "2026-08-27 11:23:54";
const EXPECTED = Date.UTC(2026, 7, 27, 11, 23, 54);

describe("parseDbTimestampMs", () => {
  // ⚠ 这条在 **TZ=UTC 的环境**下没有分辨力：裸 Date.parse 在 UTC 下恰好正确。
  // CI runner 与容器默认就是 UTC（本仓 Docker 套件亦然），所以缺陷在常规跑法里
  // 恒绿。（更正：Bun 是尊重 TZ 的，不存在"bun test 固定 UTC"——通信评审牛 #1279
  // 独审③ 独立复跑证伪了我最初的说法。）真正稳定见红的门是下面那条强制子进程。
  it("treats a naive SQLite timestamp as UTC", () => {
    expect(parseDbTimestampMs(NAIVE)).toBe(EXPECTED);
  });

  // 分辨力关键：宿主是 UTC 时,裸 Date.parse 与正确写法结果相同,断言恒绿。
  // 强制子进程 TZ=Asia/Shanghai,让缺陷在任何 CI 时区下都显形。
  it("is unaffected by a non-UTC host timezone (child process TZ=Asia/Shanghai)", () => {
    const r = Bun.spawnSync({
      cmd: ["bun", "-e",
        `const {parseDbTimestampMs} = await import("${import.meta.dir}/db-timestamp.ts");` +
        `console.log(parseDbTimestampMs("${NAIVE}"));`],
      env: { ...process.env, TZ: "Asia/Shanghai" },
    });
    expect(Number(r.stdout.toString().trim())).toBe(EXPECTED);
  });

  it("keeps explicit-offset timestamps intact", () => {
    expect(parseDbTimestampMs("2026-08-27T11:23:54Z")).toBe(EXPECTED);
    expect(parseDbTimestampMs("2026-08-27T19:23:54+08:00")).toBe(EXPECTED);
  });

  it("an online window of 60s holds for a heartbeat written 1s ago", () => {
    const now = Date.now();
    const iso = new Date(now - 1000).toISOString().slice(0, 19).replace("T", " ");
    expect(now - parseDbTimestampMs(iso)).toBeLessThanOrEqual(60_000);
  });
});
