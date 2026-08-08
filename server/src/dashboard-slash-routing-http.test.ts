import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { isInteractiveDashboardTask } from "../../agent-node/src/inbox-dispatch";
import { shouldCreateScheduledGoal } from "../../agent-node/src/goals/routing";
import { createNetworkTokenForNode, register } from "./auth.js";
import { db } from "./db.js";

const PRIVATE_DB_DIR = mkdtempSync(join(tmpdir(), "anet-dashboard-slash-http-"));
const TARGET = `dashboard-slash-target-${process.pid}`;
const TARGET_NODE_ID = `node_dashboard_slash_target_${process.pid}`;
const TARGET_RESUME_ID = `resume_dashboard_slash_target_${process.pid}`;
let server: any;
let base = "";
let userToken = "";
let nodeToken = "";
let networkId = "";
let requestSequence = 0;

beforeAll(async () => {
  process.env.COMMHUB_DB = process.env.COMMHUB_DB || join(PRIVATE_DB_DIR, "hub.db");
  const username = `dashboard_slash_${Date.now()}`;
  const registered = register(username, "DashboardSlash123!", undefined, "seed");
  expect(registered.ok).toBe(true);
  userToken = registered.token!;
  networkId = registered.network_id!;
  const userId = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", [username])!.user_id;
  const minted = createNetworkTokenForNode(userId, networkId, "dashboard-slash-node");
  expect(minted.ok).toBe(true);
  nodeToken = minted.token!;
  db.run(
    `INSERT INTO sessions (resume_id, alias, status, node_id, network_id, updated_at, last_seen_at)
     VALUES (?1, ?2, 'idle', ?3, ?4, datetime('now'), datetime('now'))`,
    [TARGET_RESUME_ID, TARGET, TARGET_NODE_ID, networkId],
  );
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, created_at, updated_at, lifecycle_state)
     VALUES (?1, ?2, ?2, ?3, datetime('now'), datetime('now'), 'active')`,
    [TARGET_NODE_ID, TARGET, networkId],
  );
  const mod: any = await import("./server.js");
  server = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  try { server?.stop?.(true); } catch {}
  try { rmSync(PRIVATE_DB_DIR, { recursive: true, force: true }); } catch {}
});

async function postAndRead(token: string, from: string, task: string) {
  requestSequence += 1;
  const clientRequestId = `dreq_${requestSequence.toString(16).padStart(32, "0")}`;
  const response = await fetch(`${base}/api/task`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      alias: TARGET,
      from,
      network_id: networkId,
      task,
      meta: { source: "dashboard-chat", client_request_id: clientRequestId, auth_origin: "user" },
    }),
  });
  const body = await response.json() as any;
  expect([200, 202]).toContain(response.status);
  const taskId = body.task_id ?? body.message_id;
  const row = db.get<{ content: string; meta_json: string }>(
    "SELECT content, meta_json FROM inbox WHERE id = ?1",
    [taskId],
  );
  expect(row).toBeTruthy();
  return { type: "task", content: row!.content, meta_json: row!.meta_json };
}

describe("real Hub → authenticated Dashboard slash routing", () => {
  test("Dashboard /goal and /loop remain exact native payloads for every runtime", async () => {
    for (const command of ["/goal 更新一下文档", "/loop 5m native loop"] as const) {
      const row = await postAndRead(userToken, "dashboard-user", command);
      expect(row.content).toBe(command);
      expect(isInteractiveDashboardTask(row)).toBe(true);
      for (const runtime of ["codex-app-server", "codex", "claude", "grok", "opencode"] as const) {
        expect(shouldCreateScheduledGoal(row.content, runtime, true)).toBe(false);
      }
    }
  });

  test("Dashboard /agoal and /aloop use the Agent Network scheduler", async () => {
    for (const command of ["/agoal 5m update docs", "/aloop 5m update docs"] as const) {
      const row = await postAndRead(userToken, "dashboard-user", command);
      expect(isInteractiveDashboardTask(row)).toBe(true);
      expect(shouldCreateScheduledGoal(row.content, "codex-app-server", true)).toBe(true);
    }
  });

  test("node token cannot forge Dashboard pass-through and keeps legacy compatibility", async () => {
    const row = await postAndRead(nodeToken, "dashboard-slash-node", "/loop 5m legacy automation");
    expect(JSON.parse(row.meta_json).auth_origin).toBe("node");
    expect(isInteractiveDashboardTask(row)).toBe(false);
    expect(shouldCreateScheduledGoal(row.content, "codex-app-server", false)).toBe(true);
  });
});
