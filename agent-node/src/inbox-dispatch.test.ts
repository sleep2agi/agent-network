import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDetachedInboxDispatcher,
  dispatchInboxBatch,
  isInteractiveDashboardTask,
  shouldDrainPendingReplies,
} from "./inbox-dispatch";
import { createInboxDrainLane } from "./runtime/inbox-drain-lane";
import { PendingReplyQueue } from "./reply-reliability";

const requestId = "dreq_0123456789abcdef0123456789abcdef";

describe("isInteractiveDashboardTask", () => {
  test("accepts a Hub-authenticated dashboard chat task", () => {
    expect(isInteractiveDashboardTask({
      type: "task",
      from_session: "vincent",
      meta_json: JSON.stringify({
        source: "dashboard-chat",
        client_request_id: requestId,
        auth_origin: "user",
      }),
    })).toBe(true);
  });

  test("pre-stamp admin rows stay FIFO because aliases are not auth facts", () => {
    const meta_json = JSON.stringify({ source: "dashboard-chat", client_request_id: requestId });
    expect(isInteractiveDashboardTask({ type: "task", from_session: "admin", meta_json })).toBe(false);
    expect(isInteractiveDashboardTask({ type: "task", from_session: "some-node", meta_json })).toBe(false);
  });

  test("rejects node-authenticated spoofing, malformed ids, and plain messages", () => {
    expect(isInteractiveDashboardTask({
      type: "task",
      from_session: "agent",
      meta: { source: "dashboard-chat", client_request_id: requestId, auth_origin: "node" },
    })).toBe(false);
    expect(isInteractiveDashboardTask({
      type: "task",
      from_session: "admin",
      meta: { source: "dashboard-chat", client_request_id: "dreq_bad" },
    })).toBe(false);
    expect(isInteractiveDashboardTask({
      type: "message",
      from_session: "admin",
      meta: { source: "dashboard-chat", client_request_id: requestId, auth_origin: "user" },
    })).toBe(false);
  });
});

describe("dispatchInboxBatch", () => {
  test("awaited batches preserve legacy runtime serialization", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const entered: number[] = [];
    const running = dispatchInboxBatch([1, 2], async (value) => {
      entered.push(value);
      if (value === 1) await firstBlocked;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(entered).toEqual([1]);
    releaseFirst();
    await running;
    expect(entered).toEqual([1, 2]);
  });

  test("a later SSE snapshot enters while the first detached turn is still running", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const entered: number[] = [];
    const errors: unknown[] = [];
    const handler = async (value: number) => {
      entered.push(value);
      if (value === 1) await firstBlocked;
    };
    const dispatcher = createDetachedInboxDispatcher<number>({
      maxConcurrent: 2,
      key: String,
      onError: (error) => errors.push(error),
    });

    dispatcher.submit([1], handler);
    dispatcher.submit([2], handler);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(entered).toEqual([1, 2]);
    expect(errors).toEqual([]);
    releaseFirst();
    await firstBlocked;
  });

  test("the real serialized drain lane can fetch a later SSE snapshot before the active turn ends", async () => {
    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { firstEntered = resolve; });
    const snapshots = [[1], [2]];
    const entered: number[] = [];
    const errors: unknown[] = [];
    const lane = createInboxDrainLane((error) => errors.push(error));
    const dispatcher = createDetachedInboxDispatcher<number>({
      maxConcurrent: 2,
      key: String,
      onError: (error) => errors.push(error),
    });
    const drain = async () => {
      const snapshot = snapshots.shift() || [];
      dispatcher.submit(snapshot, async (value) => {
        entered.push(value);
        if (value === 1) {
          firstEntered();
          await firstBlocked;
        }
      });
    };

    lane.schedule(drain);
    await firstStarted;
    // This models a new_task SSE arriving after get_inbox snapshot #1 has
    // already submitted a long-running model turn.
    lane.schedule(drain);
    await lane.idle();

    expect(entered).toEqual([1, 2]);
    expect(errors).toEqual([]);
    releaseFirst();
    await firstBlocked;
  });

  test("detached completion failures remain observable", async () => {
    const errors: unknown[] = [];
    const dispatcher = createDetachedInboxDispatcher<string>({
      maxConcurrent: 1,
      key: String,
      onError: (error) => errors.push(error),
    });
    dispatcher.submit(["late-row"], async () => {
      throw new Error("detached row failed");
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("detached row failed");
  });

  test("settling detached work emits a wake for the next Hub inbox window", async () => {
    let settled = 0;
    const dispatcher = createDetachedInboxDispatcher<string>({
      maxConcurrent: 1,
      key: String,
      onError: () => {},
      onSettled: () => { settled++; },
    });
    dispatcher.submit(["row"], async () => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(1);
  });

  test("same-tick duplicate kicks claim one row exactly once", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const dispatcher = createDetachedInboxDispatcher<{ id: string }>({
      maxConcurrent: 2,
      key: (message) => message.id,
      onError: () => {},
    });
    const handler = async () => {
      calls++;
      await blocked;
    };

    const first = dispatcher.submit([{ id: "same-row" }], handler);
    const second = dispatcher.submit([{ id: "same-row" }], handler);

    expect(calls).toBe(1);
    expect(first.accepted).toBe(1);
    expect(second.deduplicated).toBe(1);
    release();
    await blocked;
  });

  test("bounded admission waits N+1 and starts it after a slot settles", async () => {
    const releases = new Map<number, () => void>();
    const gates = new Map<number, Promise<void>>();
    for (const value of [1, 2, 3]) {
      gates.set(value, new Promise<void>((resolve) => releases.set(value, resolve)));
    }
    const entered: number[] = [];
    const dispatcher = createDetachedInboxDispatcher<number>({
      maxConcurrent: 2,
      key: String,
      onError: () => {},
    });

    const admission = dispatcher.submit([1, 2, 3], async (value) => {
      entered.push(value);
      await gates.get(value)!;
    });
    expect(admission).toMatchObject({ active: 2, queued: 1, accepted: 3 });
    expect(entered).toEqual([1, 2]);

    releases.get(1)!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(entered).toEqual([1, 2, 3]);
    expect(dispatcher.stats()).toEqual({ active: 2, queued: 0 });

    releases.get(2)!();
    releases.get(3)!();
    await Promise.all([...gates.values()]);
  });

  test("durable reply drain waits until detached Codex rows finish", () => {
    expect(shouldDrainPendingReplies("codex-app-server", 1)).toBe(false);
    expect(shouldDrainPendingReplies("codex-app-server", 0)).toBe(true);
    expect(shouldDrainPendingReplies("opencode", 3)).toBe(true);
  });

  test("active Codex direct delivery and durable drain send one reply, not two", async () => {
    const dir = mkdtempSync(join(tmpdir(), "test584-pending-singleflight-"));
    try {
      const queue = new PendingReplyQueue(join(dir, "pending.json"));
      queue.persist({
        to: "admin",
        text: "one final reply",
        taskId: "dashboard-task",
        failed: false,
        queuedAt: 1,
      });
      let sends = 0;
      if (shouldDrainPendingReplies("codex-app-server", 1)) {
        await queue.drain(async () => { sends++; });
      }

      // The active handler owns direct send/clear while the durable drain is
      // fenced. Its completion wake sees an empty queue.
      sends++;
      queue.clear("admin", "dashboard-task");
      if (shouldDrainPendingReplies("codex-app-server", 0)) {
        await queue.drain(async () => { sends++; });
      }

      expect(sends).toBe(1);
      expect(queue.load()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
