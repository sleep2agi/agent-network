import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "./db.js";
import { createSSEStream } from "./push.js";
import { dispatchScheduledOccurrence } from "./scheduled-tasks.js";

// A claude-code node's channel server reports status without node_id, so its
// sessions row has node_id NULL. The scheduler used to look the session up by
// node_id only, judged every occurrence "queued" and never rang the doorbell:
// the task sat in the inbox until an unrelated push drained it (20–36 min in
// production).

const NET = "net_sched_doorbell_nodeless";
const NODE = "n_sched_doorbell_cc";
const ALIAS = "sched-doorbell-cc";

function cleanup(): void {
  for (const table of ["task_events", "inbox", "scheduled_task_runs", "scheduled_tasks", "tasks", "sessions", "nodes"]) {
    try { db.run(`DELETE FROM ${table} WHERE network_id = ?1`, [NET]); } catch {}
  }
}

function seedNode(): void {
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, runtime, network_id, lifecycle_state)
     VALUES (?1, ?2, ?2, 'claude-code-cli', ?3, 'active')`,
    [NODE, ALIAS, NET],
  );
}

function seedSession(status: string, nodeId: string | null): void {
  db.run(
    `INSERT INTO sessions (resume_id, alias, status, node_id, network_id, agent, updated_at, last_seen_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'claude-code', datetime('now'), datetime('now'))`,
    [`cc-${crypto.randomUUID()}`, ALIAS, status, nodeId, NET],
  );
}

function seedSchedule(): any {
  const scheduleId = `sched_${crypto.randomUUID()}`;
  db.run(
    `INSERT INTO scheduled_tasks
       (schedule_id, network_id, name, target_node_id, target_alias, task_content, priority,
        schedule_type, schedule_json, timezone, status, next_run_at)
     VALUES (?1, ?2, 'doorbell', ?3, ?4, 'scheduled doorbell task', 'normal', 'interval',
             '{"type":"interval","every_seconds":3600}', 'UTC', 'active', datetime('now', '+1 hour'))`,
    [scheduleId, NET, NODE, ALIAS],
  );
  return db.get("SELECT * FROM scheduled_tasks WHERE schedule_id = ?1", scheduleId);
}

/** Subscribe like the channel server does and collect decoded SSE frames. */
function subscribe(): { frames: any[]; close: () => Promise<void> } {
  const res = createSSEStream(ALIAS, NET);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: any[] = [];
  let buffer = "";
  let open = true;
  (async () => {
    while (open) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() || "";
      for (const block of blocks) {
        const line = block.split("\n").find((l) => l.startsWith("data: "));
        if (line) frames.push(JSON.parse(line.slice(6)));
      }
    }
  })().catch(() => {});
  return {
    frames,
    close: async () => {
      open = false;
      await reader.cancel().catch(() => {});
    },
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

beforeEach(() => {
  cleanup();
  seedNode();
});

afterAll(cleanup);

describe("scheduler doorbell for sessions reported without node_id", () => {
  test("idle node_id-less session is delivered and its subscriber receives new_task", async () => {
    seedSession("idle", null);
    const sub = subscribe();
    try {
      await settle();
      const result = dispatchScheduledOccurrence(seedSchedule(), new Date().toISOString(), false);
      await settle();
      expect(result.status).toBe("delivered");
      expect(db.get<{ status: string }>("SELECT status FROM scheduled_task_runs WHERE run_id = ?1", result.runId)?.status).toBe("delivered");
      const wake = sub.frames.filter((f) => f.type === "new_task");
      expect(wake).toHaveLength(1);
      expect(wake[0].from).toBe("scheduler");
      expect(wake[0].inbox_count).toBe(1);
    } finally {
      await sub.close();
    }
  });

  test("a live subscriber counts even when the session row says offline", async () => {
    seedSession("offline", null);
    const sub = subscribe();
    try {
      await settle();
      const result = dispatchScheduledOccurrence(seedSchedule(), new Date().toISOString(), false);
      await settle();
      expect(result.status).toBe("delivered");
      expect(sub.frames.filter((f) => f.type === "new_task")).toHaveLength(1);
    } finally {
      await sub.close();
    }
  });

  test("offline session with nobody listening stays queued", () => {
    seedSession("offline", null);
    const result = dispatchScheduledOccurrence(seedSchedule(), new Date().toISOString(), false);
    expect(result.status).toBe("queued");
  });
});
