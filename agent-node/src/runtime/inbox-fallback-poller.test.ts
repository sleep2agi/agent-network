import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  DEFAULT_INBOX_FALLBACK_POLL_MS,
  MAX_INBOX_FALLBACK_POLL_MS,
  MIN_INBOX_FALLBACK_POLL_MS,
  classifyFallbackInboxMessages,
  createInboxFallbackPoller,
  resolveInboxFallbackPollMs,
  type FallbackInboxMessage,
  type InboxFallbackPollAdapters,
} from "./inbox-fallback-poller";
import { createInboxDrainLane } from "./inbox-drain-lane";
import { dispatchInboxBatch } from "../inbox-dispatch";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function createHarness(overrides: Partial<InboxFallbackPollAdapters> = {}) {
  const inbox: FallbackInboxMessage[] = [];
  const inflight = new Set<string>();
  let suspended = false;
  const workDrains: string[] = [];
  const infoDrains: string[] = [];
  const logs: string[] = [];
  const debugs: string[] = [];
  const warnings: string[] = [];
  const timers: Array<{ id: number; callback: () => void; delay: number; cleared: boolean }> = [];
  let nextTimerId = 1;

  const adapters: InboxFallbackPollAdapters = {
    getInbox: async () => [...inbox],
    scheduleWorkDrain: () => workDrains.push("work"),
    scheduleInformationalDrain: () => infoDrains.push("info"),
    isSuspended: () => suspended,
    isInflight: (id) => inflight.has(id),
    selfAlias: () => "pigeon-2",
    splitOpencodeInformational: false,
    log: (m) => logs.push(m),
    debug: (m) => debugs.push(m),
    warn: (m) => warnings.push(m),
    random: () => 0,
    setTimer: (callback, delay) => {
      const entry = { id: nextTimerId++, callback, delay, cleared: false };
      timers.push(entry);
      return entry;
    },
    clearTimer: (handle) => {
      const entry = handle as { cleared: boolean } | null;
      if (entry) entry.cleared = true;
    },
    ...overrides,
  };

  return {
    inbox,
    inflight,
    setSuspended(value: boolean) { suspended = value; },
    workDrains,
    infoDrains,
    logs,
    debugs,
    warnings,
    timers,
    adapters,
    activeTimer() {
      return [...timers].reverse().find((t) => !t.cleared) ?? null;
    },
    fireActiveTimer() {
      const current = [...timers].reverse().find((t) => !t.cleared);
      if (!current) throw new Error("no active timer to fire");
      current.cleared = true;
      current.callback();
    },
  };
}

describe("non-codex inbox fallback poller (#3902)", () => {
  test("resolveInboxFallbackPollMs bounds configured values and falls back to default", () => {
    expect(resolveInboxFallbackPollMs(undefined)).toBe(DEFAULT_INBOX_FALLBACK_POLL_MS);
    expect(resolveInboxFallbackPollMs("")).toBe(DEFAULT_INBOX_FALLBACK_POLL_MS);
    expect(resolveInboxFallbackPollMs("not-a-number")).toBe(DEFAULT_INBOX_FALLBACK_POLL_MS);
    expect(resolveInboxFallbackPollMs(100)).toBe(MIN_INBOX_FALLBACK_POLL_MS);
    expect(resolveInboxFallbackPollMs(9_999_999)).toBe(MAX_INBOX_FALLBACK_POLL_MS);
    expect(resolveInboxFallbackPollMs(30_000)).toBe(30_000);
  });

  test("classifyFallbackInboxMessages separates work, informational, inflight, and self-replies", () => {
    const inflight = new Set(["m-inflight"]);
    const messages: FallbackInboxMessage[] = [
      { id: "m-inflight", type: "task", from_session: "admin" },
      { id: "m-self-reply", type: "reply", from_session: "pigeon-2" },
      { id: "m-peer-reply", type: "reply", from_session: "other-node" },
      { id: "m-task", type: "task", from_session: "admin" },
      { id: "m-info", type: "message", from_session: "admin" },
      { id: "m-steer", type: "message", from_session: "admin", meta: { delivery: "steer" } },
    ];

    const summary = classifyFallbackInboxMessages(messages, {
      isInflight: (id) => inflight.has(id),
      selfAlias: "pigeon-2",
      splitOpencodeInformational: true,
      isSteer: (msg) => (msg.meta as { delivery?: string } | null)?.delivery === "steer",
    });

    expect(summary).toEqual({
      work: 3, // m-peer-reply, m-task, m-steer
      informational: 1, // m-info
      skippedInflight: 1, // m-inflight
      skippedSelfReply: 1, // m-self-reply
    });
  });

  test("busy turn followed by dropped SSE: post-turn drain consumes second task immediately without duplicate execution", async () => {
    // Fake Hub inbox store
    const hubInbox: Array<{ id: string; task_id: string; type: string; content: string }> = [
      { id: "msg-1", task_id: "task-1", type: "task", content: "long task" },
    ];
    const inflight = new Set<string>();
    const processed: string[] = [];
    const activeAtStart: number[] = [];
    let currentRunning = 0;
    let getInboxCalls = 0;

    const firstTurnStarted = deferred();
    const releaseFirstTurn = deferred();

    const getInbox = async () => {
      getInboxCalls++;
      return hubInbox.map((m) => ({ ...m }));
    };
    const ackMessage = async (id: string) => {
      const idx = hubInbox.findIndex((m) => m.id === id);
      if (idx >= 0) hubInbox.splice(idx, 1);
    };

    const workLane = createInboxDrainLane((err) => {
      throw err;
    });
    const scheduleWorkDrain = () => workLane.schedule(processInbox);

    async function processInbox() {
      const messages = await getInbox();
      if (!messages.length) return;
      await dispatchInboxBatch(messages, async (msg) => {
        if (inflight.has(msg.id)) return;
        inflight.add(msg.id);
        let turnSettledAndAcked = false;
        try {
          currentRunning++;
          activeAtStart.push(currentRunning);
          processed.push(msg.id);
          if (msg.id === "msg-1") {
            firstTurnStarted.resolve();
            await releaseFirstTurn.promise;
          }
          await ackMessage(msg.id);
          turnSettledAndAcked = true;
        } finally {
          currentRunning--;
          inflight.delete(msg.id);
          if (turnSettledAndAcked) {
            scheduleWorkDrain();
          }
        }
      });
    }

    const h = createHarness({
      getInbox,
      scheduleWorkDrain,
      isInflight: (id) => inflight.has(id),
    });
    const poller = createInboxFallbackPoller({ intervalMs: 45_000, jitterMs: 0, adapters: h.adapters });
    cleanups.push(() => poller.stop());
    poller.start();

    // Task 1 arrives via normal wake and enters working state
    scheduleWorkDrain();
    await firstTurnStarted.promise;

    // While working on Task 1, Task 2 lands in Hub inbox with NO SSE new_task push.
    hubInbox.push({ id: "msg-2", task_id: "task-2", type: "task", content: "queued while busy" });

    // Finish Task 1 — without firing the fallback timer, post-turn drain must
    // immediately pick up Task 2 and then stop cleanly once inbox is empty.
    releaseFirstTurn.resolve();
    await workLane.idle();

    expect(processed).toEqual(["msg-1", "msg-2"]);
    expect(activeAtStart).toEqual([1, 1]); // strictly serialized, no concurrent re-entry
    expect(hubInbox).toEqual([]);
    // Pass 1: [msg-1] -> Pass 2 (post-turn): [msg-2] -> Pass 3 (post-turn): [] -> idle
    expect(getInboxCalls).toBe(3);
  });

  test("dropped SSE while idle is rescued by periodic fallback timer against a real fake HTTP Hub", async () => {
    const hubInbox: Array<{ id: string; task_id: string; type: string; from_session: string; content: string }> = [];
    const acked: string[] = [];
    const executed: string[] = [];
    const secondConsumed = deferred();

    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.json() as { tool: string; args?: Record<string, unknown> };
        if (body.tool === "get_inbox") {
          return Response.json({ ok: true, messages: hubInbox });
        }
        if (body.tool === "ack_inbox") {
          const id = String(body.args?.message_id ?? "");
          acked.push(id);
          const idx = hubInbox.findIndex((m) => m.id === id);
          if (idx >= 0) hubInbox.splice(idx, 1);
          return Response.json({ ok: true });
        }
        return Response.json({ ok: false, error: "unknown_tool" }, { status: 400 });
      },
    });
    cleanups.push(() => server.stop(true));

    const callFakeHub = async (tool: string, args: Record<string, unknown>) => {
      const res = await fetch(server.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool, args }),
      });
      return res.json() as Promise<any>;
    };

    const inflight = new Set<string>();
    const workLane = createInboxDrainLane((err) => {
      throw err;
    });
    const getInbox = async () => {
      const res = await callFakeHub("get_inbox", { alias: "pigeon-2" });
      return res.messages as FallbackInboxMessage[];
    };
    const scheduleWorkDrain = () => workLane.schedule(async () => {
      const messages = await getInbox();
      if (!messages.length) return;
      await dispatchInboxBatch(messages, async (msg) => {
        if (inflight.has(msg.id)) return;
        inflight.add(msg.id);
        try {
          executed.push(msg.id);
          await callFakeHub("ack_inbox", { message_id: msg.id });
          if (msg.id === "missed-sse-task") secondConsumed.resolve();
        } finally {
          inflight.delete(msg.id);
        }
      });
    });

    const logs: string[] = [];
    const poller = createInboxFallbackPoller({
      intervalMs: 30,
      jitterMs: 0,
      adapters: {
        getInbox,
        scheduleWorkDrain,
        isInflight: (id) => inflight.has(id),
        selfAlias: () => "pigeon-2",
        log: (m) => logs.push(m),
        debug: () => {},
        warn: () => {},
      },
    });
    cleanups.push(() => poller.stop());
    poller.start();

    // Deliver task into fake Hub inbox while node is idle, with NO SSE push.
    hubInbox.push({
      id: "missed-sse-task",
      task_id: "task-missed",
      type: "task",
      from_session: "admin",
      content: "hello without SSE",
    });

    await Promise.race([
      secondConsumed.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for fallback poll")), 2_000)),
    ]);
    await workLane.idle();
    poller.stop();

    expect(executed).toEqual(["missed-sse-task"]);
    expect(acked).toEqual(["missed-sse-task"]);
    expect(logs.some((line) => line.includes("found 1 pending task(s)") && line.includes("scheduling work drain"))).toBe(true);
  });

  test("fallback poll skips already-inflight work and coalesces overlapping triggers", async () => {
    const gate = deferred();
    let getInboxCalls = 0;
    const h = createHarness({
      getInbox: async () => {
        getInboxCalls++;
        if (getInboxCalls === 1) await gate.promise;
        return [...h.inbox];
      },
    });
    h.inbox.push({ id: "running-1", type: "task", from_session: "admin" });
    h.inflight.add("running-1");

    const poller = createInboxFallbackPoller({ intervalMs: 45_000, jitterMs: 0, adapters: h.adapters });
    cleanups.push(() => poller.stop());
    poller.start();

    // Overlapping triggers coalesce into a single follow-up pass, never parallel getInbox calls.
    poller.trigger("timer");
    poller.trigger("timer");
    poller.trigger("idle");
    expect(getInboxCalls).toBe(1);

    gate.resolve();
    await poller.idle();
    expect(getInboxCalls).toBe(2);
    // Only the inflight row existed, so no redundant drain was scheduled.
    expect(h.workDrains).toEqual([]);
  });

  test("superseded node skips fallback polling while inboxSuspended (#507) and resumes after recovery", async () => {
    let getInboxCalls = 0;
    const h = createHarness({
      getInbox: async () => {
        getInboxCalls++;
        return [...h.inbox];
      },
    });
    h.inbox.push({ id: "pending-1", type: "task", from_session: "admin" });
    h.setSuspended(true);

    const poller = createInboxFallbackPoller({ intervalMs: 45_000, jitterMs: 0, adapters: h.adapters });
    cleanups.push(() => poller.stop());
    poller.start();

    h.fireActiveTimer();
    await poller.idle();
    expect(getInboxCalls).toBe(0);
    expect(h.workDrains).toEqual([]);

    h.setSuspended(false);
    h.fireActiveTimer();
    await poller.idle();
    expect(getInboxCalls).toBe(1);
    expect(h.workDrains).toEqual(["work"]);
  });

  test("observability stays quiet on empty polls, emits periodic heartbeat, and backs off cleanly on errors", async () => {
    let fail = false;
    const h = createHarness({
      getInbox: async () => {
        if (fail) throw new Error("hub 502");
        return [];
      },
    });
    const poller = createInboxFallbackPoller({
      intervalMs: 30_000,
      jitterMs: 0,
      emptySummaryEvery: 3,
      adapters: h.adapters,
    });
    cleanups.push(() => poller.stop());

    poller.start();
    poller.start(); // idempotent
    expect(h.logs).toEqual(["[inbox-fallback] active (30000ms; SSE remains primary)"]);

    // 3 empty polls -> debug each time, 1 info heartbeat on the 3rd
    for (let i = 0; i < 3; i++) {
      h.fireActiveTimer();
      await poller.idle();
    }
    expect(h.debugs).toHaveLength(3);
    expect(h.logs).toHaveLength(2);
    expect(h.logs[1]).toContain("heartbeat: 3 consecutive empty poll(s)");

    // Transient failures back off exponentially up to MAX_INBOX_FALLBACK_POLL_MS
    fail = true;
    h.fireActiveTimer();
    await poller.idle();
    expect(h.activeTimer()!.delay).toBe(60_000);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain("hub 502");

    h.fireActiveTimer();
    await poller.idle();
    expect(h.activeTimer()!.delay).toBe(120_000);

    // SSE reconnect resets failure backoff to normal interval immediately
    poller.noteConnected();
    expect(h.activeTimer()!.delay).toBe(30_000);

    poller.stop();
    expect(h.activeTimer()).toBeNull();
  });

  test("failed ACK does not trigger a tight post-turn drain loop", async () => {
    const hubInbox = [{ id: "stuck-ack", task_id: "task-stuck", type: "task" }];
    const inflight = new Set<string>();
    let getInboxCalls = 0;
    let runs = 0;

    const workLane = createInboxDrainLane((err) => {
      throw err;
    });
    const scheduleWorkDrain = () => workLane.schedule(processInbox);

    async function processInbox() {
      getInboxCalls++;
      const messages = hubInbox.map((m) => ({ ...m }));
      await dispatchInboxBatch(messages, async (msg) => {
        if (inflight.has(msg.id)) return;
        inflight.add(msg.id);
        let turnSettledAndAcked = false;
        try {
          runs++;
          // Simulate ACK failure: message stays in hubInbox, turnSettledAndAcked remains false.
        } finally {
          inflight.delete(msg.id);
          if (turnSettledAndAcked) scheduleWorkDrain();
        }
      });
    }

    scheduleWorkDrain();
    await workLane.idle();
    expect(getInboxCalls).toBe(1);
    expect(runs).toBe(1);
  });

  test("production cli.ts wires universal post-turn drain and non-codex fallback poller without overlapping codex compensation", () => {
    const cli = readFileSync(new URL("../cli.ts", import.meta.url), "utf8");

    // Non-codex poller is gated by !commhubCompensation so codex-app-server never double-polls
    expect(cli).toContain("const inboxFallbackPoller: InboxFallbackPoller | null = !commhubCompensation");
    expect(cli).toContain("scheduleWorkDrain: scheduleWorkInboxDrain");
    expect(cli).toContain("isSuspended: () => sseSupersede.inboxSuspended");
    expect(cli).toContain("isInflight: (id) => inflightMessageIds.has(id)");

    // Lifecycle hooks
    expect(cli).toContain("inboxFallbackPoller?.start();");
    expect(cli).toContain("inboxFallbackPoller?.noteConnected();");
    expect(cli).toContain("inboxFallbackPoller?.stop();");

    // Post-turn immediate drain after settled & acked turn inside processInboxMessage finally
    const processInbox = cli.slice(
      cli.indexOf("async function processInbox()"),
      cli.indexOf("async function processOpencodeCopresenceMessages()"),
    );
    expect(processInbox).toContain('debug("inbox poll: 0 messages");');
    expect(processInbox).toContain("if (!commhubCompensation && turnSettledAndAcked)");
    expect(processInbox).toContain("scheduleWorkInboxDrain();");
  });
});
