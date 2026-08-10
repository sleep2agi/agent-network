import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PRIVATE_DB_DIR = mkdtempSync(join(tmpdir(), "anet-task-diagnostic-"));
process.env.COMMHUB_DB = join(PRIVATE_DB_DIR, "hub.db");

let db: typeof import("./db.js").db;
let server: ReturnType<typeof Bun.serve>;
let base = "";
let tokenA = "";
let tokenB = "";
let networkA = "";
let networkB = "";

const ALIAS = "diagnostic-worker";

async function detail(token: string, taskId: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}/api/tasks/${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: await response.json() };
}

function insertTask(taskId: string, patch: {
  status?: string;
  runtimeSubmittedAt?: string | null;
  consumedAt?: string | null;
} = {}) {
  db.run(
    `INSERT INTO tasks
       (task_id, from_name, to_node_id, to_name, status, content, priority,
        network_id, runtime_submitted_at, consumed_at)
     VALUES (?1, 'diagnostic-sender', 'node-diagnostic-a', ?2, ?3,
             'diagnose me', 'normal', ?4, ?5, ?6)`,
    [taskId, ALIAS, patch.status ?? "delivered", networkA, patch.runtimeSubmittedAt ?? null, patch.consumedAt ?? null],
  );
}

async function openSse(token: string, networkId: string): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const response = await fetch(`${base}/events/${encodeURIComponent(ALIAS)}?network_id=${encodeURIComponent(networkId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toContain('"type":"connected"');
  return reader;
}

beforeAll(async () => {
  ({ db } = await import("./db.js"));
  const { register } = await import("./auth.js");
  const authA = register(`diagnostic_a_${Date.now()}`, "Diagnostic-A-Strong-1!", undefined, "diagnostic-a");
  const authB = register(`diagnostic_b_${Date.now()}`, "Diagnostic-B-Strong-1!", undefined, "diagnostic-b");
  expect(authA.ok).toBe(true);
  expect(authB.ok).toBe(true);
  tokenA = authA.token!;
  tokenB = authB.token!;
  networkA = authA.network_id!;
  networkB = authB.network_id!;

  for (const [networkId, suffix] of [[networkA, "a"], [networkB, "b"]] as const) {
    db.run(
      `INSERT INTO nodes
         (node_id, node_name, alias, network_id, hostname, created_at, updated_at, lifecycle_state)
       VALUES (?1, ?2, ?2, ?3, 'diagnostic-host', datetime('now'), datetime('now'), 'active')`,
      [`node-diagnostic-${suffix}`, ALIAS, networkId],
    );
    db.run(
      `INSERT INTO sessions
         (resume_id, alias, status, node_id, network_id, updated_at, last_seen_at)
       VALUES (?1, ?2, 'idle', ?3, ?4, datetime('now'), datetime('now'))`,
      [`resume-diagnostic-${suffix}`, ALIAS, `node-diagnostic-${suffix}`, networkId],
    );
  }

  const mod = await import("./server.js");
  server = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  try { server?.stop(true); } catch {}
  try { rmSync(PRIVATE_DB_DIR, { recursive: true, force: true }); } catch {}
});

describe("#166 scoped single-task diagnostics", () => {
  test("does not count another network's same-alias SSE connection", async () => {
    insertTask("diag-cross-network");
    const foreignReader = await openSse(tokenB, networkB);
    try {
      const own = await detail(tokenA, "diag-cross-network");
      expect(own.status).toBe(200);
      expect(own.body.diagnostic).toMatchObject({
        code: "target_no_live_sse",
        evidence: { live_sse_connections: 0 },
      });
      const foreign = await detail(tokenB, "diag-cross-network");
      expect(foreign.status).toBe(404);
      expect(foreign.body).toMatchObject({ ok: false, error: "task_not_found" });
    } finally {
      await foreignReader.cancel();
    }
  });

  test("reports a live same-network SSE without claiming runtime consumption", async () => {
    insertTask("diag-live-sse");
    const reader = await openSse(tokenA, networkA);
    try {
      const result = await detail(tokenA, "diag-live-sse");
      expect(result.body.diagnostic).toMatchObject({
        code: "delivered_waiting_for_agent",
        evidence: {
          target_session_status: "idle",
          live_sse_connections: 1,
          runtime_submitted: false,
          runtime_consumed: false,
        },
      });
    } finally {
      await reader.cancel();
    }
  });

  test("uses authoritative runtime evidence before current connectivity", async () => {
    insertTask("diag-submitted", { runtimeSubmittedAt: "2026-08-10T00:00:00Z" });
    insertTask("diag-consumed", {
      runtimeSubmittedAt: "2026-08-10T00:00:00Z",
      consumedAt: "2026-08-10T00:00:01Z",
    });
    db.run("UPDATE sessions SET status = 'offline' WHERE node_id = 'node-diagnostic-a' AND network_id = ?1", [networkA]);
    expect((await detail(tokenA, "diag-submitted")).body.diagnostic.code).toBe("runtime_submitted_waiting_for_signal");
    expect((await detail(tokenA, "diag-consumed")).body.diagnostic.code).toBe("runtime_consumed_nonterminal");
  });

  test("distinguishes offline and missing target sessions", async () => {
    insertTask("diag-offline");
    expect((await detail(tokenA, "diag-offline")).body.diagnostic.code).toBe("target_session_offline");
    db.run("DELETE FROM sessions WHERE node_id = 'node-diagnostic-a' AND network_id = ?1", [networkA]);
    insertTask("diag-missing");
    expect((await detail(tokenA, "diag-missing")).body.diagnostic.code).toBe("target_session_missing");
  });
});
