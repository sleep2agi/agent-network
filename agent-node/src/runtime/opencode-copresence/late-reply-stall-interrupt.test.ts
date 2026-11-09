import { describe, expect, test } from "bun:test";
import { watchLateReply } from "./v2-session";

// 通信欧 (2026-11-08 17:32 UTC): our delivered turn hung inside a tool call that
// never returned. The late-reply window closed, nobody interrupted the turn, and
// the shared OpenCode V2 session stayed "busy" for 11 h — every later task timed
// out behind it. The watcher now interrupts our own turn when it is provably
// stalled at window close, and leaves everything else alone.
describe("late-reply watcher: wedge breaker", () => {
  const clock = () => { let t = 0; return { now: () => t, sleep: async (ms: number) => { t += ms; } }; };

  test("our turn, pending, no history change for ≥ stallMs at window close → interrupt once", async () => {
    const c = clock(); const logs: string[] = []; let interrupts = 0;
    await watchLateReply({
      threadId: "ses_x", turnId: "msg_y",
      readEntries: async () => [{ id: "a1", type: "assistant" } as any],
      isRunning: () => true, onLateReply: () => { throw new Error("must not reply"); },
      evaluate: () => ({ state: "pending" }),
      capMs: 60_000, stallMs: 30_000, now: c.now, sleep: c.sleep, log: (m) => logs.push(m),
      interruptStalled: async () => { interrupts += 1; return true; },
    });
    expect(interrupts).toBe(1);
    expect(logs.join("\n")).toContain("session interrupt succeeded");
  });

  test("history still moving near window close → no interrupt (slow but alive)", async () => {
    const c = clock(); let n = 0; let interrupts = 0;
    await watchLateReply({
      threadId: "ses_x", turnId: "msg_y",
      readEntries: async () => { n += 1; return Array.from({ length: n }, (_, i) => ({ id: `a${i}`, type: "assistant" } as any)); },
      isRunning: () => true, onLateReply: () => {}, evaluate: () => ({ state: "pending" }),
      capMs: 60_000, stallMs: 30_000, now: c.now, sleep: c.sleep,
      interruptStalled: async () => { interrupts += 1; return true; },
    });
    expect(interrupts).toBe(0);
  });

  test("history never readable → cannot prove the live turn is ours → no interrupt", async () => {
    const c = clock(); let interrupts = 0;
    await watchLateReply({
      threadId: "ses_x", turnId: "msg_y",
      readEntries: async () => null, isRunning: () => true, onLateReply: () => {},
      capMs: 60_000, stallMs: 1, now: c.now, sleep: c.sleep,
      interruptStalled: async () => { interrupts += 1; return true; },
    });
    expect(interrupts).toBe(0);
  });

  test("turn finished inside the window → late reply, no interrupt", async () => {
    const c = clock(); const replies: any[] = []; let interrupts = 0;
    await watchLateReply({
      threadId: "ses_x", turnId: "msg_y",
      readEntries: async () => [{ id: "a1" } as any], isRunning: () => true,
      onLateReply: (p) => { replies.push(p); }, evaluate: () => ({ state: "done", replyText: "ok" }),
      capMs: 60_000, stallMs: 1, now: c.now, sleep: c.sleep,
      interruptStalled: async () => { interrupts += 1; return true; },
    });
    expect(replies).toHaveLength(1);
    expect(interrupts).toBe(0);
  });

  test("interrupt failure is logged, never thrown", async () => {
    const c = clock(); const logs: string[] = [];
    await watchLateReply({
      threadId: "ses_x", turnId: "msg_y",
      readEntries: async () => [{ id: "a1" } as any], isRunning: () => true, onLateReply: () => {},
      evaluate: () => ({ state: "pending" }), capMs: 60_000, stallMs: 1, now: c.now, sleep: c.sleep,
      log: (m) => logs.push(m), interruptStalled: async () => { throw new Error("ECONNRESET"); },
    });
    expect(logs.join("\n")).toContain("session interrupt FAILED");
  });

  test("without interruptStalled (old callers) behaviour is unchanged", async () => {
    const c = clock(); const logs: string[] = [];
    await watchLateReply({
      threadId: "ses_x", turnId: "msg_y",
      readEntries: async () => [{ id: "a1" } as any], isRunning: () => true, onLateReply: () => {},
      evaluate: () => ({ state: "pending" }), capMs: 60_000, now: c.now, sleep: c.sleep, log: (m) => logs.push(m),
    });
    expect(logs.join("\n")).toContain("late-reply window closed");
    expect(logs.join("\n")).not.toContain("interrupt");
  });
});
