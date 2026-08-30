import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createNetworkTokenForNode, register } from "./auth.js";
import { db } from "./db.js";

const PRIVATE_DB_DIR = mkdtempSync(join(tmpdir(), "anet-auth-origin-http-"));
let server: any;
let base = "";
let userToken = "";
let nodeToken = "";
let networkId = "";
const TARGET = `auth-origin-http-target-${process.pid}`;
const TARGET_NODE_ID = `node_auth_origin_target_${process.pid}`;
const TARGET_RESUME_ID = `resume_auth_origin_target_${process.pid}`;

// 30s 而不是 bun 默认的 5s:这个 hook 跑 register()(KDF)+bootServer(),
// 本机空载基线 ~620ms,而 2026-08-17 与 2026-08-31 两次 CI 上它被 5s 上限打死
// (0 pass / 1 fail / Ran 1 test —— 见 #928、#1627)。5247ms 是**被截断的下界**,
// 不是测量值,所以余量按基线的 ~48x 取,而不是按那个数取。
beforeAll(async () => {
  process.env.COMMHUB_DB = process.env.COMMHUB_DB || join(PRIVATE_DB_DIR, "hub.db");
  const username = `auth_origin_${Date.now()}`;
  const registered = register(username, "AuthOriginTest123!", undefined, "seed");
  expect(registered.ok).toBe(true);
  userToken = registered.token!;
  networkId = registered.network_id!;
  const userId = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", [username])!.user_id;
  const minted = createNetworkTokenForNode(userId, networkId, "auth-origin-node");
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
}, 30_000);

afterAll(() => {
  try { server?.stop?.(true); } catch {}
  try { rmSync(PRIVATE_DB_DIR, { recursive: true, force: true }); } catch {}
});

async function postTask(token: string, from: string, marker: string) {
  const response = await fetch(`${base}/api/task`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      alias: TARGET,
      from,
      network_id: networkId,
      task: marker,
      meta: {
        source: "dashboard-chat",
        client_request_id: `dreq_${"a".repeat(31)}${marker.endsWith("user") ? "1" : "2"}`,
        auth_origin: "user",
      },
    }),
  });
  const body = await response.json() as any;
  expect([200, 202]).toContain(response.status);
  const taskId = body.task_id ?? body.message_id;
  expect(taskId).toBeTruthy();
  const inbox = db.get<{ meta_json: string; task_id: string }>(
    "SELECT meta_json, task_id FROM inbox WHERE id = ?1",
    [taskId],
  )!;
  expect(inbox.task_id).toBe(taskId);
  return JSON.parse(inbox.meta_json);
}

describe("POST /api/task server-authenticated origin", () => {
  test("user token stamps user even when the client supplied another fact", async () => {
    const meta = await postTask(userToken, "dashboard-user", "origin-user");
    expect(meta.auth_origin).toBe("user");
  });

  test("node token cannot spoof Dashboard trust through REST metadata", async () => {
    const meta = await postTask(nodeToken, "auth-origin-node", "origin-node");
    expect(meta.auth_origin).toBe("node");
  });
});
