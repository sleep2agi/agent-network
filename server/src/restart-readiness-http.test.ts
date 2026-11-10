// #1511 —— `/api/nodes` 要给客户端一份「能不能替你重启」的判断，而且要和在途任务一致。
//
// 客户端场景：保存密钥/env 之后，必须能立刻二选一告诉用户
//   「已安排重启」  vs  「需要你自己重启（命令：…）」
// 判据必须和 restart_node / stop_node 同一份，否则会出现「客户端说空闲、一点就被拒」。

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register, createNetworkTokenForNode } from "./auth.js";
import { db } from "./db.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-restart-readiness-"));
let BASE = "";
let hub: any = null;
const PW = "RestartReadinessPassw0rd!";
let NET = "";
let TOKEN = "";
let USER = "";

async function send(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json };
}

let seq = 0;
function mkNode(prefix: "node" | "n", alias: string, opts: { role?: string; lifecycle?: string } = {}) {
  const id = `${prefix}_rr_${seq++}_${Date.now()}`;
  const snap = opts.role ? JSON.stringify({ role: opts.role }) : null;
  db.run("INSERT INTO nodes (node_id, node_name, alias, runtime, network_id, lifecycle_state, config_snapshot, owner_user_id) VALUES (?1,?2,?2,'codex',?3,?4,?5,?6)",
    [id, alias, NET, opts.lifecycle ?? "active", snap, USER]);
  return id;
}
function mkTaskFor(alias: string, status: string) {
  const taskId = `t_rr_${seq++}`;
  db.run("INSERT INTO tasks (task_id, from_name, to_name, priority, status, content, created_at, network_id) VALUES (?1,'x',?2,'normal',?3,'c',datetime('now'),?4)", [taskId, alias, status, NET]);
  db.run("INSERT INTO inbox (id, session_name, type, task_id, acked, content, created_at, network_id) VALUES (?1,?2,'task',?3,0,'c',datetime('now'),?4)", [`i_rr_${seq++}`, alias, taskId, NET]);
  return taskId;
}

function mkCreateRequest(nodeId: string) {
  db.run(`INSERT INTO node_create_requests
      (request_id, network_id, daemon_node_id, child_name, runtime, flags_json, env_keys, status, created_at, created_by_token)
      VALUES (?1,?2,'node_daemon_rr',?3,'codex','{}','[]','succeeded',?4,'t')`,
    [`cr_${nodeId.slice(5)}`, NET, `child-${seq++}`, Date.now()]);
}

const rowOf = async (nodeId: string) => {
  const r = await send("GET", `/api/nodes?network_id=${NET}&node_id=${nodeId}`);
  expect(r.status).toBe(200);
  return (r.body.nodes as any[])[0];
};

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";
  const a = register(`rr_owner_${Date.now()}`, PW, undefined, "Owner");
  expect(a.ok).toBe(true);
  TOKEN = a.token!; USER = a.user!.user_id; NET = a.network_id!;
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("#1511 restart_readiness", () => {
  test("没人管的节点 = manual，且 can_restart_now=false", async () => {
    const id = mkNode("n", `solo-${seq}`);
    const row = await rowOf(id);
    expect(row.restart_readiness).toEqual({ path: "manual", in_flight: 0, can_restart_now: false });
  });

  test("created-daemon 的节点 = restart_node；在途任务让它变 false", async () => {
    const id = mkNode("node", `supervised-${seq}`);
    mkCreateRequest(id);
    let row = await rowOf(id);
    expect(row.restart_readiness.path).toBe("restart_node");
    expect(row.restart_readiness.can_restart_now).toBe(true);

    mkTaskFor(row.alias, "running");
    row = await rowOf(id);
    expect(row.restart_readiness.in_flight).toBe(1);
    expect(row.restart_readiness.can_restart_now).toBe(false);
  });

  test("终态任务不算在途（与 stop_node 同一判据）", async () => {
    const id = mkNode("node", `replied-${seq}`);
    mkCreateRequest(id);
    const row = await rowOf(id);
    mkTaskFor(row.alias, "replied");
    const after = await rowOf(id);
    expect(after.restart_readiness.in_flight).toBe(0);
    expect(after.restart_readiness.can_restart_now).toBe(true);
  });

  test("adopt 来的节点 = stop_then_start（restart_node 会被拒，但 daemon 仍能 Stop→Start）", async () => {
    const id = mkNode("n", `adopted-${seq}`);
    db.run("INSERT INTO node_daemon_bindings (request_id, network_id, node_id, daemon_node_id, workdir, requested_by, status, created_at, updated_at) VALUES (?1,?2,?3,'node_daemon_rr','/tmp','u','active',0,0)",
      [`adopt_rr_${seq}`, NET, id]);
    const row = await rowOf(id);
    expect(row.restart_readiness).toEqual({ path: "stop_then_start", in_flight: 0, can_restart_now: true });
  });

  test("stopped 节点：在途计数不挡路（restart 是把 lifecycle 翻回 active 的出口）", async () => {
    const id = mkNode("node", `stopped-${seq}`, { lifecycle: "stopped" });
    mkCreateRequest(id);
    const row = await rowOf(id);
    mkTaskFor(row.alias, "running");
    const after = await rowOf(id);
    expect(after.restart_readiness.in_flight).toBe(1);
    expect(after.restart_readiness.can_restart_now).toBe(true);
  });
});
