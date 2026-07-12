// RFC-030 Wave 1B L3-R5 — lifecycle: eager boot, reconnect/backoff,
// drainAll-on-loss, no-blind-resend boundary.

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import { SessionReconnectManager, type LifecycleSessionLike } from "./session-reconnect";
import { UpstreamRequestMux } from "./protocol";

function fakeSession(): LifecycleSessionLike & { emitClose: () => void } {
  const em = new EventEmitter();
  return {
    client: { on: (ev, fn) => em.on(ev, fn) },
    threadId: "th1",
    isRunning: true,
    emitClose: () => em.emit("close", { code: 1006, reason: "lost" }),
  };
}

const instantSleep = async () => {};

describe("SessionReconnectManager — eager boot", () => {
  test("start() opens IMMEDIATELY; a gate failure at boot propagates (fail closed, no retry-into-broken-baseline)", async () => {
    let opened = 0;
    const lc = new SessionReconnectManager({
      open: async () => {
        opened++;
        throw new Error("codex baseline mismatch — refusing to boot");
      },
      sleep: instantSleep,
    });
    await expect(lc.start()).rejects.toThrow(/baseline mismatch/);
    expect(opened).toBe(1); // eager: exactly one attempt, no lazy loop
    expect(lc.current()).toBeNull();
  });

  test("successful start adopts the session and reports running", async () => {
    const states: string[] = [];
    const s = fakeSession();
    const lc = new SessionReconnectManager({
      open: async () => s,
      onStateChange: (st) => states.push(st),
      sleep: instantSleep,
    });
    const got = await lc.start();
    expect(got).toBe(s);
    expect(states).toEqual(["starting", "running"]);
  });
});

describe("SessionReconnectManager — reconnect with capped exponential backoff", () => {
  test("session loss → drainAll on the mux, backoff grows to cap, success resets state to running", async () => {
    const mux = new UpstreamRequestMux();
    mux.allocateForProxiedTui("t1");
    mux.allocateForInternalScheduler(null);
    expect(mux.pendingCount()).toBe(2);

    const s1 = fakeSession();
    const s2 = fakeSession();
    let opens = 0;
    const failuresBeforeSuccess = 4;
    const states: string[] = [];
    const disconnects: Array<{ droppedMuxPending: number; attempt: number }> = [];
    const sessions: Array<{ reopenCount: number }> = [];

    const lc = new SessionReconnectManager({
      open: async () => {
        opens++;
        if (opens === 1) return s1;
        if (opens - 1 <= failuresBeforeSuccess) throw new Error(`open fail ${opens - 1}`);
        return s2;
      },
      mux,
      backoff: { initialMs: 100, maxMs: 400, factor: 2 },
      sleep: instantSleep,
      random: () => 1, // deterministic jitter = full delay
      onStateChange: (st) => states.push(st),
      onDisconnect: (i) => disconnects.push(i),
      onSession: (_s, info) => sessions.push(info),
    });

    await lc.start();
    s1.emitClose();
    await new Promise((r) => setTimeout(r, 10)); // let the loop settle

    // drainAll happened exactly once at loss time — nothing outstanding.
    expect(mux.pendingCount()).toBe(0);
    expect(disconnects[0].droppedMuxPending).toBe(2);

    // Backoff sequence: 100, 200, 400 (cap), 400 (cap), then success on 5th.
    expect(lc.delaysUsed).toEqual([100, 200, 400, 400, 400]);
    expect(lc.current()).toBe(s2);
    expect(states).toEqual(["starting", "running", "recovering", "running"]);
    expect(sessions).toEqual([{ reopenCount: 0 }, { reopenCount: 1 }]);
  });

  test("stop() suppresses the reconnect loop entirely", async () => {
    const s1 = fakeSession();
    let opens = 0;
    const lc = new SessionReconnectManager({
      open: async () => {
        opens++;
        return s1;
      },
      sleep: instantSleep,
    });
    await lc.start();
    lc.stop();
    s1.emitClose();
    await new Promise((r) => setTimeout(r, 10));
    expect(opens).toBe(1); // never reopened
    expect(lc.current()).toBe(s1); // stale ref kept; state is disconnected
  });

  test("maxConsecutiveFailures gives up cleanly (disconnected), never resends", async () => {
    const s1 = fakeSession();
    let opens = 0;
    const states: string[] = [];
    const lc = new SessionReconnectManager({
      open: async () => {
        opens++;
        if (opens === 1) return s1;
        throw new Error("still down");
      },
      sleep: instantSleep,
      maxConsecutiveFailures: 3,
      onStateChange: (st) => states.push(st),
    });
    await lc.start();
    s1.emitClose();
    await new Promise((r) => setTimeout(r, 10));
    expect(opens).toBe(1 + 3); // initial + exactly 3 reopen attempts
    expect(states.at(-1)).toBe("disconnected");
    expect(lc.current()).toBeNull();
  });

  test("second close during an active loop does not double-run the loop", async () => {
    const s1 = fakeSession();
    const s2 = fakeSession();
    let opens = 0;
    const lc = new SessionReconnectManager({
      open: async () => {
        opens++;
        return opens === 1 ? s1 : s2;
      },
      sleep: instantSleep,
    });
    await lc.start();
    s1.emitClose();
    s1.emitClose(); // duplicate close event
    await new Promise((r) => setTimeout(r, 10));
    expect(opens).toBe(2); // exactly one reopen
    expect(lc.current()).toBe(s2);
  });
});
