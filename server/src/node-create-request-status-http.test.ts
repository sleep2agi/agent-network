// 桌面向导要看得到 daemon 回的失败原因:GET /api/node-create-requests?request_id=…
// 承重:① 只在调用者的网络作用域里能读到(别的网络 → 404,与不存在同形);② 无用户上下文 401;③ 缺参 400;
// ④ 回的是 daemon ack 写进去的 status/error 原文。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PRIVATE_DB_DIR = mkdtempSync(join(tmpdir(), "anet-create-request-status-"));
process.env.COMMHUB_DB ||= join(PRIVATE_DB_DIR, "hub.db");

let server: ReturnType<typeof Bun.serve>;
let base = "";
let aToken = "", bToken = "", aNet = "", bNet = "";
const MASTER_TOKEN = "legacy-master-token-for-test";

const get = async (path: string, token: string) => {
  const r = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json() as any };
};

beforeAll(async () => {
  process.env.COMMHUB_AUTH_TOKEN ||= MASTER_TOKEN;
  const { db } = await import("./db.js");
  const { register } = await import("./auth.js");
  const stamp = Date.now();
  const admin = register(`cr_admin_${stamp}`, "CrAdmin-Strong-1!");
  expect(admin.ok).toBe(true);
  const a = register(`cr_a_${stamp}`, "CrA-Strong-1!");
  const b = register(`cr_b_${stamp}`, "CrB-Strong-1!");
  expect(a.ok && b.ok).toBe(true);
  aToken = a.token!; bToken = b.token!; aNet = a.network_id!; bNet = b.network_id!;
  const uid = (name: string) => db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", name)!.user_id;
  for (const id of [uid(`cr_a_${stamp}`), uid(`cr_b_${stamp}`)]) {
    expect(db.get<{ role: string }>("SELECT role FROM users WHERE user_id = ?1", id)?.role).toBe("user");
  }
  db.run(
    `INSERT INTO node_create_requests
       (request_id, daemon_node_id, child_name, network_id, runtime, model, flags_json, env_keys, status, child_token_id, created_at, created_by_token, acked_at, error)
     VALUES ('cr_a_failed', 'node_daemon_a', 'vansin-go', ?1, 'opencode-cli', NULL, '{}', '[]', 'failed', NULL, ?2, 'tok', ?2,
             'opencode-cli package entrypoint verification currently requires Linux')`,
    [aNet, Date.now()],
  );
  db.run(
    `INSERT INTO node_create_requests
       (request_id, daemon_node_id, child_name, network_id, runtime, model, flags_json, env_keys, status, child_token_id, created_at, created_by_token)
     VALUES ('cr_b_pending', 'node_daemon_b', 'other', ?1, 'codex-app-server', NULL, '{}', '[]', 'pending', NULL, ?2, 'tok')`,
    [bNet, Date.now()],
  );
  const mod = await import("./server.js");
  server = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  try { server?.stop(true); } catch {}
  try { rmSync(PRIVATE_DB_DIR, { recursive: true, force: true }); } catch {}
});

describe("GET /api/node-create-requests?request_id=", () => {
  test("A reads her own failed request with the daemon's error verbatim", async () => {
    const { status, body } = await get("/api/node-create-requests?request_id=cr_a_failed", aToken);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.request).toMatchObject({
      request_id: "cr_a_failed", child_name: "vansin-go", runtime: "opencode-cli", status: "failed",
      error: "opencode-cli package entrypoint verification currently requires Linux",
    });
  });
  test("🔴 B cannot read A's request — 404, same shape as nonexistent", async () => {
    const other = await get("/api/node-create-requests?request_id=cr_a_failed", bToken);
    const missing = await get("/api/node-create-requests?request_id=cr_nope", bToken);
    expect(other.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(other.body).toEqual(missing.body);
  });
  test("pending request reads as pending with no error", async () => {
    const { body } = await get("/api/node-create-requests?request_id=cr_b_pending", bToken);
    expect(body.request.status).toBe("pending");
    expect(body.request.error).toBeNull();
    expect(body.request.child_node_id).toBeNull();
    expect(body.request.launch_verified_at).toBeNull();
  });
  test("registration timestamp is not launch proof; explicit proof and identity round-trip", async () => {
    const { db } = await import('./db.js');
    db.run(`UPDATE node_create_requests SET status='succeeded', child_node_id='node_verified', acked_at=1234 WHERE request_id='cr_b_pending'`);
    const registered = await get('/api/node-create-requests?request_id=cr_b_pending', bToken);
    expect(registered.body.request.acked_at).toBe(1234);
    expect(registered.body.request.launch_verified_at).toBeNull();
    db.run(`UPDATE node_create_requests SET launch_verified_at=5678 WHERE request_id='cr_b_pending'`);
    const verified = await get('/api/node-create-requests?request_id=cr_b_pending', bToken);
    expect(verified.body.request).toMatchObject({ child_node_id: 'node_verified', launch_verified_at: 5678 });
    expect((await get('/api/node-create-requests?request_id=cr_b_pending', aToken)).status).toBe(404);
  });
  test("missing request_id → 400", async () => {
    const { status, body } = await get("/api/node-create-requests", aToken);
    expect(status).toBe(400);
    expect(body.error).toBe("request_id_required");
  });
  test("legacy master token (no user context) → 401", async () => {
    const { status, body } = await get("/api/node-create-requests?request_id=cr_a_failed", MASTER_TOKEN);
    expect(status).toBe(401);
    expect(body.error).toBe("auth_required");
  });
});
