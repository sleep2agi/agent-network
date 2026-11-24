// #5502 —— POST /api/tasks/:id/recall 撤回未回复任务（原子撤单 + ack inbox + meta_json.recalled）
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "anet-recall-"));
process.env.COMMHUB_DB ||= join(DIR, "hub.db");
let hub: ReturnType<typeof Bun.serve>;
let base = "", net = "", ownerToken = "", ownerUsername = "", memberToken = "", memberUsername = "";

beforeAll(async () => {
  process.env.COMMHUB_AUTH_TOKEN ||= "legacy-master-token-for-test";
  const { db } = await import("./db.js");
  const { register } = await import("./auth.js");
  const stamp = Date.now();
  ownerUsername = `recall_owner_${stamp}`;
  const owner = register(ownerUsername, "Recall-Owner-1!");
  net = owner.network_id!;
  ownerToken = owner.token!;

  memberUsername = `recall_member_${stamp}`;
  const member = register(memberUsername, "Recall-Member-1!");
  memberToken = member.token!;
  const memberId = (member as any).user?.user_id ?? (member as any).user_id ?? db.get<any>("SELECT user_id FROM users WHERE username = ?1", memberUsername)?.user_id;
  db.run(
    `INSERT OR REPLACE INTO network_members (network_id, user_id, role, joined_at) VALUES (?1, ?2, 'member', datetime('now'))`,
    [net, memberId],
  );
  const now = Date.now();
  db.run(
    `INSERT OR REPLACE INTO nodes (node_id, node_name, network_id, alias, runtime, created_at, updated_at)
     VALUES ('n_target', 'target-bot', ?1, 'target-bot', 'antigravity', ?2, ?2)`,
    [net, now],
  );
  const mod = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${hub.port}`;
}, 60_000);

afterAll(() => {
  try { hub?.stop(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

async function seedTask(taskId: string, opts: { from: string; status: string; result?: string | null; meta?: Record<string, unknown> }) {
  const { db } = await import("./db.js");
  db.run(
    `INSERT INTO tasks (task_id, from_name, to_name, to_node_id, status, content, result, meta_json, network_id, created_at)
     VALUES (?1, ?2, 'target-bot', 'n_target', ?3, '请帮我发版', ?4, ?5, ?6, datetime('now'))`,
    [taskId, opts.from, opts.status, opts.result ?? null, opts.meta ? JSON.stringify(opts.meta) : null, net],
  );
  db.run(
    `INSERT INTO inbox (id, task_id, session_name, from_session, content, type, acked, network_id, created_at)
     VALUES (?1, ?1, 'target-bot', ?2, '请帮我发版', 'task', 0, ?3, datetime('now'))`,
    [taskId, opts.from, net],
  );
}

describe("#5502 POST /api/tasks/:id/recall", () => {
  test("排队中的任务可被发送者原子撤回：status=cancelled、inbox acked、meta_json.recalled=true 且幂等", async () => {
    const taskId = `t_delivered_${Date.now()}`;
    await seedTask(taskId, { from: ownerUsername, status: "delivered", meta: { client_request_id: "req_1" } });

    const r1 = await fetch(`${base}/api/tasks/${taskId}/recall`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(r1.status).toBe(200);
    const b1: any = await r1.json();
    expect(b1.ok).toBe(true);
    expect(b1.recalled).toBe(true);
    expect(b1.already_recalled).toBe(false);
    expect(b1.previous_status).toBe("delivered");

    const { db } = await import("./db.js");
    const row = db.get<any>("SELECT status, result, meta_json FROM tasks WHERE task_id = ?1", taskId);
    expect(row.status).toBe("cancelled");
    expect(row.result).toBeNull();
    const meta = JSON.parse(row.meta_json);
    expect(meta.recalled).toBe(true);
    expect(meta.client_request_id).toBe("req_1");
    expect(typeof meta.recalled_at).toBe("string");

    const inboxRow = db.get<any>("SELECT acked FROM inbox WHERE task_id = ?1", taskId);
    expect(inboxRow.acked).toBe(1);

    // 幂等再次调用
    const r2 = await fetch(`${base}/api/tasks/${taskId}/recall`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(r2.status).toBe(200);
    const b2: any = await r2.json();
    expect(b2.already_recalled).toBe(true);
  });

  test("running 状态的任务可撤回（供支持中断的客户端先 interrupt 再 recall）", async () => {
    const taskId = `t_running_${Date.now()}`;
    await seedTask(taskId, { from: memberUsername, status: "running" });

    const r = await fetch(`${base}/api/tasks/${taskId}/recall`, {
      method: "POST",
      headers: { Authorization: `Bearer ${memberToken}` },
    });
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.recalled).toBe(true);
    expect(b.previous_status).toBe("running");
  });

  test("已回复的终态任务拒绝撤回（409 task_already_terminal）且不改写原回复", async () => {
    const taskId = `t_replied_${Date.now()}`;
    await seedTask(taskId, { from: ownerUsername, status: "replied", result: "已完成发版" });

    const r = await fetch(`${base}/api/tasks/${taskId}/recall`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(r.status).toBe(409);
    const b: any = await r.json();
    expect(b.ok).toBe(false);
    expect(b.error).toBe("task_already_terminal");
    expect(b.task_status).toBe("replied");

    const { db } = await import("./db.js");
    const row = db.get<any>("SELECT status, result FROM tasks WHERE task_id = ?1", taskId);
    expect(row.status).toBe("replied");
    expect(row.result).toBe("已完成发版");
  });

  test("非发送者的普通成员无权撤回他人消息（403 recall_sender_only）", async () => {
    const taskId = `t_other_${Date.now()}`;
    await seedTask(taskId, { from: ownerUsername, status: "delivered" });

    const r = await fetch(`${base}/api/tasks/${taskId}/recall`, {
      method: "POST",
      headers: { Authorization: `Bearer ${memberToken}` },
    });
    expect(r.status).toBe(403);
    const b: any = await r.json();
    expect(b.error).toBe("recall_sender_only");
  });
});
