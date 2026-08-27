import { describe, expect, it } from "bun:test";
import { parseDbTimestampMs } from "./db-timestamp.js";

const NAIVE = "2026-08-27 11:23:54";
const EXPECTED = Date.UTC(2026, 7, 27, 11, 23, 54);

describe("parseDbTimestampMs", () => {
  // ⚠ 这条在 `bun test` 下**没有分辨力**：bun test 进程的解析时区固定为 UTC
  // （实测 Intl…resolvedOptions().timeZone === "UTC"，即便系统是 Asia/Shanghai），
  // 裸 Date.parse 在那里恰好正确。真正的门是下面那条子进程断言。
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
