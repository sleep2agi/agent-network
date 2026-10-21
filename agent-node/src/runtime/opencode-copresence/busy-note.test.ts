// #1879 —— 共享会话忙时的可见状态（含「已等多久」）。
import { describe, expect, test } from "bun:test";
import { busyNote } from "./busy-note.js";

describe("busyNote", () => {
  const base = 1_700_000_000_000;

  test("says the session is busy and the task was not submitted", () => {
    const note = busyNote(base, base);
    expect(note).toContain("共享会话忙");
    expect(note).toContain("任务还没提交");
  });

  test("shows seconds under a minute", () => {
    expect(busyNote(base, base + 20_000)).toContain("已等 20 秒");
  });

  test("shows minutes and seconds above a minute", () => {
    expect(busyNote(base, base + 200_000)).toContain("已等 3 分 20 秒");
  });

  test("never goes negative (clock skew)", () => {
    expect(busyNote(base, base - 5_000)).toContain("已等 0 秒");
  });

  test("names the shared session, so it is not read as a dead node", () => {
    expect(busyNote(base, base + 60_000)).toContain("共享会话");
  });
});
