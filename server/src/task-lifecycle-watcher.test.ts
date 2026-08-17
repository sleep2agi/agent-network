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

/**
 * 轮询到 `ready()` 为真,或到期抛错。
 *
 * 定长 sleep 的问题不是「慢」,是**报错报在错的层**:超时之后测试红在
 * 「事件没写」这条断言上,读的人会去查 watcher,而真实原因可能是子进程
 * 还没起来。这里到期时把那句话直接说出来。
 */
async function waitUntil(ready: () => boolean, timeoutMs: number, what: string | null): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (ready()) return;
    if (Date.now() >= deadline) {
      // what === null:到期本身就是期望结果(调用方随后自己断言),不抛。
      if (what === null) return;
      throw new Error(`timed out after ${timeoutMs}ms: ${what}`);
    }
    await Bun.sleep(25);
  }
}

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
    // 这里**不**等「hub 就绪」——因为没有一个只有 hub 起来了才成立的廉价判据:
    // db 文件在上面那步 init 里就已经存在了,拿它当条件的话这个等待恒真,等于没等。
    // 真正需要「hub 起来了」的是下面那条断言,而它已经改成轮询到目标状态,
    // hub 起得慢只是让它多等几轮。
    //
    // 这一步保留的是原来那条断言的原意:**子进程没有立刻崩**。所以只给它一个
    // 短窗口,并且如果它在窗口内退出就立刻停下来报错,不用把 800ms 睡满。
    await waitUntil(() => child.exitCode !== null, 800, null);
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
      // 巡检周期是 COMMHUB_DELIVERED_STALE_PATROL_MS=25ms —— 事件在插入后
      // 几十毫秒内就该出现。原来这里是定长 sleep(3_200),纯粹是余量:
      // 4.0s 的 sleep 装在 bun 默认的 5.0s 单测预算里,只剩 1s 给两次进程启动。
      // 实测在 CI 上被这一条打红过(#798 让这个文件第一次进 CI 才暴露)。
      // 改成「轮询到目标状态,或到期报错」:常态下快 ~60 倍,慢的时候等得起。
      const countStale = () => childDb.query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM task_events WHERE task_id = ?1 AND event_type = 'task.warning.delivered_stale_30s'",
      ).get(taskId)!.count;
      await waitUntil(() => countStale() === 1, 20_000,
        "watcher did not write the delivered_stale_30s event");
      expect(countStale()).toBe(1);
    } finally {
      childDb.close();
      try { child.kill("SIGTERM"); } catch {}
      await child.exited;
    }
    // 🔴 显式超时:这一条要起两个真 bun 进程,bun 默认的 5s 对它不成立。
    // 上面两处已改成轮询,常态用不到这个上限;它只保证「慢」不会被报成「坏」。
  }, 30_000);
});
