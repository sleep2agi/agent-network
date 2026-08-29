// #1448 — SSE 重连补偿 reconcile 的单测。
//
// 缺陷：pushEvent 无订阅者静默丢门铃 → node_stop_requests/node_start_requests 行
// 永远 pending → 节点卡 stopping/deleting/starting。修复：每次 SSE connected 调
// reconcilePendingLifecycleRequestsOnConnect，拉本 daemon 名下 pending 行、逐条重放
// 门铃 handler。
//
// witnessed-red 判据：一条本应「永远卡 pending」的 stop/start 请求，reconcile 会把
// 它的门铃重放出去（下面断言 handleStop/StartDoorbell 被以该 request_id 调用）。没有
// reconcile（改前）这些 handler 一次都不会被调 → 请求永远 pending。去重与失败重试
// 语义与 create 的 reconcile 一致。

import { describe, expect, test } from "bun:test";
import { reconcilePendingLifecycleRequestsOnConnect } from "./lifecycle-reconcile.js";

function mkDeps(overrides: Partial<Parameters<typeof reconcilePendingLifecycleRequestsOnConnect>[0]> = {}) {
  const stopCalls: string[] = [];
  const startCalls: string[] = [];
  const warns: string[] = [];
  const logs: string[] = [];
  const deps = {
    callCommHub: async () => ({ ok: true, stop_requests: [], start_requests: [] }),
    log: (m: string) => logs.push(m),
    warn: (m: string) => warns.push(m),
    handleStopDoorbell: async (e: { request_id: string }) => { stopCalls.push(e.request_id); },
    handleStartDoorbell: async (e: { request_id: string }) => { startCalls.push(e.request_id); },
    ...overrides,
  };
  return { deps, stopCalls, startCalls, warns, logs };
}

describe("#1448 reconcilePendingLifecycleRequestsOnConnect", () => {
  test("replays every pending stop/delete + start doorbell the hub returns", async () => {
    const { deps, stopCalls, startCalls } = mkDeps({
      callCommHub: async (tool) => {
        expect(tool).toBe("list_my_pending_lifecycle_requests");
        return {
          ok: true,
          stop_requests: [{ request_id: "sr_a", action: "stop" }, { request_id: "sr_b", action: "delete" }],
          start_requests: [{ request_id: "str_c" }],
        };
      },
    });
    await reconcilePendingLifecycleRequestsOnConnect(deps as any);
    expect(stopCalls).toEqual(["sr_a", "sr_b"]);   // stop + delete both replayed via stop doorbell
    expect(startCalls).toEqual(["str_c"]);
  });

  test("empty pending set → no doorbell replays (steady-state no-op)", async () => {
    const { deps, stopCalls, startCalls, logs } = mkDeps();
    await reconcilePendingLifecycleRequestsOnConnect(deps as any);
    expect(stopCalls).toEqual([]);
    expect(startCalls).toEqual([]);
    expect(logs.some((l) => l.includes("reconcile handled"))).toBe(false);
  });

  test("hub ok:false → warns, replays nothing (no crash)", async () => {
    const { deps, stopCalls, warns } = mkDeps({
      callCommHub: async () => ({ ok: false, error: "daemon_token_required" }),
    });
    await reconcilePendingLifecycleRequestsOnConnect(deps as any);
    expect(stopCalls).toEqual([]);
    expect(warns.some((w) => w.includes("daemon_token_required"))).toBe(true);
  });

  test("shared dedup set: a request already in-flight (live doorbell) is NOT re-replayed", async () => {
    const seen = new Set<string>(["sr_live"]);
    const { deps, stopCalls } = mkDeps({
      recentlyHandledStopRequestIds: seen,
      callCommHub: async () => ({ ok: true, stop_requests: [{ request_id: "sr_live" }, { request_id: "sr_new" }], start_requests: [] }),
    });
    await reconcilePendingLifecycleRequestsOnConnect(deps as any);
    expect(stopCalls).toEqual(["sr_new"]);   // sr_live skipped (live handler owns it), sr_new replayed
    expect(seen.has("sr_new")).toBe(true);
  });

  test("handler failure → id removed from dedup set so the NEXT connect can retry", async () => {
    const seen = new Set<string>();
    const { deps, warns } = mkDeps({
      recentlyHandledStopRequestIds: seen,
      callCommHub: async () => ({ ok: true, stop_requests: [{ request_id: "sr_boom" }], start_requests: [] }),
      handleStopDoorbell: async () => { throw new Error("get_stop_request timeout"); },
    });
    await reconcilePendingLifecycleRequestsOnConnect(deps as any);
    expect(seen.has("sr_boom")).toBe(false);   // retryable next reconnect
    expect(warns.some((w) => w.includes("sr_boom"))).toBe(true);
  });
});
