import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { shouldSkipTerminalTask, isTerminalTaskStatus } from "./terminal-task-guard";

describe("terminal-task-guard (#1900: a queued task answered early must not start a turn later)", () => {
  test("replied/failed/cancelled/expired are terminal; open states are not", () => {
    for (const s of ["replied", "failed", "cancelled", "expired"]) expect(isTerminalTaskStatus(s)).toBe(true);
    for (const s of ["created", "delivered", "acked", "running", "", undefined, null, 42]) expect(isTerminalTaskStatus(s as any)).toBe(false);
  });

  test("skips a task the hub already reports as replied", async () => {
    const v = await shouldSkipTerminalTask(async () => ({ ok: true, task: { status: "replied" } }), "t1");
    expect(v).toEqual({ skip: true, status: "replied", reason: "terminal" });
  });

  test("lets an open task through", async () => {
    const v = await shouldSkipTerminalTask(async () => ({ ok: true, task: { status: "delivered" } }), "t1");
    expect(v).toEqual({ skip: false, status: "delivered", reason: "open" });
  });

  test("fails open: lookup error, not-found, and missing id never block delivery", async () => {
    expect((await shouldSkipTerminalTask(async () => { throw new Error("hub down"); }, "t1")).reason).toBe("lookup-failed");
    expect((await shouldSkipTerminalTask(async () => ({ ok: false }), "t1")).reason).toBe("not-found");
    expect((await shouldSkipTerminalTask(async () => null, "t1")).reason).toBe("not-found");
    expect((await shouldSkipTerminalTask(async () => ({ ok: true, task: { status: "replied" } }), "")).reason).toBe("no-task-id");
    for (const r of [await shouldSkipTerminalTask(async () => { throw new Error("x"); }, "t1"), await shouldSkipTerminalTask(async () => ({ ok: false }), "t1")]) expect(r.skip).toBe(false);
  });

  test("cli.ts consults the guard before a task starts a turn, and acks the skipped row", () => {
    const src = readFileSync(join(import.meta.dir, "..", "cli.ts"), "utf8");
    const guardAt = src.indexOf("shouldSkipTerminalTask(");
    const skipAt = src.indexOf("const skip = shouldSkipMessage(from, content, msgType, msg);");
    expect(guardAt).toBeGreaterThan(0);
    expect(guardAt).toBeLessThan(skipAt);
    expect(src.includes('await ackAndRecordConsumed(msg, "terminal");')).toBe(true);
    expect(src.includes('import { shouldSkipTerminalTask } from "./runtime/terminal-task-guard";')).toBe(true);
  });
});
