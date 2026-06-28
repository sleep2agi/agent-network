// Round-2/4 review ② — retention sweep + index split tests.
//
// Drives the real sweepRetention against an isolated in-process
// SQLite (COMMHUB_DB=/tmp/...). We're not mocking — every assertion
// is against persisted rows so the DELETE predicate, the env-var
// opt-out, and the VACUUM hook all get genuinely exercised.
//
// Run with:
//   COMMHUB_DB=/tmp/retention-test.db bun test src/retention.test.ts

import { describe, expect, test, beforeEach } from "bun:test";
import { db, uuidv4 } from "./db.js";
import { sweepRetention, readRetentionConfig, type RetentionConfig } from "./retention.js";

function insertTelemetry(opts: {
  network_id?: string;
  hostname?: string;
  ip?: string;
  alias?: string;
  daysAgo: number;
}): string {
  const id = uuidv4();
  db.run(
    `INSERT INTO agent_telemetry (id, network_id, hostname, ip, alias, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, datetime('now', ?6))`,
    [id, opts.network_id ?? "default", opts.hostname ?? "host-a", opts.ip ?? "1.2.3.4", opts.alias ?? "agent-a", `-${opts.daysAgo} days`]
  );
  return id;
}

function insertTaskEvent(daysAgo: number): number {
  const res = db.run(
    `INSERT INTO task_events (task_id, to_status, actor, created_at)
     VALUES (?1, 'done', 'test', datetime('now', ?2))`,
    [uuidv4(), `-${daysAgo} days`]
  );
  return Number(res.lastInsertRowid ?? 0);
}

function insertInbox(opts: { acked: 0 | 1; daysAgo: number }): string {
  const id = uuidv4();
  db.run(
    `INSERT INTO inbox (id, session_name, content, acked, created_at)
     VALUES (?1, 'sess', 'x', ?2, datetime('now', ?3))`,
    [id, opts.acked, `-${opts.daysAgo} days`]
  );
  return id;
}

function insertTask(opts: {
  status: string;
  daysAgo: number;
  completedDaysAgo?: number | null; // null = explicit NULL (legacy row)
}): string {
  const id = uuidv4();
  if (opts.completedDaysAgo === undefined) {
    // Default: created N days ago, no completed_at set (the historical
    // shape pre-completed_at column).
    db.run(
      `INSERT INTO tasks (task_id, from_name, to_name, priority, status, content, requires_response, created_at)
       VALUES (?1, 'a', 'b', 'normal', ?2, 'x', 'reply', datetime('now', ?3))`,
      [id, opts.status, `-${opts.daysAgo} days`]
    );
  } else {
    const completedClause = opts.completedDaysAgo === null
      ? null
      : `datetime('now', '-${opts.completedDaysAgo} days')`;
    db.run(
      `INSERT INTO tasks
         (task_id, from_name, to_name, priority, status, content, requires_response, created_at, completed_at)
       VALUES (?1, 'a', 'b', 'normal', ?2, 'x', 'reply', datetime('now', ?3), ${completedClause === null ? "NULL" : completedClause})`,
      [id, opts.status, `-${opts.daysAgo} days`]
    );
  }
  return id;
}

function insertAudit(daysAgo: number): number {
  const res = db.run(
    `INSERT INTO audit_log (action, created_at) VALUES ('login', datetime('now', ?1))`,
    [`-${daysAgo} days`]
  );
  return Number(res.lastInsertRowid ?? 0);
}

function count(table: string): number {
  const row = db.get<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM ${table}`);
  return row?.cnt ?? 0;
}

beforeEach(() => {
  db.run("DELETE FROM agent_telemetry");
  db.run("DELETE FROM task_events");
  db.run("DELETE FROM inbox");
  db.run("DELETE FROM tasks");
  db.run("DELETE FROM audit_log");
});

const STRICT_CFG: RetentionConfig = {
  telemetryDays: 7,
  taskEventsDays: 30,
  ackedInboxDays: 7,
  terminalTasksDays: 30,
  auditLogDays: 90,
};

describe("sweepRetention — high-frequency telemetry", () => {
  test("deletes agent_telemetry older than telemetryDays, keeps fresh", () => {
    insertTelemetry({ daysAgo: 0 });   // fresh
    insertTelemetry({ daysAgo: 1 });   // fresh
    insertTelemetry({ daysAgo: 6 });   // just within 7d
    insertTelemetry({ daysAgo: 8 });   // past 7d
    insertTelemetry({ daysAgo: 30 });  // way past

    const r = sweepRetention(STRICT_CFG);

    expect(r.deletes.agent_telemetry).toBe(2);
    expect(count("agent_telemetry")).toBe(3);
  });

  test("is idempotent: second sweep is a no-op on the same horizon", () => {
    insertTelemetry({ daysAgo: 0 });
    insertTelemetry({ daysAgo: 10 });

    const first = sweepRetention(STRICT_CFG);
    const second = sweepRetention(STRICT_CFG);

    expect(first.deletes.agent_telemetry).toBe(1);
    expect(second.deletes.agent_telemetry).toBe(0);
    expect(count("agent_telemetry")).toBe(1);
  });

  test("negative telemetryDays opts out of telemetry sweep", () => {
    insertTelemetry({ daysAgo: 100 });
    insertTelemetry({ daysAgo: 200 });

    const r = sweepRetention({ ...STRICT_CFG, telemetryDays: -1 });

    expect(r.deletes.agent_telemetry).toBe(0);
    expect(count("agent_telemetry")).toBe(2);
  });
});

describe("sweepRetention — task_events / audit_log", () => {
  test("deletes task_events older than taskEventsDays", () => {
    insertTaskEvent(0);
    insertTaskEvent(15);
    insertTaskEvent(31);
    insertTaskEvent(45);

    const r = sweepRetention(STRICT_CFG);

    expect(r.deletes.task_events).toBe(2);
    expect(count("task_events")).toBe(2);
  });

  test("deletes audit_log older than auditLogDays (longer horizon)", () => {
    insertAudit(0);
    insertAudit(30);   // young
    insertAudit(89);   // just within 90d
    insertAudit(91);   // past
    insertAudit(365);  // way past

    const r = sweepRetention(STRICT_CFG);

    expect(r.deletes.audit_log).toBe(2);
    expect(count("audit_log")).toBe(3);
  });
});

describe("sweepRetention — inbox (acked only)", () => {
  test("deletes acked inbox older than ackedInboxDays, never unacked", () => {
    insertInbox({ acked: 1, daysAgo: 0 });  // acked fresh — keep
    insertInbox({ acked: 1, daysAgo: 30 }); // acked old — delete
    insertInbox({ acked: 0, daysAgo: 30 }); // unacked old — KEEP (could still be in-flight)
    insertInbox({ acked: 0, daysAgo: 365 });// unacked ancient — KEEP

    const r = sweepRetention(STRICT_CFG);

    expect(r.deletes.inbox).toBe(1);
    expect(count("inbox")).toBe(3);
  });

  test("does not touch unacked rows even at extreme ages (operator concern)", () => {
    // Why this test exists: a misread DELETE that forgot the
    // `acked = 1` predicate would silently drop in-flight deliveries
    // for agents temporarily offline. That's a correctness bug, not a
    // retention bug — pin it.
    for (let i = 0; i < 10; i++) insertInbox({ acked: 0, daysAgo: 365 });

    sweepRetention(STRICT_CFG);

    expect(count("inbox")).toBe(10);
  });
});

describe("sweepRetention — tasks (terminal status only)", () => {
  test("deletes only terminal-status tasks older than horizon", () => {
    insertTask({ status: "completed", daysAgo: 35 });  // delete
    insertTask({ status: "cancelled", daysAgo: 35 });  // delete
    insertTask({ status: "failed",    daysAgo: 35 });  // delete
    insertTask({ status: "expired",   daysAgo: 35 });  // delete
    insertTask({ status: "completed", daysAgo: 10 });  // young — keep
    insertTask({ status: "running",   daysAgo: 365 }); // active — KEEP
    insertTask({ status: "delivered", daysAgo: 365 }); // active — KEEP
    insertTask({ status: "replied",   daysAgo: 365 }); // could be chain ancestor — KEEP

    const r = sweepRetention(STRICT_CFG);

    expect(r.deletes.tasks).toBe(4);
    expect(count("tasks")).toBe(4);
  });

  // 通信牛 #282 CHANGE_REQ regression — terminal-task sweep MUST use
  // COALESCE(completed_at, created_at), not created_at alone. A task
  // that was created long ago but completed today should survive the
  // full retention window after completion. Sweeping by created_at
  // alone reaps it the instant it enters terminal state → operators
  // get zero post-terminal retention.
  test("60d-old created task completed today is KEPT (uses completed_at, not created_at)", () => {
    insertTask({
      status: "completed",
      daysAgo: 60,           // created 60 days ago (way past horizon)
      completedDaysAgo: 0,   // completed today (within horizon)
    });

    const r = sweepRetention(STRICT_CFG);

    expect(r.deletes.tasks).toBe(0);
    expect(count("tasks")).toBe(1);
  });

  test("legacy row with NULL completed_at falls back to created_at (back-compat)", () => {
    // Old DB rows that pre-date the completed_at column. The COALESCE
    // gracefully falls back so we don't permanently leak legacy data.
    insertTask({
      status: "completed",
      daysAgo: 60,             // way past 30d horizon
      completedDaysAgo: null,  // explicit NULL (legacy)
    });

    const r = sweepRetention(STRICT_CFG);

    expect(r.deletes.tasks).toBe(1);
    expect(count("tasks")).toBe(0);
  });

  test("recently-completed but past-horizon-completion gets reaped", () => {
    insertTask({
      status: "completed",
      daysAgo: 60,
      completedDaysAgo: 35, // completed 35d ago — past 30d horizon
    });

    const r = sweepRetention(STRICT_CFG);

    expect(r.deletes.tasks).toBe(1);
    expect(count("tasks")).toBe(0);
  });

  // `replied` is deliberately out-of-scope for this round per 通信牛
  // discussion — chain-ancestor safety requires child-ref-aware
  // delete. Pin the intentional behaviour so a well-meaning future
  // edit doesn't silently start reaping replied rows.
  test("replied tasks are NEVER swept regardless of age (chain-ancestor safety)", () => {
    insertTask({ status: "replied", daysAgo: 365, completedDaysAgo: 365 });
    insertTask({ status: "replied", daysAgo: 100, completedDaysAgo: 100 });

    const r = sweepRetention(STRICT_CFG);

    expect(r.deletes.tasks).toBe(0);
    expect(count("tasks")).toBe(2);
  });
});

describe("sweepRetention — VACUUM hook", () => {
  test("returns wal_checkpoint pages-moved and incremental freed-pages", () => {
    // Just exercise the codepath — Bun's sqlite layer may or may not
    // return values the operator cares about depending on PRAGMA
    // settings. The point is that the call doesn't error and the
    // shape is what the operator log expects.
    insertTelemetry({ daysAgo: 100 });
    insertTelemetry({ daysAgo: 100 });

    const r = sweepRetention(STRICT_CFG);

    expect(r.vacuum.errored).toBe(false);
    // walCheckpointPagesMoved may be 0 if there's nothing in the WAL.
    expect(r.vacuum.walCheckpointPagesMoved).not.toBeUndefined();
    // incrementalFreedPages may be 0 if auto_vacuum wasn't INCREMENTAL
    // — that's the no-op path documented in retention.ts.
    expect(r.vacuum.incrementalFreedPages).not.toBeUndefined();
  });
});

describe("readRetentionConfig — env-var overrides", () => {
  test("falls back to defaults when env vars unset", () => {
    delete process.env.COMMHUB_RETENTION_TELEMETRY_DAYS;
    delete process.env.COMMHUB_RETENTION_TASK_EVENTS_DAYS;

    const cfg = readRetentionConfig();

    expect(cfg.telemetryDays).toBe(7);
    expect(cfg.taskEventsDays).toBe(30);
    expect(cfg.auditLogDays).toBe(90);
  });

  test("env override wins", () => {
    process.env.COMMHUB_RETENTION_TELEMETRY_DAYS = "3";
    process.env.COMMHUB_RETENTION_AUDIT_DAYS = "180";

    const cfg = readRetentionConfig();

    expect(cfg.telemetryDays).toBe(3);
    expect(cfg.auditLogDays).toBe(180);

    delete process.env.COMMHUB_RETENTION_TELEMETRY_DAYS;
    delete process.env.COMMHUB_RETENTION_AUDIT_DAYS;
  });

  test("non-finite env falls back silently (no operator footgun)", () => {
    process.env.COMMHUB_RETENTION_TELEMETRY_DAYS = "not-a-number";
    const cfg = readRetentionConfig();
    expect(cfg.telemetryDays).toBe(7);
    delete process.env.COMMHUB_RETENTION_TELEMETRY_DAYS;
  });

  test("negative env value passes through (operator opt-out)", () => {
    process.env.COMMHUB_RETENTION_INBOX_ACKED_DAYS = "-1";
    const cfg = readRetentionConfig();
    expect(cfg.ackedInboxDays).toBe(-1);
    delete process.env.COMMHUB_RETENTION_INBOX_ACKED_DAYS;
  });
});

describe("agent_telemetry index split (round 2/4 review ② — query plan)", () => {
  // The combined idx_agent_telemetry_host_time(network_id, hostname,
  // ip, created_at) was dropped in favour of:
  //   - idx_agent_telemetry_hostname_time(network_id, hostname, created_at)
  //   - idx_agent_telemetry_ip_time(network_id, ip, created_at)
  // (idx_agent_telemetry_alias_time is unchanged.)
  //
  // These tests assert the indexes the server-health endpoint relies
  // on actually exist after schema migration. Query-plan inspection
  // (EXPLAIN QUERY PLAN) lives below to prove the OR-disjunction can
  // now use an index UNION instead of full scan.

  test("split indexes exist; old combined is gone", () => {
    const idx = db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'agent_telemetry' ORDER BY name"
    );
    const names = idx.map((r) => r.name);
    expect(names).toContain("idx_agent_telemetry_alias_time");
    expect(names).toContain("idx_agent_telemetry_hostname_time");
    expect(names).toContain("idx_agent_telemetry_ip_time");
    expect(names).not.toContain("idx_agent_telemetry_host_time");
  });

  test("EXPLAIN QUERY PLAN for server-health (hostname OR ip) uses split indexes via index UNION", () => {
    // Mirror the actual query from index.ts /api/server-health/:host
    // (post-addNetworkScope, network_id pinned via direct equality —
    // NOT COALESCE; addNetworkScope appends `AND network_id = ?` and
    // that's what gets indexed).
    insertTelemetry({ hostname: "h1", ip: "10.0.0.1", daysAgo: 0 });
    const plan = db.all<{ detail: string }>(
      `EXPLAIN QUERY PLAN
       SELECT created_at FROM agent_telemetry
       WHERE (hostname = ?1 OR ip = ?2)
         AND created_at >= ?3
         AND network_id = ?4`,
      "h1",
      "10.0.0.1",
      "2026-01-01",
      "default"
    );
    const planText = plan.map((p) => p.detail).join("\n");
    // The split + the OR optimizer should produce a UNION-style plan
    // that uses BOTH new indexes, not a full SCAN.
    expect(planText).toContain("idx_agent_telemetry_hostname_time");
    expect(planText).toContain("idx_agent_telemetry_ip_time");
    expect(planText).not.toMatch(/^SCAN agent_telemetry$/m);
  });
});
