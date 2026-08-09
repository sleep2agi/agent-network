import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register } from "./auth.js";
import { db } from "./db.js";

const PRIVATE_DB_DIR = mkdtempSync(join(tmpdir(), "anet-task-network-resolution-"));
let server: any;
let base = "";

type Principal = { token: string; userId: string; networkId: string; target: string };
let adminSingle: Principal;
let userSingle: Principal;
let adminMulti: Principal;
let adminZero: Principal;

function registerPrincipal(label: string, admin: boolean): Principal {
  const username = `task_net_${label}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const registered = register(username, "TaskNetwork123!", undefined, "seed");
  expect(registered.ok).toBe(true);
  const userId = db.get<{ user_id: string }>(
    "SELECT user_id FROM users WHERE username = ?1",
    [username],
  )!.user_id;
  if (admin) db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [userId]);
  return {
    token: registered.token!,
    userId,
    networkId: registered.network_id!,
    target: `task-net-${label}-${process.pid}`,
  };
}

function seedTarget(principal: Principal): void {
  const nodeId = `node_${principal.target}`;
  db.run(
    `INSERT INTO sessions (resume_id, alias, status, node_id, network_id, updated_at, last_seen_at)
     VALUES (?1, ?2, 'idle', ?3, ?4, datetime('now'), datetime('now'))`,
    [`resume_${principal.target}`, principal.target, nodeId, principal.networkId],
  );
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, created_at, updated_at, lifecycle_state)
     VALUES (?1, ?2, ?2, ?3, datetime('now'), datetime('now'), 'active')`,
    [nodeId, principal.target, principal.networkId],
  );
}

beforeAll(async () => {
  process.env.COMMHUB_DB = process.env.COMMHUB_DB || join(PRIVATE_DB_DIR, "hub.db");
  adminSingle = registerPrincipal("admin_single", true);
  userSingle = registerPrincipal("user_single", false);
  adminMulti = registerPrincipal("admin_multi", true);
  adminZero = registerPrincipal("admin_zero", true);
  seedTarget(adminSingle);
  seedTarget(userSingle);
  seedTarget(adminMulti);

  const secondNetwork = `net_task_second_${process.pid}`;
  db.run(
    "INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, 'second', ?2, datetime('now'))",
    [secondNetwork, adminMulti.userId],
  );
  db.run(
    "INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, 'owner', datetime('now'))",
    [adminMulti.userId, secondNetwork],
  );
  db.run("DELETE FROM network_members WHERE user_id = ?1", [adminZero.userId]);

  const mod: any = await import("./server.js");
  server = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  try { server?.stop?.(true); } catch {}
  try { rmSync(PRIVATE_DB_DIR, { recursive: true, force: true }); } catch {}
});

async function post(principal: Principal, marker: string, networkId?: string) {
  const response = await fetch(`${base}/api/task`, {
    method: "POST",
    headers: { Authorization: `Bearer ${principal.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      alias: principal.target,
      from: "api",
      task: marker,
      priority: "high",
      ...(networkId ? { network_id: networkId } : {}),
    }),
  });
  return { response, body: await response.json() as any };
}

describe("POST /api/task single-network resolution (#448)", () => {
  test("admin with exactly one membership may omit network_id", async () => {
    const marker = `x448-admin-single-${Date.now()}`;
    const { response, body } = await post(adminSingle, marker);
    expect([200, 202]).toContain(response.status);
    expect(body.ok).toBe(true);
    expect(db.get<{ network_id: string }>("SELECT network_id FROM tasks WHERE content = ?1", [marker])?.network_id)
      .toBe(adminSingle.networkId);
  });

  test("ordinary single-network user behavior remains unchanged", async () => {
    const marker = `x448-user-single-${Date.now()}`;
    const { response, body } = await post(userSingle, marker);
    expect([200, 202]).toContain(response.status);
    expect(body.ok).toBe(true);
    expect(db.get<{ network_id: string }>("SELECT network_id FROM tasks WHERE content = ?1", [marker])?.network_id)
      .toBe(userSingle.networkId);
  });

  test("multi-network admin must select a network explicitly", async () => {
    const { response, body } = await post(adminMulti, `x448-admin-multi-${Date.now()}`);
    expect(response.status).toBe(400);
    expect(body).toEqual({
      ok: false,
      error: "network_id_required",
      message: "network_id is required when the user token has zero or multiple network memberships",
    });
  });

  test("zero-membership admin gets the same accurate error", async () => {
    const { response, body } = await post(adminZero, `x448-admin-zero-${Date.now()}`);
    expect(response.status).toBe(400);
    expect(body.error).toBe("network_id_required");
    expect(body.message).toContain("zero or multiple network memberships");
  });

  test("multi-network admin can still select an explicit member network", async () => {
    const marker = `x448-admin-explicit-${Date.now()}`;
    const { response, body } = await post(adminMulti, marker, adminMulti.networkId);
    expect([200, 202]).toContain(response.status);
    expect(body.ok).toBe(true);
  });
});
