// #507 — agent-node side of the Hub's single-node-subscriber policy (#2299):
// instance id header, superseded-frame parsing, backoff schedule, inbox
// suspension, and the wiring of all of it into connectSSE / processInbox.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildNodeSseHeaders,
  formatSupersededError,
  generateInstanceId,
  INSTANCE_ID_HEADER,
  INSTANCE_ID_RE,
  parseSupersededFrame,
  REPLACED_BY_RECONNECT,
  SUPERSEDE_BACKOFF_BASE_MS,
  SUPERSEDE_BACKOFF_MAX_MS,
  SupersedeBackoff,
  SUPERSEDED_BY_NEW_CONNECTION,
} from "./sse-node-identity";
import { superviseChild } from "./supervise-child";

const superseded = (over: Record<string, unknown> = {}) => parseSupersededFrame({
  type: "node_connection_superseded",
  reason: SUPERSEDED_BY_NEW_CONNECTION,
  instance_match: "different",
  by: { instance_id: "an-other", remote: "203.0.113.7:51000" },
  ...over,
})!;

describe("instance id", () => {
  test("matches the Hub's INSTANCE_ID_RE (else the Hub silently drops it)", () => {
    // Same literal as server/src/server.ts nodeSubscriberInfo — pinned here so a
    // drift on either side is a red test, not a silently-ignored header.
    expect(INSTANCE_ID_RE.source).toBe("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$");
    for (let i = 0; i < 20; i++) expect(INSTANCE_ID_RE.test(generateInstanceId())).toBe(true);
  });

  test("random per call (two processes never share one)", () => {
    expect(generateInstanceId()).not.toBe(generateInstanceId());
  });

  test("refuses to produce an id the Hub would ignore", () => {
    expect(() => generateInstanceId(() => "bad id with spaces")).toThrow();
  });
});

describe("SSE headers", () => {
  test("carry X-Anet-Instance-Id and the bearer token", () => {
    const h = buildNodeSseHeaders("ntok_x", "an-123");
    expect(h[INSTANCE_ID_HEADER]).toBe("an-123");
    expect(INSTANCE_ID_HEADER).toBe("X-Anet-Instance-Id");
    expect(h.Authorization).toBe("Bearer ntok_x");
    expect(h.Accept).toBe("text/event-stream");
    expect(h["Cache-Control"]).toBe("no-cache");
  });

  test("no Authorization header without a token (unchanged no-auth behaviour)", () => {
    const h = buildNodeSseHeaders("", "an-123");
    expect("Authorization" in h).toBe(false);
    expect(h[INSTANCE_ID_HEADER]).toBe("an-123");
  });
});

describe("parseSupersededFrame", () => {
  test("ignores every other event type (older Hubs never send this frame)", () => {
    for (const ev of [null, "x", { type: "connected" }, { type: "new_task" }, { reason: SUPERSEDED_BY_NEW_CONNECTION }]) {
      expect(parseSupersededFrame(ev)).toBeNull();
    }
  });

  test("reads reason / instance_match / by", () => {
    expect(superseded()).toEqual({
      reason: SUPERSEDED_BY_NEW_CONNECTION,
      instanceMatch: "different",
      byInstanceId: "an-other",
      byRemote: "203.0.113.7:51000",
    });
  });

  test("missing reason is treated as superseded (fail toward backing off, not flapping)", () => {
    expect(parseSupersededFrame({ type: "node_connection_superseded" })!.reason).toBe(SUPERSEDED_BY_NEW_CONNECTION);
  });
});

describe("SupersedeBackoff", () => {
  test("replaced_by_reconnect → reconnect as today, no suspension", () => {
    const b = new SupersedeBackoff();
    b.noteConnected(0);
    expect(b.onSuperseded(superseded({ reason: REPLACED_BY_RECONNECT, instance_match: "same" }), 1000)).toEqual({ kind: "reconnect" });
    expect(b.inboxSuspended).toBe(false);
    expect(b.supersededStreak).toBe(0);
  });

  test("superseded_by_new_connection → 30s, 60s, 120s … capped at 10 min", () => {
    const b = new SupersedeBackoff();
    const waits: number[] = [];
    let t = 0;
    for (let i = 0; i < 8; i++) {
      b.noteConnected(t);
      t += 1_000; // flapping: superseded within a second of connecting
      const d = b.onSuperseded(superseded(), t);
      if (d.kind !== "back_off") throw new Error("expected back_off");
      waits.push(d.waitMs);
      t += d.waitMs;
    }
    expect(SUPERSEDE_BACKOFF_BASE_MS).toBe(30_000);
    expect(SUPERSEDE_BACKOFF_MAX_MS).toBe(600_000);
    expect(waits).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000, 600_000]);
    // Never the old ~1s reconnect.
    for (const w of waits) expect(w).toBeGreaterThanOrEqual(30_000);
  });

  test("unknown instance match (other copy is an older agent-node) still backs off", () => {
    const b = new SupersedeBackoff();
    const d = b.onSuperseded(superseded({ instance_match: "unknown", by: { instance_id: null, remote: null } }), 0);
    expect(d.kind).toBe("back_off");
  });

  test("a connection that held ≥10 min resets the streak", () => {
    const b = new SupersedeBackoff();
    b.noteConnected(0);
    b.onSuperseded(superseded(), 1_000);
    b.noteConnected(31_000);
    expect((b.onSuperseded(superseded(), 32_000) as any).waitMs).toBe(60_000);
    b.noteConnected(100_000);
    const d = b.onSuperseded(superseded(), 100_000 + 10 * 60_000);
    expect(d).toEqual({ kind: "back_off", waitMs: 30_000, streak: 1 });
  });

  test("inbox is suspended from supersede until our next connected", () => {
    const b = new SupersedeBackoff();
    expect(b.inboxSuspended).toBe(false);
    b.noteConnected(0);
    b.onSuperseded(superseded(), 10);
    expect(b.inboxSuspended).toBe(true);
    b.noteConnected(30_010);
    expect(b.inboxSuspended).toBe(false);
  });
});

describe("error line", () => {
  test("names alias, the other copy's origin and the wait — never a token", () => {
    const line = formatSupersededError("demo-node", "an-mine", superseded(), 60_000, 2);
    expect(line).toContain('"demo-node"');
    expect(line).toContain("203.0.113.7:51000");
    expect(line).toContain("an-other");
    expect(line).toContain("an-mine");
    expect(line).toContain("60s");
    expect(line).not.toMatch(/ntok_|utok_|Bearer/);
  });
});

describe("superviseChild deferNextAttempt (the SSE reconnect floor)", () => {
  test("a superseded iteration waits the backoff, not the 1s base", async () => {
    const waits: number[] = [];
    let calls = 0;
    await superviseChild({
      label: "sse",
      shutdownGate: () => calls >= 3,
      random: () => 0.5,
      sleep: async (ms) => { waits.push(ms); },
      runOnce: async (ctrl) => {
        calls++;
        ctrl.markStable(); // "connected" arrived
        if (calls === 1) ctrl.deferNextAttempt(30_000); // then superseded
      },
    });
    // iteration 1 superseded → 30 s; iteration 2 normal → back to ~1 s.
    expect(waits).toEqual([30_000, 1_000]);
  });

  test("the floor never shortens a longer computed backoff", async () => {
    const waits: number[] = [];
    let calls = 0;
    await superviseChild({
      label: "sse",
      baseDelayMs: 5_000,
      shutdownGate: () => calls >= 2,
      random: () => 0.5,
      sleep: async (ms) => { waits.push(ms); },
      runOnce: async (ctrl) => { calls++; ctrl.deferNextAttempt(100); },
    });
    expect(waits).toEqual([5_000]);
  });
});

describe("cli.ts wiring", () => {
  const cli = readFileSync(join(import.meta.dir, "..", "cli.ts"), "utf8");
  const fnBody = (name: string) => {
    const start = cli.indexOf(`async function ${name}(`);
    expect(start).toBeGreaterThan(-1);
    const next = cli.indexOf("\nasync function ", start + 1);
    const nextFn = cli.indexOf("\nfunction ", start + 1);
    const end = Math.min(...[next, nextFn].filter((i) => i > 0));
    return cli.slice(start, end);
  };

  test("connectSSE sends the instance id header", () => {
    const body = fnBody("connectSSE");
    expect(body).toContain("buildNodeSseHeaders(AUTH_TOKEN, INSTANCE_ID)");
    expect(cli).toMatch(/const INSTANCE_ID = generateInstanceId\(\);/);
  });

  test("connectSSE turns a superseded frame into a deferred reconnect", () => {
    const body = fnBody("connectSSE");
    expect(body).toContain("parseSupersededFrame(ev)");
    expect(body).toContain("sseSupersede.onSuperseded(");
    expect(body).toContain("ctrl.deferNextAttempt(decision.waitMs)");
    expect(body).toContain("sseSupersede.noteConnected(");
  });

  test("processInbox does not fetch while another copy holds the stream", () => {
    const body = fnBody("processInbox");
    const gate = body.indexOf("sseSupersede.inboxSuspended");
    const fetch = body.indexOf("await getInbox()");
    expect(gate).toBeGreaterThan(-1);
    expect(fetch).toBeGreaterThan(gate);
  });
});
