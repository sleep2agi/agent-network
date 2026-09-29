import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { drainInbox } from "./inbox-drain";
import {
  DEFAULT_INBOX_POLL_MS,
  createSingleFlight,
  inboxPollIntervalMs,
  isInboxWakeEvent,
  startInboxSafetyNet,
} from "./channel-inbox-wake";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("channel inbox wake events", () => {
  test("a peer's send_reply (new_reply) wakes the inbox drain", () => {
    expect(isInboxWakeEvent("new_reply")).toBe(true);
  });

  test("new_task and broadcast still wake it", () => {
    expect(isInboxWakeEvent("new_task")).toBe(true);
    expect(isInboxWakeEvent("broadcast")).toBe(true);
  });

  test("doorbells with their own handlers and unknown input do not", () => {
    for (const type of ["connected", "new_message", "rules_file", "config_update", "", undefined, 1]) {
      expect(isInboxWakeEvent(type)).toBe(false);
    }
  });
});

describe("single-flight drain", () => {
  test("overlapping wakeups never run two drains at once and collapse into one rerun", async () => {
    let running = 0;
    let maxRunning = 0;
    let runs = 0;
    const drain = createSingleFlight(async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      runs++;
      await sleep(15);
      running--;
    });
    await Promise.all([drain(), drain(), drain(), drain()]);
    expect(maxRunning).toBe(1);
    expect(runs).toBe(2);
  });

  test("a failed drain does not wedge later ones", async () => {
    let calls = 0;
    const drain = createSingleFlight(async () => {
      calls++;
      if (calls === 1) throw new Error("hub down");
    });
    await expect(drain()).rejects.toThrow("hub down");
    await drain();
    expect(calls).toBe(2);
  });

  test("a poll racing an SSE wakeup injects each unacked row exactly once", async () => {
    // Fake inbox with ack semantics like the hub: get_inbox returns unacked rows.
    const inbox = [{ id: "a", acked: false }, { id: "b", acked: false }];
    const injected: string[] = [];
    const drain = createSingleFlight(async () => {
      await drainInbox<{ id: string }>({
        pageSize: 5,
        fetchPage: async (limit) => {
          await sleep(5);
          return { ok: true, messages: inbox.filter((m) => !m.acked).slice(0, limit).map(({ id }) => ({ id })) };
        },
        handle: async (msg) => {
          injected.push(msg.id);
          await sleep(5);
          inbox.find((m) => m.id === msg.id)!.acked = true;
        },
      });
    });
    await Promise.all([drain(), drain()]);
    expect(injected.sort()).toEqual(["a", "b"]);
  });
});

describe("periodic safety net", () => {
  test("drains on its own when no push ever arrives", async () => {
    let drains = 0;
    const stop = startInboxSafetyNet({ intervalMs: 10, drain: async () => { drains++; } });
    await sleep(55);
    stop();
    expect(drains).toBeGreaterThanOrEqual(2);
    const settled = drains;
    await sleep(30);
    expect(drains).toBe(settled);
  });

  test("interval 0 disables it", async () => {
    let drains = 0;
    const stop = startInboxSafetyNet({ intervalMs: 0, drain: async () => { drains++; } });
    await sleep(30);
    stop();
    expect(drains).toBe(0);
  });

  test("a failing poll is reported, not thrown", async () => {
    const errors: unknown[] = [];
    const stop = startInboxSafetyNet({
      intervalMs: 10,
      drain: async () => { throw new Error("boom"); },
      onError: (e) => errors.push(e),
    });
    await sleep(35);
    stop();
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  test("ANET_CHANNEL_INBOX_POLL_MS parsing", () => {
    expect(DEFAULT_INBOX_POLL_MS).toBe(60_000);
    expect(inboxPollIntervalMs(undefined)).toBe(60_000);
    expect(inboxPollIntervalMs("")).toBe(60_000);
    expect(inboxPollIntervalMs("abc")).toBe(60_000);
    expect(inboxPollIntervalMs("-5")).toBe(60_000);
    expect(inboxPollIntervalMs("0")).toBe(0);
    expect(inboxPollIntervalMs("15000")).toBe(15_000);
  });
});

// node-server.ts is a side-effecting entrypoint (importing it dials the hub),
// so its wiring is pinned against source text, as in
// node-server-activity-log-wiring.test.ts.
describe("node-server wiring", () => {
  const src = readFileSync(join(import.meta.dir, "node-server.ts"), "utf8");
  const handler = src.slice(src.indexOf("async function handleSSEEvent"), src.indexOf("\n}\n", src.indexOf("async function handleSSEEvent")));

  test("handleSSEEvent routes inbox wakeups through isInboxWakeEvent to the single-flight drain", () => {
    expect(handler).toContain("if (isInboxWakeEvent(event.type)) {");
    expect(handler).toContain("await drainChannelInbox();");
    expect(handler).not.toContain('event.type === "new_task" || event.type === "broadcast"');
    expect(src).toContain("const drainChannelInbox = createSingleFlight(");
  });

  test("main() starts the safety net with the env-configured period", () => {
    const main = src.slice(src.indexOf("async function main()"));
    expect(main).toContain("inboxPollIntervalMs(process.env.ANET_CHANNEL_INBOX_POLL_MS)");
    expect(main).toContain("startInboxSafetyNet({");
    // Outbound-only mode owns no inbox; the poll must come after that early return.
    expect(main.indexOf("startInboxSafetyNet({")).toBeGreaterThan(main.indexOf("if (OUTBOUND_ONLY)"));
  });
});
