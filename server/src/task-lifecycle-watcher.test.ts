import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { db, logTaskEvent } from "./db.js";
import { TASK_EVENT_REST_COLUMNS } from "./rest-projections.js";
import { recordDeliveredStaleEvents } from "./task-lifecycle-watcher.js";

const NOW = new Date("2026-08-10T00:01:01.000Z");
let server: ReturnType<typeof Bun.serve>;
let base = "";
let token = "";
let networkId = "";

function insertTask(taskId: string, status: string, deliveredAt: string | null, network = networkId) {
  db.run(
    `INSERT INTO tasks
       (task_id, from_name, to_name, status, content, delivered_at, network_id)
     VALUES (?1, 'sender', 'target', ?2, 'watcher fixture', ?3, ?4)`,
    [taskId, status, deliveredAt, network],
  );
}

function sqliteUtcTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

beforeAll(async () => {
  const { register } = await import("./auth.js");
  const auth = register(`watcher_owner_${Date.now()}`, "WatcherOwner-Strong-1!", undefined, "watcher");
  expect(auth.ok).toBe(true);
  token = auth.token!;
  networkId = auth.network_id!;

  insertTask("stale-29", "delivered", "2026-08-10 00:00:32");
  insertTask("stale-30", "delivered", "2026-08-10 00:00:31");
  insertTask("stale-60", "delivered", "2026-08-10 00:00:01");
  insertTask("stale-acked", "acked", "2026-08-10 00:00:00");
  insertTask("stale-no-delivery", "delivered", null);

  const mod = await import("./server.js");
  server = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  try { server?.stop(true); } catch {}
});

describe("#167 Hub delivered-stale lifecycle watcher", () => {
  test("30s/60s thresholds are exact and non-delivered tasks stay silent", () => {
    const first = recordDeliveredStaleEvents(NOW);
    expect(first.inserted).toBe(3);
    expect(first.by_threshold_seconds).toEqual({ 30: 2, 60: 1 });

    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM task_events WHERE task_id = 'stale-29'")!.count).toBe(0);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM task_events WHERE task_id = 'stale-30'")!.count).toBe(1);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM task_events WHERE task_id = 'stale-60'")!.count).toBe(2);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM task_events WHERE task_id = 'stale-acked'")!.count).toBe(0);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM task_events WHERE task_id = 'stale-no-delivery'")!.count).toBe(0);

    const sixty = db.all<any>("SELECT * FROM task_events WHERE task_id = 'stale-60' ORDER BY event_type");
    expect(sixty.map((row) => row.event_type)).toEqual([
      "task.warning.delivered_stale_30s",
      "task.warning.delivered_stale_60s",
    ]);
    expect(sixty.map((row) => row.event_key)).toEqual(sixty.map((row) => row.event_type));
    expect(sixty.every((row) => row.from_status === "delivered" && row.to_status === "delivered")).toBe(true);
    expect(sixty.every((row) => row.actor === "patrol")).toBe(true);
    expect(sixty.every((row) => row.network_id === networkId)).toBe(true);
  });

  test("a second patrol is write-once for each task and threshold", () => {
    const second = recordDeliveredStaleEvents(NOW);
    expect(second.inserted).toBe(0);
    expect(second.by_threshold_seconds).toEqual({ 30: 0, 60: 0 });
    expect(db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM task_events WHERE event_type LIKE 'task.warning.delivered_stale_%'",
    )!.count).toBe(3);
  });

  test("ordinary lifecycle events get standard event names without a dedupe key", () => {
    logTaskEvent("stale-30", null, "delivered", "target");
    logTaskEvent("stale-30", "delivered", "acked", "target");
    logTaskEvent("stale-30", "acked", "running", "target");
    logTaskEvent("stale-30", "running", "replied", "target");
    logTaskEvent("stale-30", "running", "failed", "target");
    logTaskEvent("stale-30", "delivered", "expired", "target");
    const rows = db.all<any>(
      "SELECT event_type, event_key FROM task_events WHERE task_id = 'stale-30' AND actor = 'target' ORDER BY id",
    );
    expect(rows).toEqual([
      { event_type: "task.send.delivered", event_key: null },
      { event_type: "task.ack", event_key: null },
      { event_type: "task.started", event_key: null },
      { event_type: "task.replied", event_key: null },
      { event_type: "task.failed", event_key: null },
      { event_type: "task.expired", event_key: null },
    ]);
  });

  test("REST exposes event_type but keeps the internal idempotency key private", async () => {
    expect(TASK_EVENT_REST_COLUMNS).toContain("event_type");
    expect(TASK_EVENT_REST_COLUMNS).not.toContain("event_key" as any);
    const response = await fetch(
      `${base}/api/task_events?network_id=${encodeURIComponent(networkId)}&task_id=stale-60`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.events).toHaveLength(2);
    expect(body.events.every((event: any) => typeof event.event_type === "string")).toBe(true);
    expect(body.events.every((event: any) => event.event_key === undefined)).toBe(true);
  });

  test("startHub owns a live watcher timer instead of relying on import side effects", async () => {
    const childDbPath = `/tmp/test683-live-${process.pid}-${Date.now()}.db`;
    const init = Bun.spawnSync(["bun", "-e", "await import('./server/src/db.js')"], {
      cwd: process.cwd(),
      env: { ...process.env, COMMHUB_DB: childDbPath },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(init.exitCode).toBe(0);

    const child = Bun.spawn(["bun", "run", "server/src/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        COMMHUB_DB: childDbPath,
        COMMHUB_DELIVERED_STALE_PATROL_MS: "25",
        PORT: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    await Bun.sleep(800);
    expect(child.exitCode).toBeNull();

    const taskId = "stale-live-wiring";
    const childDb = new Database(childDbPath);
    try {
      childDb.run(
        `INSERT INTO tasks
           (task_id, from_name, to_name, status, content, delivered_at, network_id)
         VALUES (?1, 'sender', 'target', 'delivered', 'live watcher fixture', ?2, ?3)`,
        [taskId, sqliteUtcTimestamp(new Date(Date.now() - 28_000)), networkId],
      );
      expect(childDb.query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM task_events WHERE task_id = ?1",
      ).get(taskId)!.count).toBe(0);
      await Bun.sleep(3_200);
      expect(childDb.query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM task_events WHERE task_id = ?1 AND event_type = 'task.warning.delivered_stale_30s'",
      ).get(taskId)!.count).toBe(1);
    } finally {
      childDb.close();
      try { child.kill("SIGTERM"); } catch {}
      await child.exited;
    }
  });
});
