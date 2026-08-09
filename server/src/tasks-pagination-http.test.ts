import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PRIVATE_DB_DIR = mkdtempSync(join(tmpdir(), "anet-task-pagination-"));
process.env.COMMHUB_DB = join(PRIVATE_DB_DIR, "hub.db");

let db: typeof import("./db.js").db;
let register: typeof import("./auth.js").register;
let server: ReturnType<typeof Bun.serve>;
let base = "";
let tokenA = "";
let networkA = "";
let networkB = "";

function seedTask(
  taskId: string,
  networkId: string,
  toName: string,
  createdAt: string,
): void {
  db.run(
    `INSERT INTO tasks
       (task_id, from_name, to_name, priority, status, content, network_id, created_at)
     VALUES (?1, 'sender', ?2, 'normal', 'delivered', ?1, ?3, ?4)`,
    [taskId, toName, networkId, createdAt],
  );
}

beforeAll(async () => {
  ({ db } = await import("./db.js"));
  ({ register } = await import("./auth.js"));
  const b = register(`page_b_${Date.now()}`, "PageTest-B-Strong!", undefined, "seed-b");
  // The first registered user is the instance admin and may read all
  // networks. Register the foreign fixture first so tokenA exercises the
  // ordinary member-scoped path rather than the admin bypass.
  const a = register(`page_a_${Date.now()}`, "PageTest-A-Strong!", undefined, "seed-a");
  expect(a.ok).toBe(true);
  expect(b.ok).toBe(true);
  tokenA = a.token!;
  networkA = a.network_id!;
  networkB = b.network_id!;

  seedTask("a-new", networkA, "agent-a", "2026-01-04 00:00:00");
  seedTask("a-cursor", networkA, "agent-a", "2026-01-03 00:00:00");
  seedTask("a-old-2", networkA, "agent-a", "2026-01-02 00:00:00");
  seedTask("a-old-1", networkA, "agent-b", "2026-01-01 00:00:00");
  seedTask("b-old", networkB, "agent-a", "2026-01-02 12:00:00");

  const mod = await import("./server.js");
  server = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  try { server?.stop(true); } catch {}
  try { rmSync(PRIVATE_DB_DIR, { recursive: true, force: true }); } catch {}
});

async function list(query: string): Promise<{ response: Response; body: any }> {
  const response = await fetch(`${base}/api/tasks?skip_stats=1&${query}`, {
    headers: { Authorization: `Bearer ${tokenA}` },
  });
  return { response, body: await response.json() };
}

describe("GET /api/tasks cursor pagination", () => {
  test("before is exclusive and remains network-scoped", async () => {
    const { response, body } = await list("before=2026-01-03%2000%3A00%3A00&limit=20");
    expect(response.status).toBe(200);
    expect(body.tasks.map((row: any) => row.task_id)).toEqual(["a-old-2", "a-old-1"]);
    expect(body.tasks.some((row: any) => row.task_id === "a-cursor")).toBe(false);
    expect(body.tasks.some((row: any) => row.task_id === "b-old")).toBe(false);
  });

  test("ISO cursor normalizes to SQLite UTC and composes with to_name", async () => {
    const { body } = await list("before=2026-01-03T00%3A00%3A00Z&to_name=agent-a&limit=20");
    expect(body.tasks.map((row: any) => row.task_id)).toEqual(["a-old-2"]);
  });

  test("omitting before preserves the existing response shape and newest-first order", async () => {
    const { body } = await list("limit=20");
    expect(body.ok).toBe(true);
    expect(body.count).toBe(4);
    expect(body.tasks.map((row: any) => row.task_id)).toEqual([
      "a-new",
      "a-cursor",
      "a-old-2",
      "a-old-1",
    ]);
    expect(body.stats).toBeUndefined();
  });

  test("empty, malformed, and rolled-over cursors fail closed", async () => {
    for (const cursor of ["", "not-a-time", "2026-02-31 00:00:00"]) {
      const { response, body } = await list(`before=${encodeURIComponent(cursor)}`);
      expect(response.status).toBe(400);
      expect(body).toEqual({ ok: false, error: "invalid_before" });
    }
  });
});
