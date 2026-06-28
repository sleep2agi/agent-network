import { afterEach, expect, test, describe } from "bun:test";
import { eventBus } from "./event_bus";
import {
  __resetSSEClientsForTest,
  createSSEStream,
  getSSEStats,
  pushEvent,
  __SSE_INTERNALS_FOR_TEST,
} from "./push";

afterEach(() => {
  __resetSSEClientsForTest();
});

test("rename-committed rekeys existing SSE clients from old alias to new alias (case 8)", async () => {
  const res = createSSEStream("old-agent", "net-rekey-8");
  const reader = res.body!.getReader();

  expect(getSSEStats().sessions["net-rekey-8:old-agent"]).toBe(1);
  eventBus.emit("rename-committed", {
    networkId: "net-rekey-8",
    old_alias: "old-agent",
    new_alias: "new-agent",
    node_id: "node-8",
  });

  const stats = getSSEStats().sessions;
  expect(stats["net-rekey-8:old-agent"]).toBeUndefined();
  expect(stats["net-rekey-8:new-agent"]).toBe(1);
  await reader.cancel();
});

test("rename-committed merges old and new SSE client buckets without dropping clients (case 11)", async () => {
  const oldRes = createSSEStream("old-agent", "net-rekey-11");
  const newRes = createSSEStream("new-agent", "net-rekey-11");
  const oldReader = oldRes.body!.getReader();
  const newReader = newRes.body!.getReader();

  expect(getSSEStats().sessions["net-rekey-11:old-agent"]).toBe(1);
  expect(getSSEStats().sessions["net-rekey-11:new-agent"]).toBe(1);
  eventBus.emit("rename-committed", {
    networkId: "net-rekey-11",
    old_alias: "old-agent",
    new_alias: "new-agent",
    node_id: "node-11",
  });

  const stats = getSSEStats().sessions;
  expect(stats["net-rekey-11:old-agent"]).toBeUndefined();
  expect(stats["net-rekey-11:new-agent"]).toBe(2);
  await oldReader.cancel();
  await newReader.cancel();
});

// ─────────────────────────────────────────────────────────────────────
// Round-2/4 fix: SSE backpressure + half-open detection
//
// These tests exercise tryEnqueueBytes / sweepLiveness directly with a
// hand-rolled fake ReadableStreamDefaultController so we can model the
// failure modes that matter — a controller whose `desiredSize` goes
// negative because the consumer stopped reading (half-open TCP), and
// one whose enqueue throws because the runtime already errored it.
// ─────────────────────────────────────────────────────────────────────

const enc = new TextEncoder();

type FakeCtrlOpts = {
  desiredSize?: number | null;
  enqueueThrows?: Error;
  onClose?: () => void;
};

/** Hand-rolled controller stand-in. `desiredSize` is mutable so a test
 *  can flip a "client" from healthy → backpressured by tweaking one
 *  number; `enqueue` records the bytes (for assertion) and optionally
 *  throws. */
function fakeController(opts: FakeCtrlOpts = {}) {
  const enqueued: Uint8Array[] = [];
  let closed = false;
  const hasDesired = "desiredSize" in opts;
  const ctrl = {
    get desiredSize(): number | null {
      // Explicit null must NOT coalesce to the default — the whole point
      // of these tests is to exercise the half-open path where
      // desiredSize comes back null.
      return hasDesired ? (opts.desiredSize as number | null) : 1024;
    },
    enqueue(bytes: Uint8Array) {
      if (opts.enqueueThrows) throw opts.enqueueThrows;
      enqueued.push(bytes);
    },
    close() {
      if (!closed) {
        closed = true;
        opts.onClose?.();
      }
    },
    _enqueued: enqueued,
    _closed: () => closed,
    _setDesired(n: number | null) {
      opts.desiredSize = n;
    },
  };
  return ctrl;
}

function makeClient(ctrl: ReturnType<typeof fakeController>) {
  return {
    controller: ctrl as unknown as ReadableStreamDefaultController,
    encoder: enc,
    stuckSince: null as number | null,
    closed: false,
    key: "test:fake",
  };
}

describe("tryEnqueueBytes — backpressure ceiling", () => {
  test("desiredSize healthy → enqueue OK, no close", () => {
    const ctrl = fakeController({ desiredSize: 500_000 });
    const c = makeClient(ctrl);
    const r = __SSE_INTERNALS_FOR_TEST.tryEnqueueBytes(c, enc.encode("hello"));
    expect(r).toBe("ok");
    expect(c.closed).toBe(false);
    expect(ctrl._enqueued).toHaveLength(1);
  });

  test("desiredSize < -MAX_BACKPRESSURE → close, return dead, no enqueue", () => {
    const ceiling = __SSE_INTERNALS_FOR_TEST.MAX_QUEUE_BACKPRESSURE_BYTES;
    const ctrl = fakeController({ desiredSize: -(ceiling + 1) });
    const c = makeClient(ctrl);
    const r = __SSE_INTERNALS_FOR_TEST.tryEnqueueBytes(c, enc.encode("x"));
    expect(r).toBe("dead");
    expect(c.closed).toBe(true);
    expect(ctrl._closed()).toBe(true);
    expect(ctrl._enqueued).toHaveLength(0);
  });

  test("desiredSize negative but within ceiling → enqueue still OK, stuckSince set", () => {
    const ctrl = fakeController({ desiredSize: -100 });
    const c = makeClient(ctrl);
    expect(c.stuckSince).toBeNull();
    const r = __SSE_INTERNALS_FOR_TEST.tryEnqueueBytes(c, enc.encode("x"));
    expect(r).toBe("ok");
    expect(c.closed).toBe(false);
    expect(c.stuckSince).not.toBeNull();
    expect(ctrl._enqueued).toHaveLength(1);
  });

  test("desiredSize recovers to positive → stuckSince cleared", () => {
    const ctrl = fakeController({ desiredSize: -100 });
    const c = makeClient(ctrl);
    __SSE_INTERNALS_FOR_TEST.tryEnqueueBytes(c, enc.encode("a"));
    expect(c.stuckSince).not.toBeNull();
    ctrl._setDesired(500);
    __SSE_INTERNALS_FOR_TEST.tryEnqueueBytes(c, enc.encode("b"));
    expect(c.stuckSince).toBeNull();
  });

  test("desiredSize null (closed/errored controller) → close, return dead", () => {
    const ctrl = fakeController({ desiredSize: null });
    const c = makeClient(ctrl);
    const r = __SSE_INTERNALS_FOR_TEST.tryEnqueueBytes(c, enc.encode("x"));
    expect(r).toBe("dead");
    expect(c.closed).toBe(true);
  });

  test("enqueue throws → close, return dead", () => {
    const ctrl = fakeController({
      desiredSize: 100,
      enqueueThrows: new Error("controller errored"),
    });
    const c = makeClient(ctrl);
    const r = __SSE_INTERNALS_FOR_TEST.tryEnqueueBytes(c, enc.encode("x"));
    expect(r).toBe("dead");
    expect(c.closed).toBe(true);
  });

  test("already-closed client → return dead immediately, no enqueue/close attempt", () => {
    const ctrl = fakeController({ desiredSize: 100 });
    const c = makeClient(ctrl);
    c.closed = true;
    const r = __SSE_INTERNALS_FOR_TEST.tryEnqueueBytes(c, enc.encode("x"));
    expect(r).toBe("dead");
    expect(ctrl._enqueued).toHaveLength(0);
    expect(ctrl._closed()).toBe(false); // never re-closed
  });
});

describe("tryEnqueueBytes — stuck timeout", () => {
  test("stuck longer than STUCK_CLOSE_MS → close, return dead", () => {
    const ctrl = fakeController({ desiredSize: -500 });
    const c = makeClient(ctrl);
    // Backdate stuckSince so the threshold has elapsed.
    c.stuckSince = Date.now() - (__SSE_INTERNALS_FOR_TEST.STUCK_CLOSE_MS + 1000);
    const r = __SSE_INTERNALS_FOR_TEST.tryEnqueueBytes(c, enc.encode("x"));
    expect(r).toBe("dead");
    expect(c.closed).toBe(true);
  });

  test("stuck but below STUCK_CLOSE_MS → enqueue still OK", () => {
    const ctrl = fakeController({ desiredSize: -500 });
    const c = makeClient(ctrl);
    c.stuckSince = Date.now() - 1000; // far less than 60s default
    const r = __SSE_INTERNALS_FOR_TEST.tryEnqueueBytes(c, enc.encode("x"));
    expect(r).toBe("ok");
    expect(c.closed).toBe(false);
  });
});

describe("sweepLiveness — proactive half-open detection", () => {
  test("sweep closes a client whose desiredSize is null", () => {
    const ctrl = fakeController({ desiredSize: null });
    const c = makeClient(ctrl);
    __SSE_INTERNALS_FOR_TEST.clientsMap.set("test:sweep-null", [c as any]);
    __SSE_INTERNALS_FOR_TEST.sweepLiveness();
    expect(c.closed).toBe(true);
    expect(__SSE_INTERNALS_FOR_TEST.clientsMap.has("test:sweep-null")).toBe(false);
  });

  test("sweep closes a client over the backpressure ceiling without any push", () => {
    const ceiling = __SSE_INTERNALS_FOR_TEST.MAX_QUEUE_BACKPRESSURE_BYTES;
    const ctrl = fakeController({ desiredSize: -(ceiling + 5_000_000) });
    const c = makeClient(ctrl);
    __SSE_INTERNALS_FOR_TEST.clientsMap.set("test:sweep-over", [c as any]);
    __SSE_INTERNALS_FOR_TEST.sweepLiveness();
    expect(c.closed).toBe(true);
    expect(__SSE_INTERNALS_FOR_TEST.clientsMap.has("test:sweep-over")).toBe(false);
  });

  test("sweep closes a client stuck longer than STUCK_CLOSE_MS", () => {
    const ctrl = fakeController({ desiredSize: -500 });
    const c = makeClient(ctrl);
    c.stuckSince = Date.now() - (__SSE_INTERNALS_FOR_TEST.STUCK_CLOSE_MS + 5_000);
    __SSE_INTERNALS_FOR_TEST.clientsMap.set("test:sweep-stuck", [c as any]);
    __SSE_INTERNALS_FOR_TEST.sweepLiveness();
    expect(c.closed).toBe(true);
    expect(__SSE_INTERNALS_FOR_TEST.clientsMap.has("test:sweep-stuck")).toBe(false);
  });

  test("sweep first sees stuck → records stuckSince, does not close yet", () => {
    const ctrl = fakeController({ desiredSize: -500 });
    const c = makeClient(ctrl);
    expect(c.stuckSince).toBeNull();
    __SSE_INTERNALS_FOR_TEST.clientsMap.set("test:sweep-firststuck", [c as any]);
    __SSE_INTERNALS_FOR_TEST.sweepLiveness();
    expect(c.closed).toBe(false);
    expect(c.stuckSince).not.toBeNull();
  });

  test("sweep leaves healthy clients alone", () => {
    const ctrl = fakeController({ desiredSize: 500 });
    const c = makeClient(ctrl);
    __SSE_INTERNALS_FOR_TEST.clientsMap.set("test:sweep-healthy", [c as any]);
    __SSE_INTERNALS_FOR_TEST.sweepLiveness();
    expect(c.closed).toBe(false);
    expect(__SSE_INTERNALS_FOR_TEST.clientsMap.get("test:sweep-healthy")).toHaveLength(1);
  });

  test("sweep prunes only dead entries when multiple clients share a key", () => {
    const dead = fakeController({ desiredSize: null });
    const alive = fakeController({ desiredSize: 500 });
    const cDead = makeClient(dead);
    const cAlive = makeClient(alive);
    __SSE_INTERNALS_FOR_TEST.clientsMap.set("test:sweep-mixed", [cDead, cAlive] as any);
    __SSE_INTERNALS_FOR_TEST.sweepLiveness();
    const remaining = __SSE_INTERNALS_FOR_TEST.clientsMap.get("test:sweep-mixed");
    expect(remaining).toHaveLength(1);
    expect(cDead.closed).toBe(true);
    expect(cAlive.closed).toBe(false);
  });
});

describe("pushEvent integration with backpressure", () => {
  test("push to half-open client → client evicted from map", () => {
    const ctrl = fakeController({ desiredSize: null });
    const c = makeClient(ctrl);
    c.key = "global:half-open";
    __SSE_INTERNALS_FOR_TEST.clientsMap.set("global:half-open", [c as any]);
    pushEvent("half-open", { type: "test", payload: 1 });
    expect(c.closed).toBe(true);
    expect(__SSE_INTERNALS_FOR_TEST.clientsMap.has("global:half-open")).toBe(false);
  });

  test("push to mixed (one alive, one dead) → alive receives, dead pruned", () => {
    const dead = fakeController({ desiredSize: null });
    const alive = fakeController({ desiredSize: 500 });
    const cDead = makeClient(dead);
    cDead.key = "global:mixed";
    const cAlive = makeClient(alive);
    cAlive.key = "global:mixed";
    __SSE_INTERNALS_FOR_TEST.clientsMap.set("global:mixed", [cDead, cAlive] as any);
    pushEvent("mixed", { type: "msg" });
    expect(alive._enqueued).toHaveLength(1);
    expect(__SSE_INTERNALS_FOR_TEST.clientsMap.get("global:mixed")).toHaveLength(1);
  });

  test("push to over-ceiling client → client closed, no enqueue, map evicted", () => {
    const ceiling = __SSE_INTERNALS_FOR_TEST.MAX_QUEUE_BACKPRESSURE_BYTES;
    const ctrl = fakeController({ desiredSize: -(ceiling + 1) });
    const c = makeClient(ctrl);
    c.key = "global:over";
    __SSE_INTERNALS_FOR_TEST.clientsMap.set("global:over", [c as any]);
    pushEvent("over", { type: "msg" });
    expect(ctrl._enqueued).toHaveLength(0);
    expect(c.closed).toBe(true);
    expect(__SSE_INTERNALS_FOR_TEST.clientsMap.has("global:over")).toBe(false);
  });

  test("push to unknown session is a no-op (no throw)", () => {
    expect(() => pushEvent("never-connected", { type: "x" })).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Round-2 review fix: byte-level backpressure on a REAL ReadableStream
//
// The fake-controller tests above can't catch the unit-mismatch bug
// (treating desiredSize as bytes when the runtime treats it as chunk
// count). These tests exercise the actual `createSSEStream` Response
// against a non-reading consumer and verify that bytes — not chunks —
// trip the backpressure cap.
//
// Probe baseline (per 通信牛, also verified locally in this test):
//   - Default ReadableStream (no strategy) → desiredSize is the
//     CHUNK count. 1MB chunk → desiredSize goes 1 → 0; second chunk
//     → -1. Million 1-byte chunks needed to hit our -1MB ceiling.
//   - Byte-counting strategy `{highWaterMark: 0, size: c.byteLength}`
//     → desiredSize is the BYTE count. 1MB chunk → -1_000_000.
// ─────────────────────────────────────────────────────────────────────

describe("real ReadableStream — byte-level backpressure (round-2 fix)", () => {
  test("createSSEStream uses byte-counting strategy: desiredSize tracks bytes not chunks", async () => {
    const res = createSSEStream("byte-strategy-probe", "net-bsp");
    // Don't read from res.body. The stream sits with whatever was
    // enqueued in `start()` (initial 'connected' frame) until we push.
    const key = "net-bsp:byte-strategy-probe";
    const arr = __SSE_INTERNALS_FOR_TEST.clientsMap.get(key);
    expect(arr).toBeDefined();
    expect(arr).toHaveLength(1);
    const ctrl = arr![0].controller;

    // The unit check: enqueue a 1 KB chunk and verify desiredSize
    // drops by ~1024, not by 1. With chunk-count strategy desiredSize
    // would drop by exactly 1; with byte strategy by 1024.
    const before = ctrl.desiredSize!;
    ctrl.enqueue(new Uint8Array(1024));
    const after = ctrl.desiredSize!;
    expect(before - after).toBeGreaterThanOrEqual(1024);

    // Cleanup so the afterEach reset doesn't leak.
    await res.body!.cancel();
  });

  test("non-reading consumer past MAX bytes triggers hard ceiling close", async () => {
    const ceiling = __SSE_INTERNALS_FOR_TEST.MAX_QUEUE_BACKPRESSURE_BYTES;
    const res = createSSEStream("byte-cap-probe", "net-bcp");
    const key = "net-bcp:byte-cap-probe";
    const c = __SSE_INTERNALS_FOR_TEST.clientsMap.get(key)![0];

    // Push events whose total byte size exceeds the hard ceiling.
    // With chunk-count strategy this would NOT close (each event is 1
    // chunk; desiredSize would be at -N for N events, never -1M).
    // With byte strategy this SHOULD close once accumulated bytes
    // exceed ceiling.
    const chunkSize = 100_000; // 100KB per push
    const needed = Math.ceil(ceiling / chunkSize) + 2; // overshoot a bit
    const big = "x".repeat(chunkSize);
    for (let i = 0; i < needed; i++) {
      if (c.closed) break;
      pushEvent("byte-cap-probe", { type: "big", payload: big }, "net-bcp");
    }
    expect(c.closed).toBe(true);
    expect(__SSE_INTERNALS_FOR_TEST.clientsMap.has(key)).toBe(false);

    try { await res.body!.cancel(); } catch { /* already closed */ }
  });

  test("reading consumer drains queue → no spurious close even after many pushes", async () => {
    const res = createSSEStream("drain-probe", "net-drain");
    const reader = res.body!.getReader();
    const key = "net-drain:drain-probe";
    const c = __SSE_INTERNALS_FOR_TEST.clientsMap.get(key)![0];

    // Drain in the background while pushes happen.
    let drained = 0;
    const drainPromise = (async () => {
      while (drained < 50) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) drained += value.byteLength;
      }
    })();

    for (let i = 0; i < 20; i++) {
      pushEvent("drain-probe", { type: "tick", n: i }, "net-drain");
    }
    await drainPromise;
    expect(c.closed).toBe(false);
    expect(__SSE_INTERNALS_FOR_TEST.clientsMap.has(key)).toBe(true);

    await reader.cancel();
  });
});

describe("getSSEStats — closed clients excluded", () => {
  test("manually-closed client is not counted in stats", () => {
    const ctrl = fakeController({ desiredSize: 500 });
    const c = makeClient(ctrl);
    c.key = "global:stats-test";
    c.closed = true;
    __SSE_INTERNALS_FOR_TEST.clientsMap.set("global:stats-test", [c as any]);
    const stats = getSSEStats();
    expect(stats.sessions["global:stats-test"]).toBeUndefined();
    expect(stats.total).toBe(0);
  });

  test("mixed alive + closed clients → only alive count", () => {
    const dead = fakeController({ desiredSize: 500 });
    const alive = fakeController({ desiredSize: 500 });
    const cDead = makeClient(dead);
    cDead.closed = true;
    const cAlive = makeClient(alive);
    __SSE_INTERNALS_FOR_TEST.clientsMap.set("global:stats-mixed", [cDead, cAlive] as any);
    const stats = getSSEStats();
    expect(stats.sessions["global:stats-mixed"]).toBe(1);
    expect(stats.total).toBe(1);
  });
});
