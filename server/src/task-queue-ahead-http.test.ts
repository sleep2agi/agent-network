// #500 step 2 —— 派活时让发送方看见目标的队列。HTTP 集成测试(真实 Bun.serve,私有端口,临时库)。
// test2123 在真实 PostgreSQL 上原样再跑一遍(COMMHUB_TEST_PG_URL)。
//
// 任务一律经真入口派出:POST /api/task(用户 / 节点令牌)和 /mcp send_task(节点令牌);消息经 /mcp send_message。
// 只有「历史耗时」和「已开工」这类节点侧时间戳用 SQL 拨。
//
// 钉住:
//   1. queue_ahead = 派这一条之前目标上开着的任务(created/delivered/acked/running,24 小时内);
//      消息不算、终态不算、超过 24 小时的遗弃行不算、别的节点 / 别的网络不算。REST 与 MCP 同一个数。
//   2. target_busy:有已开工(acked / running / consumed_at)的开着任务 → true;会话 working(report_status 真入口)→ true。
//   3. est_wait_minutes:前面没人 → 0;有人但没历史(< 3 条 replied)→ null;有历史 → 中位数 × queue_ahead。
//   4. warning:queue_ahead 2 → 没有;3 → 有,且仍然 200 ok(从不拒绝);est_wait > 30 → 有。
//   5. /api/status 全量每行 queue_depth;light / 旧别名解析器投影没有这个字段(字节不变);
//      只写 tasks 的语句也让全量缓存失效(ETag 变、queue_depth 跟着变);MCP get_all_status 每行 queue_depth。
//
// 跑法:cd server && COMMHUB_DB=/tmp/x.db bun test src/task-queue-ahead-http.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "anet-queue-ahead-"));
process.env.COMMHUB_DB ||= join(DIR, "hub.db");
process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
process.env.HOST = "127.0.0.1";
const PW = "QueueAhead123!x";
const stamp = Date.now();

let db: any;
let hub: any = null;
let BASE = "";
let NET = "", NET2 = "";
let bossToken = "", boss2Token = "";
type Node = { alias: string; nodeId: string; token: string };
const nodes: Record<"sender" | "target" | "idle", Node> = {} as any;
let other: Node;

async function send(token: string, method: string, path: string, payload?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) as any };
}
async function tool(token: string, name: string, args: Record<string, unknown>) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const data = raw.split("\n").filter((x) => x.startsWith("data:"));
  const payload = data.length ? JSON.parse(data.at(-1)!.slice(5).trim()) : JSON.parse(raw);
  return JSON.parse(payload.result.content[0].text);
}

let seq = 0;
const text = () => `queue case ${stamp} #${++seq}`;
/** 经 POST /api/task 派一条,返回整个响应体。 */
async function dispatch(token: string, to: string, extra: Record<string, unknown> = {}) {
  const r = await send(token, "POST", "/api/task", { alias: to, task: text(), network_id: NET, ...extra });
  expect(r.status).toBe(200);
  expect(r.body.ok).toBe(true);
  return r.body;
}
const setStatus = (taskId: string, status: string) => db.run("UPDATE tasks SET status = ?1 WHERE task_id = ?2", [status, taskId]);
const reportStatus = (n: Node, status: string, task?: string) =>
  tool(n.token, "report_status", { resume_id: `sdk-${n.nodeId}`, alias: n.alias, status, node_id: n.nodeId, network_id: NET, ...(task ? { task } : {}) });
/** 目标上 3 条 replied 历史:耗时 10 / 20 / 30 分钟(started_at 到 completed_at),中位数 20。 */
async function seedHistory(to: Node, minutes = [10, 20, 30]) {
  for (const m of minutes) {
    const b = await dispatch(bossToken, to.alias);
    db.run(
      `UPDATE tasks SET status = 'replied', created_at = datetime('now', '-${m + 5} minutes'), started_at = datetime('now', '-${m + 1} minutes'),
         completed_at = datetime('now', '-1 minutes') WHERE task_id = ?1`,
      [b.task_id],
    );
  }
}

beforeAll(async () => {
  ({ db } = await import("./db.js"));
  const { createNetworkTokenForNode, register } = await import("./auth.js");
  const boss = register(`qa_boss_${stamp}`, PW);
  expect(boss.ok).toBe(true);
  bossToken = boss.token!; NET = boss.network_id!;
  const bossId = boss.user!.user_id;
  for (const key of ["sender", "target", "idle"] as const) {
    const alias = `qa-${key}-${stamp}`;
    const nodeId = `n_qa_${key}_${stamp}`;
    const minted = createNetworkTokenForNode(bossId, NET, alias, nodeId);
    expect(minted.ok).toBe(true);
    nodes[key] = { alias, nodeId, token: minted.token! };
  }
  // 另一个网络里一个**同名**节点:它的任务不许算进 NET 的队列。
  const boss2 = register(`qa_boss2_${stamp}`, PW);
  boss2Token = boss2.token!; NET2 = boss2.network_id!;
  const m2 = createNetworkTokenForNode(boss2.user!.user_id, NET2, nodes.target.alias, `n_qa_other_${stamp}`);
  other = { alias: nodes.target.alias, nodeId: `n_qa_other_${stamp}`, token: m2.token! };
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
  for (const n of Object.values(nodes)) expect((await reportStatus(n, "idle")).ok).toBe(true);
  expect((await tool(other.token, "report_status", { resume_id: `sdk-${other.nodeId}`, alias: other.alias, status: "idle", node_id: other.nodeId, network_id: NET2 })).ok).toBe(true);
}, 30_000);

beforeEach(async () => {
  // 每条用例从「目标上没有开着的任务、没有历史、会话 idle」开始。
  db.run("UPDATE tasks SET status = 'cancelled', completed_at = datetime('now') WHERE network_id IN (?1, ?2) AND status IN ('created', 'delivered', 'acked', 'running')", [NET, NET2]);
  db.run("DELETE FROM tasks WHERE network_id = ?1 AND status = 'replied'", [NET]);
  for (const n of Object.values(nodes)) await reportStatus(n, "idle");
});

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("#500 queue_ahead on dispatch", () => {
  test("empty target → queue_ahead 0, not busy, est_wait 0, no warning (REST and MCP)", async () => {
    const r = await dispatch(nodes.sender.token, nodes.target.alias);
    expect(r).toMatchObject({ queue_ahead: 0, target_busy: false, est_wait_minutes: 0 });
    expect(r.warning).toBeUndefined();
    setStatus(r.task_id, "cancelled");
    const m = await tool(nodes.sender.token, "send_task", { alias: nodes.target.alias, task: text(), network_id: NET });
    expect(m.ok).toBe(true);
    expect(m).toMatchObject({ queue_ahead: 0, target_busy: false, est_wait_minutes: 0 });
    expect(m.warning).toBeUndefined();
  });

  test("counts open tasks only: messages, terminal, >24 h stale, other nodes and other networks are excluded", async () => {
    const a = await dispatch(bossToken, nodes.target.alias);        // delivered → counts
    const b = await dispatch(nodes.idle.token, nodes.target.alias); // delivered → counts (another sender)
    // 消息:只写 inbox,不算。
    expect((await tool(nodes.sender.token, "send_message", { alias: nodes.target.alias, message: `msg ${stamp}`, network_id: NET })).ok).toBe(true);
    // 终态:不算。
    for (const st of ["replied", "failed", "expired", "cancelled"]) setStatus((await dispatch(bossToken, nodes.target.alias)).task_id, st);
    // 24 小时之前派出、从没终态的遗弃行:不算。
    const stale = await dispatch(bossToken, nodes.target.alias);
    db.run("UPDATE tasks SET status = 'running', created_at = datetime('now', '-25 hours') WHERE task_id = ?1", [stale.task_id]);
    // 别的节点 / 别的网络里同名节点:不算。
    await dispatch(bossToken, nodes.idle.alias);
    const o = await send(boss2Token, "POST", "/api/task", { alias: other.alias, task: text(), network_id: NET2 });
    expect(o.status).toBe(200);
    expect(o.body.queue_ahead).toBe(0);

    const r = await dispatch(nodes.sender.token, nodes.target.alias);
    expect(r.queue_ahead).toBe(2);
    expect(r.target_busy).toBe(false);
    // MCP 同一个数(上一条也开着了 → 3)。
    const m = await tool(nodes.sender.token, "send_task", { alias: nodes.target.alias, task: text(), network_id: NET });
    expect(m.queue_ahead).toBe(3);
    // acked / running 也是开着的。
    setStatus(a.task_id, "acked"); setStatus(b.task_id, "running");
    const r2 = await dispatch(nodes.sender.token, nodes.target.alias);
    expect(r2.queue_ahead).toBe(4);
  });

  test("target_busy: a started open task, or the session reporting working", async () => {
    const a = await dispatch(bossToken, nodes.target.alias);
    expect((await dispatch(nodes.sender.token, nodes.target.alias)).target_busy).toBe(false);
    // 运行时取走(consumed_at)但状态还是 delivered → 已开工。
    db.run("UPDATE tasks SET consumed_at = datetime('now') WHERE task_id = ?1", [a.task_id]);
    expect((await dispatch(nodes.sender.token, nodes.target.alias)).target_busy).toBe(true);
    db.run("UPDATE tasks SET status = 'cancelled' WHERE network_id = ?1 AND status = 'delivered'", [NET]);
    expect((await dispatch(nodes.sender.token, nodes.target.alias)).target_busy).toBe(false);
    // 真入口:节点 report_status(working, task=<原文>)→ 任务 running + 会话 working。
    const c = await dispatch(bossToken, nodes.target.alias);
    const content = db.get("SELECT content FROM tasks WHERE task_id = ?1", c.task_id).content;
    expect((await reportStatus(nodes.target, "working", content)).ok).toBe(true);
    expect(db.get("SELECT status FROM tasks WHERE task_id = ?1", c.task_id).status).toBe("running");
    const r = await dispatch(nodes.sender.token, nodes.target.alias);
    expect(r.target_busy).toBe(true);
    expect(r.queue_ahead).toBe(2);
    // 会话 working 但没有开着的任务 → 仍然 busy(节点自己说在忙)。
    db.run("UPDATE tasks SET status = 'cancelled' WHERE network_id = ?1 AND status IN ('delivered','running')", [NET]);
    const w = await dispatch(nodes.sender.token, nodes.target.alias);
    expect(w).toMatchObject({ queue_ahead: 0, target_busy: true, est_wait_minutes: 0 });
  });

  test("est_wait_minutes: null without history, median × queue_ahead with it", async () => {
    await dispatch(bossToken, nodes.target.alias);
    const noHist = await dispatch(nodes.sender.token, nodes.target.alias);
    expect(noHist.queue_ahead).toBe(1);
    expect(noHist.est_wait_minutes).toBeNull();
    // 两条历史还不够(< 3)。
    await seedHistory(nodes.target, [10, 20]);
    expect((await dispatch(nodes.sender.token, nodes.target.alias)).est_wait_minutes).toBeNull();
    db.run("DELETE FROM tasks WHERE network_id = ?1 AND status = 'replied'", [NET]);
    await seedHistory(nodes.target, [10, 20, 60]);
    const r = await dispatch(nodes.sender.token, nodes.target.alias);
    expect(r.queue_ahead).toBe(3);
    expect(r.est_wait_minutes).toBe(60); // 中位数 20 × 3(平均数会是 30 × 3 = 90)
    // 别的节点的历史不借用。
    const idle = await dispatch(nodes.sender.token, nodes.idle.alias);
    expect(idle.est_wait_minutes).toBe(0);
    const idle2 = await dispatch(nodes.sender.token, nodes.idle.alias);
    expect(idle2.est_wait_minutes).toBeNull();
  });

  test("warning at queue_ahead ≥ 3 or est_wait > 30 — the send still succeeds", async () => {
    await dispatch(bossToken, nodes.target.alias);
    await dispatch(bossToken, nodes.target.alias);
    const two = await dispatch(nodes.sender.token, nodes.target.alias); // 前面 2 条
    expect(two.queue_ahead).toBe(2);
    expect(two.warning).toBeUndefined();
    const three = await dispatch(nodes.sender.token, nodes.target.alias, { ttl_seconds: 1800 }); // 前面 3 条
    expect(three.ok).toBe(true);
    expect(three.queue_ahead).toBe(3);
    expect(typeof three.warning).toBe("string");
    for (const frag of [nodes.target.alias, "3 open task(s) ahead", "queued, not refused", "idle node", "ttl_seconds", "30 min", "Do not resend"]) {
      expect(three.warning).toContain(frag);
    }
    // 任务确实写进去了(没被拒)。
    expect(db.get("SELECT status FROM tasks WHERE task_id = ?1", three.task_id).status).toBe("delivered");
    // MCP 同样带 warning。
    const m = await tool(nodes.sender.token, "send_task", { alias: nodes.target.alias, task: text(), network_id: NET });
    expect(m.ok).toBe(true);
    expect(m.queue_ahead).toBe(4);
    expect(m.warning).toContain("4 open task(s) ahead");

    // 只排 1 个,但估计要等 > 30 分钟 → 也给。
    db.run("UPDATE tasks SET status = 'cancelled' WHERE network_id = ?1 AND status = 'delivered'", [NET]);
    await seedHistory(nodes.target, [40, 45, 50]);
    await dispatch(bossToken, nodes.target.alias);
    const slow = await dispatch(nodes.sender.token, nodes.target.alias, { ttl_seconds: 1800 });
    expect(slow).toMatchObject({ queue_ahead: 1, est_wait_minutes: 45 });
    expect(slow.warning).toContain("rough wait ~45 min");
    expect(slow.warning).toContain("may expire before it starts");
  });
});

describe("#500 queue_depth on status reads", () => {
  const rowOf = (body: any, alias: string) => body.sessions.find((s: any) => s.alias === alias);

  test("/api/status full rows carry queue_depth; light and the old alias-resolver projection do not", async () => {
    await dispatch(bossToken, nodes.target.alias);
    await dispatch(bossToken, nodes.target.alias);
    const full = await send(bossToken, "GET", `/api/status?network_id=${NET}`);
    expect(full.status).toBe(200);
    expect(rowOf(full.body, nodes.target.alias).queue_depth).toBe(2);
    expect(rowOf(full.body, nodes.idle.alias).queue_depth).toBe(0);
    const light = await send(bossToken, "GET", `/api/status?network_id=${NET}&light=1`);
    expect("queue_depth" in rowOf(light.body, nodes.target.alias)).toBe(false);
    const resolver = await send(nodes.idle.token, "GET", `/api/status?network_id=${NET}`, undefined, { Accept: "application/json" });
    expect(resolver.headers.get("x-status-projection")).toBe("alias-resolver");
    expect("queue_depth" in rowOf(resolver.body, nodes.target.alias)).toBe(false);
    // 另一个网络里的同名节点:看不到 NET 的队列。
    const net2 = await send(boss2Token, "GET", `/api/status?network_id=${NET2}`);
    expect(rowOf(net2.body, other.alias).queue_depth).toBe(0);
    // App 的单行读(?alias=)只查这一个别名,数一样。
    const one = await send(bossToken, "GET", `/api/status?network_id=${NET}&alias=${encodeURIComponent(nodes.target.alias)}`);
    expect(one.body.sessions.length).toBe(1);
    expect(one.body.sessions[0].queue_depth).toBe(2);
  });

  test("queueDepthByNode: the alias-list query and the whole-table scan (> 50 aliases) give the same counts", async () => {
    const { queueDepthByNode, queueDepthKey, QUEUE_DEPTH_ALIAS_LIST_MAX } = await import("./task-queue-ahead.js");
    await dispatch(bossToken, nodes.target.alias);
    await dispatch(bossToken, nodes.target.alias);
    await dispatch(bossToken, nodes.idle.alias);
    await send(boss2Token, "POST", "/api/task", { alias: other.alias, task: text(), network_id: NET2 });
    const few = queueDepthByNode([nodes.target.alias, nodes.idle.alias]);
    const fillers = Array.from({ length: QUEUE_DEPTH_ALIAS_LIST_MAX }, (_, i) => `qa-filler-${i}`);
    const many = queueDepthByNode([nodes.target.alias, nodes.idle.alias, ...fillers]);
    for (const m of [few, many]) {
      expect(m.get(queueDepthKey(NET, nodes.target.alias))).toBe(2);
      expect(m.get(queueDepthKey(NET, nodes.idle.alias))).toBe(1);
      expect(m.get(queueDepthKey(NET2, other.alias))).toBe(1); // 同名、别的网络:分开计
    }
    expect(queueDepthByNode([]).size).toBe(0);
  });

  test("a write that touches only tasks invalidates the cached full body (new ETag, new queue_depth); light stays cached", async () => {
    const a = await dispatch(bossToken, nodes.target.alias);
    await dispatch(bossToken, nodes.target.alias);
    const first = await send(bossToken, "GET", `/api/status?network_id=${NET}`);
    const etag = first.headers.get("etag")!;
    expect(rowOf(first.body, nodes.target.alias).queue_depth).toBe(2);
    const lightBefore = await send(bossToken, "GET", `/api/status?network_id=${NET}&light=1`);
    // 只改 tasks(不碰 sessions):全量必须重算。
    setStatus(a.task_id, "replied");
    const again = await send(bossToken, "GET", `/api/status?network_id=${NET}`, undefined, { "If-None-Match": etag });
    expect(again.status).toBe(200);
    expect(again.headers.get("etag")).not.toBe(etag);
    expect(rowOf(again.body, nodes.target.alias).queue_depth).toBe(1);
    // light 不读 tasks:同一个 ETag → 304。
    const lightAfter = await fetch(`${BASE}/api/status?network_id=${NET}&light=1`, { headers: { Authorization: `Bearer ${bossToken}`, "If-None-Match": lightBefore.headers.get("etag")! } });
    expect(lightAfter.status).toBe(304);
    // 没有写 → 全量命中缓存:同一个 ETag → 304。
    const cached = await fetch(`${BASE}/api/status?network_id=${NET}`, { headers: { Authorization: `Bearer ${bossToken}`, "If-None-Match": again.headers.get("etag")! } });
    expect(cached.status).toBe(304);
  });

  test("MCP get_all_status rows carry queue_depth", async () => {
    await dispatch(bossToken, nodes.target.alias);
    const r = await tool(bossToken, "get_all_status", { network_id: NET, filter_alias: `${nodes.target.alias},${nodes.idle.alias}` });
    expect(r.ok).toBe(true);
    expect(rowOf(r, nodes.target.alias).queue_depth).toBe(1);
    expect(rowOf(r, nodes.idle.alias).queue_depth).toBe(0);
  });
});
