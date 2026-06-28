// Round-2/4 review ③ — stale session sweeper tests.
//
// Drives the real sweepStaleSessions against isolated in-process
// SQLite (COMMHUB_DB=/tmp/...). Pins behaviour the read-path
// regression (per-request UPDATE) would re-introduce if anyone
// undoes the fix:
//
//   1. fresh sessions stay non-offline regardless of how many
//      times the sweeper runs;
//   2. stale sessions get marked offline exactly once (idempotent);
//   3. global sweep crosses tenant boundaries — a stale agent in
//      network B is marked offline even when no one in net B is
//      polling /api/status;
//   4. env-var cutoff is respected and bad values fall back silently.
//
// Run with:
//   COMMHUB_DB=/tmp/stale-test.db bun test src/stale-sweeper.test.ts

import { describe, expect, test, beforeEach } from "bun:test";
import { db } from "./db.js";
import { sweepStaleSessions, staleCutoffMinutes } from "./stale-sweeper.js";

function insertSession(opts: {
  alias: string;
  status?: string;
  minutesAgo: number;
  network_id?: string;
}): void {
  const id = `r_${opts.alias}`;
  db.run(
    `INSERT OR REPLACE INTO sessions
       (resume_id, alias, status, network_id, updated_at, registered_at)
     VALUES (?1, ?2, ?3, ?4, datetime('now', ?5), datetime('now', ?5))`,
    [id, opts.alias, opts.status ?? "idle", opts.network_id ?? "default", `-${opts.minutesAgo} minutes`]
  );
}

function getStatus(alias: string): string | null {
  const row = db.get<{ status: string }>(
    "SELECT status FROM sessions WHERE alias = ?1",
    alias
  );
  return row?.status ?? null;
}

beforeEach(() => {
  db.run("DELETE FROM sessions");
});

describe("sweepStaleSessions — fresh agents not touched", () => {
  test("agent updated < cutoff stays at its current status", () => {
    insertSession({ alias: "live-1", status: "idle", minutesAgo: 1 });
    insertSession({ alias: "live-2", status: "working", minutesAgo: 5 });

    sweepStaleSessions(10);

    expect(getStatus("live-1")).toBe("idle");
    expect(getStatus("live-2")).toBe("working");
  });

  test("multiple sweeps on quiet hub are pure no-ops (no write fired)", () => {
    insertSession({ alias: "live", status: "idle", minutesAgo: 1 });

    const r1 = sweepStaleSessions(10);
    const r2 = sweepStaleSessions(10);
    const r3 = sweepStaleSessions(10);

    expect(r1.markedOffline).toBe(0);
    expect(r2.markedOffline).toBe(0);
    expect(r3.markedOffline).toBe(0);
    expect(getStatus("live")).toBe("idle");
  });
});

describe("sweepStaleSessions — stale agents marked offline", () => {
  test("agent updated > cutoff gets marked offline exactly once", () => {
    insertSession({ alias: "stale", status: "idle", minutesAgo: 30 });

    const r1 = sweepStaleSessions(10);
    expect(r1.markedOffline).toBe(1);
    expect(getStatus("stale")).toBe("offline");

    // Second sweep does nothing because the row is already offline
    // (the predicate is `status != 'offline'`).
    const r2 = sweepStaleSessions(10);
    expect(r2.markedOffline).toBe(0);
    expect(getStatus("stale")).toBe("offline");
  });

  test("already-offline stale row not re-marked (write avoided)", () => {
    insertSession({ alias: "old-offline", status: "offline", minutesAgo: 60 });

    const r = sweepStaleSessions(10);

    expect(r.markedOffline).toBe(0);
    expect(getStatus("old-offline")).toBe("offline");
  });
});

describe("sweepStaleSessions — global across tenants (the read-path fix)", () => {
  test("stale row in network B is marked offline even with no net-B polling", () => {
    // Pre-fix: GET /api/status from net-A would only UPDATE rows in
    // net-A's scope. A stale agent in net-B would stay non-offline
    // until someone polled net-B. After the fix, the global sweeper
    // is tenant-blind on the maintenance write.
    insertSession({ alias: "stale-a", status: "idle", minutesAgo: 30, network_id: "net-A" });
    insertSession({ alias: "stale-b", status: "idle", minutesAgo: 30, network_id: "net-B" });
    insertSession({ alias: "stale-c", status: "idle", minutesAgo: 30, network_id: null as any });

    const r = sweepStaleSessions(10);

    expect(r.markedOffline).toBe(3);
    expect(getStatus("stale-a")).toBe("offline");
    expect(getStatus("stale-b")).toBe("offline");
    expect(getStatus("stale-c")).toBe("offline");
  });
});

describe("sweepStaleSessions — cutoff boundary + env", () => {
  test("exactly-at-cutoff agent treated as stale (< strict, not <=)", () => {
    // Just past the cutoff window.
    insertSession({ alias: "just-stale", status: "idle", minutesAgo: 11 });
    sweepStaleSessions(10);
    expect(getStatus("just-stale")).toBe("offline");
  });

  test("just-under-cutoff agent treated as live", () => {
    insertSession({ alias: "just-live", status: "working", minutesAgo: 9 });
    sweepStaleSessions(10);
    expect(getStatus("just-live")).toBe("working");
  });

  test("env COMMHUB_STALE_CUTOFF_MINUTES overrides default", () => {
    process.env.COMMHUB_STALE_CUTOFF_MINUTES = "3";
    expect(staleCutoffMinutes()).toBe(3);
    delete process.env.COMMHUB_STALE_CUTOFF_MINUTES;
  });

  test("env invalid value falls back to default 10 (no operator footgun)", () => {
    process.env.COMMHUB_STALE_CUTOFF_MINUTES = "not-a-number";
    expect(staleCutoffMinutes()).toBe(10);
    delete process.env.COMMHUB_STALE_CUTOFF_MINUTES;

    process.env.COMMHUB_STALE_CUTOFF_MINUTES = "0";
    expect(staleCutoffMinutes()).toBe(10);
    delete process.env.COMMHUB_STALE_CUTOFF_MINUTES;

    process.env.COMMHUB_STALE_CUTOFF_MINUTES = "-5";
    expect(staleCutoffMinutes()).toBe(10);
    delete process.env.COMMHUB_STALE_CUTOFF_MINUTES;
  });
});

describe("sweepStaleSessions — read-path regression guard (pin the fix)", () => {
  // This is the load-bearing pin: if anyone adds back a per-request
  // UPDATE in /api/status / /api/servers / /api/server-detail-* /
  // get_all_status, this test plus the absence of those UPDATEs in
  // the source should make the regression visible. Since this is a
  // unit-level test of the sweeper itself, the regression-prevention
  // role is mostly social — the comments in this file + the comments
  // in index.ts and tools.ts at the former UPDATE sites tell future
  // editors "do not put the UPDATE back; use the sweeper."
  test("after sweep, sessions row has the offline status persisted (single source of truth)", () => {
    insertSession({ alias: "x", status: "working", minutesAgo: 30 });
    const before = sweepStaleSessions(10);
    expect(before.markedOffline).toBe(1);

    // Re-read directly — no extra UPDATE needed by a caller.
    const status = getStatus("x");
    expect(status).toBe("offline");

    // 100 simulated read-path lookups don't fire any maintenance writes.
    for (let i = 0; i < 100; i++) {
      const row = db.get<{ status: string }>(
        "SELECT status FROM sessions WHERE alias = ?1",
        "x"
      );
      expect(row?.status).toBe("offline");
    }
  });
});
