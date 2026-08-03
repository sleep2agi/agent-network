import { describe, expect, test } from "bun:test";
import { dispatchInboxBatch, isInteractiveDashboardTask } from "./inbox-dispatch";

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

  test("accepts only the narrow legacy admin row during rolling upgrade", () => {
    const meta_json = JSON.stringify({ source: "dashboard-chat", client_request_id: requestId });
    expect(isInteractiveDashboardTask({ type: "task", from_session: "admin", meta_json })).toBe(true);
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
  test("concurrent mode submits later dashboard rows before the first turn completes", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const entered: number[] = [];
    const running = dispatchInboxBatch([1, 2, 3], async (value) => {
      entered.push(value);
      if (value === 1) await firstBlocked;
    }, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(entered).toEqual([1, 2, 3]);
    releaseFirst();
    await running;
  });

  test("sequential mode preserves legacy runtime serialization", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const entered: number[] = [];
    const running = dispatchInboxBatch([1, 2], async (value) => {
      entered.push(value);
      if (value === 1) await firstBlocked;
    }, false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(entered).toEqual([1]);
    releaseFirst();
    await running;
    expect(entered).toEqual([1, 2]);
  });
});
