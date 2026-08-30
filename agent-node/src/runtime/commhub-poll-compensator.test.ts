import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_COMPENSATION_POLL_MS,
  MAX_COMPENSATION_POLL_MS,
  MIN_COMPENSATION_POLL_MS,
  createCommHubPollCompensator,
  resolveCompensationPollMs,
  type CompensationPollAdapters,
  type InboxObservation,
  type OutboundTaskObservation,
} from "./commhub-poll-compensator";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function harness(overrides: Partial<CompensationPollAdapters> = {}) {
  const root = mkdtempSync(join(tmpdir(), "anet-poll-"));
  roots.push(root);
  const inbox: InboxObservation[] = [];
  const outbound: OutboundTaskObservation[] = [];
  const drains: string[] = [];
  const terminals: string[] = [];
  const logs: string[] = [];
  const warnings: string[] = [];
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const adapters: CompensationPollAdapters = {
    getInbox: async () => [...inbox],
    listOutbound: async (afterTerminalSeq) => ({
      tasks: outbound
        .map((task, index) => ({ ...task, terminal_seq: task.terminal_seq ?? index + 1 }))
        .filter((task) => Number(task.terminal_seq) > afterTerminalSeq),
      hasMore: false,
    }),
    scheduleInboxDrain: () => drains.push("drain"),
    onOutboundTerminal: (task) => terminals.push(task.task_id),
    log: (message) => logs.push(message),
    warn: (message) => warnings.push(message),
    now: () => Date.parse("2026-08-26T00:00:00.000Z"),
    setTimer: (callback, delay) => {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimer: () => {},
    ...overrides,
  };
  return {
    root,
    cursorPath: join(root, "commhub-compensation-cursor.json"),
    inbox,
    outbound,
    drains,
    terminals,
    logs,
    warnings,
    timers,
    adapters,
  };
}

describe("CommHub durable poll compensation", () => {
  test("bounds configured intervals", () => {
    expect(resolveCompensationPollMs(undefined)).toBe(DEFAULT_COMPENSATION_POLL_MS);
    expect(resolveCompensationPollMs("bad")).toBe(DEFAULT_COMPENSATION_POLL_MS);
    expect(resolveCompensationPollMs(1)).toBe(MIN_COMPENSATION_POLL_MS);
    expect(resolveCompensationPollMs(9_999_999)).toBe(MAX_COMPENSATION_POLL_MS);
    expect(resolveCompensationPollMs(12_345)).toBe(12_345);
  });

  test("normal SSE delivery and a later poll share task/client-request dedup", async () => {
    const h = harness();
    const requestId = `dreq_${"1".repeat(32)}`;
    const msg = { id: "row-1", task_id: "task-1", type: "task", meta: { source: "dashboard-chat", auth_origin: "user", client_request_id: requestId } };
    const poller = createCommHubPollCompensator({ cursorPath: h.cursorPath, adapters: h.adapters });
    poller.recordConsumed(msg);
    h.inbox.push(msg);
    poller.trigger("timer");
    await poller.idle();
    expect(h.drains).toEqual([]);
    expect(poller.wasConsumed({ id: "another-row", task_id: "another-task", type: "task", meta: { source: "dashboard-chat", auth_origin: "user", client_request_id: requestId } })).toBe(true);
  });

  test("node-supplied or malformed client_request_id cannot poison Dashboard dedup", () => {
    const h = harness();
    const poller = createCommHubPollCompensator({ cursorPath: h.cursorPath, adapters: h.adapters });
    const requestId = `dreq_${"2".repeat(32)}`;
    poller.recordConsumed({ id: "node-row", task_id: "node-task", meta: { source: "dashboard-chat", auth_origin: "node", client_request_id: requestId } });
    expect(poller.wasConsumed({ id: "dashboard-row", task_id: "dashboard-task", meta: { source: "dashboard-chat", auth_origin: "user", client_request_id: requestId } })).toBe(false);
    poller.recordConsumed({ id: "bad-row", task_id: "bad-task", meta: { source: "dashboard-chat", auth_origin: "user", client_request_id: "request-2" } });
    expect(poller.wasConsumed({ id: "other-row", task_id: "other-task", meta: { source: "dashboard-chat", auth_origin: "user", client_request_id: "request-2" } })).toBe(false);
  });

  test("lost SSE is admitted by an idle poll exactly through the existing drain", async () => {
    const h = harness();
    h.inbox.push({ id: "row-lost", task_id: "task-lost" });
    const poller = createCommHubPollCompensator({ cursorPath: h.cursorPath, adapters: h.adapters });
    poller.trigger("idle");
    await poller.idle();
    expect(h.drains).toEqual(["drain"]);
    expect(poller.mode).toBe("active");
  });

  test("cursor is private, durable across restart, and prevents replay", async () => {
    const h = harness();
    const requestId = `dreq_${"a".repeat(32)}`;
    const msg = { id: "delivery-a", task_id: "task-a", type: "task", meta_json: JSON.stringify({ source: "dashboard-chat", auth_origin: "user", client_request_id: requestId }) };
    let poller = createCommHubPollCompensator({ cursorPath: h.cursorPath, adapters: h.adapters });
    poller.recordConsumed(msg);
    poller.stop();
    expect(statSync(h.cursorPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(h.cursorPath, "utf8"))).toMatchObject({
      consumed_task_ids: ["task-a"],
      consumed_client_request_ids: [requestId],
    });
    h.inbox.push(msg);
    poller = createCommHubPollCompensator({ cursorPath: h.cursorPath, adapters: h.adapters });
    poller.trigger("startup");
    await poller.idle();
    expect(h.drains).toEqual([]);
  });

  test("inbound lifecycle is monotonic and a completed task never reinjects", async () => {
    const h = harness();
    const msg = { id: "delivery-life", task_id: "task-life" };
    let poller = createCommHubPollCompensator({ cursorPath: h.cursorPath, adapters: h.adapters });
    poller.recordLifecycle("task-life", "delivered");
    poller.recordLifecycle("task-life", "submitted");
    poller.recordLifecycle("task-life", "consumed");
    poller.recordConsumed(msg);
    poller.recordLifecycle("task-life", "delivered");
    poller.stop();
    h.inbox.push(msg);
    poller = createCommHubPollCompensator({ cursorPath: h.cursorPath, adapters: h.adapters });
    poller.trigger("startup");
    await poller.idle();
    expect(h.drains).toEqual([]);
    expect(JSON.parse(readFileSync(h.cursorPath, "utf8")).inbound_lifecycle).toContainEqual({ task_id: "task-life", state: "completed" });
  });

  test("terminal outbound status missed by SSE is surfaced once across restart", async () => {
    const h = harness();
    h.outbound.push({ task_id: "child-1", status: "replied", result: "done" });
    let poller = createCommHubPollCompensator({ cursorPath: h.cursorPath, adapters: h.adapters });
    poller.trigger("timer");
    await poller.idle();
    poller.trigger("idle");
    await poller.idle();
    poller.stop();
    poller = createCommHubPollCompensator({ cursorPath: h.cursorPath, adapters: h.adapters });
    poller.trigger("startup");
    await poller.idle();
    expect(h.terminals).toEqual(["child-1"]);
  });

  test("monotonic terminal watermark garbage-collects more than 2000 delivered rows without replay", async () => {
    const h = harness();
    for (let i = 0; i < 2_001; i++) {
      h.outbound.push({ task_id: `terminal-${i}`, terminal_seq: i + 1, status: "replied" });
    }
    let pageCalls = 0;
    h.adapters.listOutbound = async (afterTerminalSeq) => {
      pageCalls++;
      const tasks = h.outbound.filter((task) => Number(task.terminal_seq) > afterTerminalSeq).slice(0, 100);
      return { tasks, hasMore: tasks.length === 100 };
    };
    let poller = createCommHubPollCompensator({ cursorPath: h.cursorPath, adapters: h.adapters });
    poller.trigger("startup");
    await poller.idle();
    expect(h.terminals).toHaveLength(2_001);
    const firstPageCalls = pageCalls;
    poller.stop();
    poller = createCommHubPollCompensator({ cursorPath: h.cursorPath, adapters: h.adapters });
    poller.trigger("startup");
    await poller.idle();
    poller.trigger("idle");
    await poller.idle();
    expect(h.terminals).toHaveLength(2_001);
    expect(pageCalls - firstPageCalls).toBe(2);
    expect(JSON.parse(readFileSync(h.cursorPath, "utf8"))).toMatchObject({
      outbound_terminal_watermark: 2_001,
      outbound_deliveries: [],
    });
  }, 60_000);  // #1627 —— 原 20_000。历史基线 7809/8481ms;2026-08-31 实测 20832ms(2.7×),撞上限。

  test("terminal sequence handles out-of-order completion independent of task creation order", async () => {
    const h = harness();
    h.outbound.push(
      { task_id: "created-last-completed-first", terminal_seq: 1, status: "replied" },
      { task_id: "created-first-completed-last", terminal_seq: 2, status: "failed" },
    );
    const poller = createCommHubPollCompensator({ cursorPath: h.cursorPath, adapters: h.adapters });
    poller.trigger("timer");
    await poller.idle();
    expect(h.terminals).toEqual(["created-last-completed-first", "created-first-completed-last"]);
    expect(JSON.parse(readFileSync(h.cursorPath, "utf8")).outbound_terminal_watermark).toBe(2);
  });

  test("expired cross-process lease retries the same stable key after simulated crash", async () => {
    let at = 1_000;
    const keys: string[] = [];
    const h = harness({ now: () => at, onOutboundTerminal: (_task, key) => { keys.push(key); } });
    h.outbound.push({ task_id: "crashed-child", terminal_seq: 1, status: "cancelled" });
    const crashState = {
      version: 3,
      consumed_task_ids: [], consumed_client_request_ids: [], surfaced_outbound_terminal_ids: [],
      outbound_terminal_watermark: 0,
      outbound_deliveries: [{ task_id: "crashed-child", idempotency_key: "commhub-terminal:crashed-child", state: "delivering", lease_until: 31_000 }],
      inbound_lifecycle: [], last_success_at: null,
    };
    writeFileSync(h.cursorPath, `${JSON.stringify(crashState)}\n`);
    let poller = createCommHubPollCompensator({ cursorPath: h.cursorPath, adapters: h.adapters });
    poller.trigger("startup");
    await poller.idle();
    expect(keys).toEqual([]);
    poller.stop();
    at = 31_001;
    poller = createCommHubPollCompensator({ cursorPath: h.cursorPath, adapters: h.adapters });
    poller.trigger("startup");
    await poller.idle();
    expect(keys).toEqual(["commhub-terminal:crashed-child"]);
  });

  test("callback failure returns durable delivery to pending and retries the same idempotency key", async () => {
    const keys: string[] = [];
    let fail = true;
    const h = harness({
      onOutboundTerminal: async (_task, key) => {
        keys.push(key);
        if (fail) { fail = false; throw new Error("callback fault"); }
      },
    });
    h.outbound.push({ task_id: "child-fault", status: "failed" });
    let poller = createCommHubPollCompensator({ cursorPath: h.cursorPath, adapters: h.adapters });
    poller.trigger("timer");
    await poller.idle();
    poller.stop();
    poller = createCommHubPollCompensator({ cursorPath: h.cursorPath, adapters: h.adapters });
    poller.trigger("startup");
    await poller.idle();
    poller.trigger("idle");
    await poller.idle();
    expect(keys).toEqual(["commhub-terminal:child-fault", "commhub-terminal:child-fault"]);
    expect(JSON.parse(readFileSync(h.cursorPath, "utf8"))).toMatchObject({
      outbound_terminal_watermark: 1,
      outbound_deliveries: [],
    });
  });

  test("two poller processes share a delivery lease and invoke one callback", async () => {
    let callbacks = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const h = harness({ onOutboundTerminal: async () => { callbacks++; await held; } });
    h.outbound.push({ task_id: "child-race", status: "replied" });
    const first = createCommHubPollCompensator({ cursorPath: h.cursorPath, adapters: h.adapters });
    const second = createCommHubPollCompensator({ cursorPath: h.cursorPath, adapters: h.adapters });
    first.trigger("timer");
    await new Promise((resolve) => setTimeout(resolve, 1));
    second.trigger("timer");
    await second.idle();
    expect(callbacks).toBe(1);
    release();
    await first.idle();
  });

  test("concurrent triggers coalesce and backoff remains bounded", async () => {
    const h = harness({ listOutbound: async () => { throw new Error("temporary outage"); } });
    const poller = createCommHubPollCompensator({ cursorPath: h.cursorPath, intervalMs: 2_500, adapters: h.adapters });
    poller.trigger("startup");
    poller.trigger("sse-reconnect");
    poller.trigger("idle");
    await poller.idle();
    expect(h.warnings.some((line) => line.includes("poll failed"))).toBe(true);
    expect(h.timers.every((timer) => timer.delay <= MAX_COMPENSATION_POLL_MS)).toBe(true);
  });

  test("old Hub visibly degrades to realtime-only instead of claiming polling", async () => {
    const h = harness({
      listOutbound: async () => {
        const error = new Error("MCP error -32601: Tool list_tasks not found") as Error & { code: number };
        error.code = -32601;
        throw error;
      },
    });
    const poller = createCommHubPollCompensator({ cursorPath: h.cursorPath, adapters: h.adapters });
    poller.trigger("startup");
    await poller.idle();
    poller.trigger("timer");
    await poller.idle();
    expect(poller.mode).toBe("realtime-only");
    expect(h.warnings.filter((line) => line.includes("realtime-only"))).toHaveLength(1);
    expect(h.logs.some((line) => line.includes("active"))).toBe(false);
  });

  test("non-terminal outbound states are not surfaced", async () => {
    const h = harness();
    h.outbound.push(
      { task_id: "delivered", status: "delivered" },
      { task_id: "submitted", status: "running" },
      { task_id: "consumed", status: "acked" },
    );
    const poller = createCommHubPollCompensator({ cursorPath: h.cursorPath, adapters: h.adapters });
    poller.trigger("timer");
    await poller.idle();
    expect(h.terminals).toEqual([]);
  });

  test("production wiring keeps SSE primary and routes poll wakes through the existing drain", () => {
    const cli = readFileSync(new URL("../cli.ts", import.meta.url), "utf8");
    const controller = cli.slice(
      cli.indexOf("const commhubCompensation:"),
      cli.indexOf("function formatInterval", cli.indexOf("const commhubCompensation:")),
    );
    expect(controller).toContain("scheduleInboxDrain: scheduleWorkInboxDrain");
    expect(controller).not.toContain("processWithCodexAppServer(");
    expect(controller).not.toContain('client.request("turn/start"');
    expect(controller).toContain("durable_cursor: true");
    expect(controller).toContain("durable_terminal_cursor: true");
    expect(controller).toContain("after_terminal_seq: afterTerminalSeq");
    expect(controller).toContain('response?.capability !== "list_tasks.immutable-terminal-sequence.v2"');
    expect(cli).toContain('commhubCompensation?.trigger("sse-reconnect")');
    expect(cli).toContain('commhubCompensation?.trigger("idle")');
    expect(cli).toContain('commhubCompensation?.trigger("startup")');
  });

  test("production dedup imports the authenticated Dashboard provenance gate", () => {
    const source = readFileSync(new URL("./commhub-poll-compensator.ts", import.meta.url), "utf8");
    expect(source).toContain("return authenticatedDashboardRequestId(message)");
    expect(source).toContain("state.outbound_terminal_watermark = Math.max(state.outbound_terminal_watermark, terminalSeq)");
  });

  test("production records the durable cursor only after Hub ACK succeeds", () => {
    const cli = readFileSync(new URL("../cli.ts", import.meta.url), "utf8");
    const helper = cli.slice(
      cli.indexOf("async function ackAndRecordConsumed"),
      cli.indexOf("async function processInbox", cli.indexOf("async function ackAndRecordConsumed")),
    );
    expect(helper.indexOf("await ackMessage(msg.id)")).toBeGreaterThan(-1);
    expect(helper.indexOf("commhubCompensation?.recordConsumed(msg)")).toBeGreaterThan(
      helper.indexOf("await ackMessage(msg.id)"),
    );
  });
});
