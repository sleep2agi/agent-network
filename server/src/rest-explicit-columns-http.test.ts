import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PRIVATE_DB_DIR = mkdtempSync(join(tmpdir(), "anet-rest-columns-"));
process.env.COMMHUB_DB ||= join(PRIVATE_DB_DIR, "hub.db");

let db: typeof import("./db.js").db;
let server: ReturnType<typeof Bun.serve>;
let base = "";
let token = "";
let networkId = "";

const INTERNAL_SENTINEL = "future_internal_only";
const sortedKeys = (value: Record<string, unknown>): string[] => Object.keys(value).sort();
const sorted = (values: readonly string[]): string[] => [...values].sort();

// Independent wire-contract golden. Do not derive these expectations from
// rest-projections.ts: doing so makes a deleted projection column disappear
// from both the response and the expected value, producing a false green.
const GOLDEN_RESPONSE_KEYS = {
  networkList: [
    "network_id", "network_name", "owner_id", "description", "settings",
    "created_at", "updated_at", "visibility", "max_members", "member_role", "name",
  ],
  networkDetail: [
    "network_id", "network_name", "owner_id", "description", "settings",
    "created_at", "updated_at", "visibility", "max_members",
  ],
  statusSession: [
    "resume_id", "alias", "tmux_name", "server", "ip", "hostname", "agent",
    "project_dir", "version", "status", "task", "output", "progress", "score",
    "cpu_load_1min", "cpu_cores", "mem_total_gb", "mem_used_gb", "mem_avail_gb",
    "disk_total_gb", "disk_used_gb", "disk_avail_gb", "process_rss_bytes",
    "process_rss_mb", "process_cpu_pct", "process_uptime_seconds",
    "process_in_flight_count", "network_id", "registered_at", "updated_at",
    "node_id", "session_id", "config_path", "channels", "last_seen_at", "model",
    "runtime", "host", "process_telemetry",
  ],
  task: [
    "task_id", "from_node_id", "from_name", "to_node_id", "to_name", "priority",
    "status", "content", "result", "in_reply_to", "requires_response", "scope",
    "created_at", "delivered_at", "started_at", "runtime_submitted_at", "consumed_at",
    "completed_at", "expires_at", "network_id", "parent_task_id", "meta_json",
  ],
  audit: [
    "id", "user_id", "username", "action", "target_type", "target_id", "detail",
    "ip", "network_id", "created_at",
  ],
  taskEvent: [
    "id", "task_id", "from_status", "to_status", "event_type", "actor", "detail",
    "created_at", "network_id",
  ],
  completion: [
    "id", "session_name", "task", "result", "artifacts", "score",
    "duration_minutes", "network_id", "completed_at",
  ],
  scheduledTask: [
    "schedule_id", "network_id", "name", "target_node_id", "target_alias",
    "task_content", "priority", "schedule_type", "timezone", "overlap_policy",
    "misfire_policy", "status", "next_run_at", "last_run_at", "revision",
    "created_at", "updated_at", "schedule",
  ],
} as const;

async function api(path: string): Promise<any> {
  const response = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  return response.json();
}

beforeAll(async () => {
  ({ db } = await import("./db.js"));
  const { register } = await import("./auth.js");
  const auth = register(`rest_shape_${Date.now()}`, "RestShape-Strong-1!", undefined, "rest-shape");
  expect(auth.ok).toBe(true);
  token = auth.token!;
  networkId = auth.network_id!;

  // Simulate future migrations. Any REST SELECT * silently broadcasts these
  // columns; every endpoint below must keep them private without needing a
  // code change when the table grows.
  for (const table of ["networks", "sessions", "audit_log", "task_events", "tasks", "completions", "scheduled_tasks"]) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${INTERNAL_SENTINEL} TEXT`);
  }

  db.run(
    `INSERT INTO sessions (resume_id, alias, status, agent, model, network_id)
     VALUES ('resume-rest-shape', 'rest-shape-node', 'idle', 'agent-node:codex', 'gpt-shape', ?1)`,
    [networkId],
  );
  db.run(
    `INSERT INTO tasks (task_id, from_name, to_name, status, content, priority, network_id, parent_task_id, meta_json)
     VALUES ('task-rest-shape', 'sender', 'rest-shape-node', 'delivered', 'shape', 'normal', ?1, 'parent-shape', '{"attachment":true}')`,
    [networkId],
  );
  db.run(
    `INSERT INTO task_events (task_id, from_status, to_status, actor, detail, network_id)
     VALUES ('task-rest-shape', 'created', 'delivered', 'shape-test', 'shape', ?1)`,
    [networkId],
  );
  db.run(
    `INSERT INTO completions (id, session_name, task, result, network_id)
     VALUES ('completion-rest-shape', 'rest-shape-node', 'shape', 'done', ?1)`,
    [networkId],
  );
  db.run(
    `INSERT INTO audit_log (user_id, username, action, target_type, target_id, detail, ip, network_id)
     VALUES ((SELECT owner_id FROM networks WHERE network_id = ?1), 'shape-user', 'shape_action', 'shape', 'shape-id', 'shape', '127.0.0.1', ?1)`,
    [networkId],
  );
  db.run(
    `INSERT INTO scheduled_tasks
       (schedule_id, network_id, created_by, name, target_node_id, target_alias,
        task_content, schedule_type, schedule_json, timezone, next_run_at)
     VALUES ('schedule-rest-shape', ?1, 'private-user-id', 'shape schedule',
             'node-rest-shape', 'rest-shape-node', 'shape task', 'interval',
             '{"type":"interval","every_seconds":3600}', 'UTC', '2099-01-01T00:00:00.000Z')`,
    [networkId],
  );

  const mod = await import("./server.js");
  server = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  try { server?.stop(true); } catch {}
  try { rmSync(PRIVATE_DB_DIR, { recursive: true, force: true }); } catch {}
});

describe("#311 REST response projections are stable across future ALTER TABLE", () => {
  test("network list and detail preserve their existing public keys", async () => {
    const list = await api("/api/networks");
    const row = list.networks.find((item: any) => item.network_id === networkId);
    expect(sortedKeys(row)).toEqual(sorted(GOLDEN_RESPONSE_KEYS.networkList));
    expect(row[INTERNAL_SENTINEL]).toBeUndefined();

    const detail = await api(`/api/networks/${networkId}`);
    expect(sortedKeys(detail.network)).toEqual(sorted(GOLDEN_RESPONSE_KEYS.networkDetail));
    expect(detail.network[INTERNAL_SENTINEL]).toBeUndefined();
  });

  test("full status preserves telemetry compatibility without storage drift", async () => {
    const body = await api(`/api/status?network_id=${networkId}`);
    const row = body.sessions.find((item: any) => item.alias === "rest-shape-node");
    expect(sortedKeys(row)).toEqual(sorted(GOLDEN_RESPONSE_KEYS.statusSession));
    expect(row[INTERNAL_SENTINEL]).toBeUndefined();
  });

  test("task list and task detail expose the same explicit contract", async () => {
    const list = await api(`/api/tasks?network_id=${networkId}&task_id=task-rest-shape&skip_stats=1`);
    expect(sortedKeys(list.tasks[0])).toEqual(sorted(GOLDEN_RESPONSE_KEYS.task));
    expect(list.tasks[0][INTERNAL_SENTINEL]).toBeUndefined();

    const detail = await api(`/api/tasks/task-rest-shape?network_id=${networkId}`);
    expect(sortedKeys(detail.task)).toEqual(sorted(GOLDEN_RESPONSE_KEYS.task));
    expect(detail.task[INTERNAL_SENTINEL]).toBeUndefined();
  });

  test("audit, task-event, and completion rows are explicit", async () => {
    const audit = await api("/api/audit-log?action=shape_action");
    expect(sortedKeys(audit.logs[0])).toEqual(sorted(GOLDEN_RESPONSE_KEYS.audit));
    expect(audit.logs[0][INTERNAL_SENTINEL]).toBeUndefined();

    const events = await api(`/api/task_events?network_id=${networkId}&task_id=task-rest-shape`);
    expect(sortedKeys(events.events[0])).toEqual(sorted(GOLDEN_RESPONSE_KEYS.taskEvent));
    expect(events.events[0][INTERNAL_SENTINEL]).toBeUndefined();

    const completions = await api(`/api/completions?network_id=${networkId}&since=2000-01-01T00:00:00.000Z`);
    expect(sortedKeys(completions.completions[0])).toEqual(sorted(GOLDEN_RESPONSE_KEYS.completion));
    expect(completions.completions[0][INTERNAL_SENTINEL]).toBeUndefined();
  });

  test("scheduled-task decoding keeps storage-only identity and JSON private", async () => {
    const body = await api(`/api/scheduled-tasks?network_id=${networkId}`);
    const row = body.schedules.find((item: any) => item.schedule_id === "schedule-rest-shape");
    expect(sortedKeys(row)).toEqual(sorted(GOLDEN_RESPONSE_KEYS.scheduledTask));
    expect(row.created_by).toBeUndefined();
    expect(row.schedule_json).toBeUndefined();
    expect(row[INTERNAL_SENTINEL]).toBeUndefined();
  });
});
