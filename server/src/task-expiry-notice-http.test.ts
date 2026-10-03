// #500 —— 任务过期时告诉派活的人;节点已经取走的任务不再被过期。HTTP 集成测试(真实 Bun.serve,私有端口,临时库)。
// test2123 在真实 PostgreSQL 上原样再跑一遍(COMMHUB_TEST_PG_URL)。
//
// 任务一律经真入口 POST /api/task 派出(节点令牌 / 用户令牌),只把 created_at / expires_at 往前拨,
// 然后调 TTL 巡检(server.ts patrolExpiredTasks,定时器调的就是它)。收件一侧也走真入口:
// agent 用自己的节点令牌订阅 /events/<alias> 并经 /mcp get_inbox 取;人订阅 /events/users/me。
//
// 钉住:
//   1. consumed_at 早于期限 → 不过期、不通知;consumed_at 晚于期限(迟到的回执)→ 照样过期。
//   2. agent 派的任务过期 → 它收到恰好一条 type=reply / from=hub / requires_response=none 的通知 + SSE new_reply;
//      正文带目标别名、等了几分钟、前面还有几个、retry_task、「不要原样重发」。
//   3. 人派的 → user_inbox kind=task_expired 一条,from_session = 目标节点(出现在与它的会话里)+ SSE desktop_message。
//   4. scheduler 派的 → 谁都不通知。
//   5. 子任务过期 → 父任务的发送方收到一条「子任务已过期」,父任务状态 / result 不变。
//   6. 同一次巡检里同一 (发送方, 目标) 5 条过期 → 只发一条,列出 5 个 id。
//
// 跑法:cd server && COMMHUB_DB=/tmp/x.db bun test src/task-expiry-notice-http.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "anet-expiry-notice-"));
process.env.COMMHUB_DB ||= join(DIR, "hub.db");
process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
process.env.HOST = "127.0.0.1";
const PW = "ExpiryNotice123!x";
const stamp = Date.now();

let db: any;
let patrol: () => void;
let KIND = "";
let hub: any = null;
let BASE = "";
let NET = "";
let bossToken = "", umaToken = "", umaId = "", umaName = "";
type Node = { alias: string; nodeId: string; token: string };
const nodes: Record<"sender" | "target" | "other", Node> = {} as any;

async function send(token: string, method: string, path: string, payload?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json().catch(() => null) as any };
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

type Sub = { events: any[]; close: () => void };
async function subscribe(path: string, token: string): Promise<Sub> {
  const ctrl = new AbortController();
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal });
  expect(res.status).toBe(200);
  const events: any[] = [];
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value);
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          for (const line of frame.split("\n")) if (line.startsWith("data: ")) { try { events.push(JSON.parse(line.slice(6))); } catch {} }
        }
      }
    } catch {}
  })();
  await until(() => events.some((e) => e.type === "connected"));
  return { events, close: () => ctrl.abort() };
}
const until = async (cond: () => boolean, tries = 150) => { for (let k = 0; k < tries && !cond(); k++) await new Promise((r) => setTimeout(r, 20)); };

let seq = 0;
/** 经 POST /api/task 派一条;返回 task_id。 */
async function dispatch(token: string, to: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await send(token, "POST", "/api/task", { alias: to, task: `expiry case ${stamp} #${++seq}`, network_id: NET, ...extra });
  expect(r.status).toBe(200);
  expect(r.body.ok).toBe(true);
  return r.body.task_id;
}
/** 把这条任务拨成「61 分钟前派出、1 分钟前到期」。 */
const backdate = (taskId: string) => db.run(
  "UPDATE tasks SET created_at = datetime('now', '-61 minutes'), delivered_at = datetime('now', '-61 minutes'), expires_at = datetime('now', '-1 minutes') WHERE task_id = ?1",
  [taskId],
);
const taskRow = (taskId: string) => db.get("SELECT status, result FROM tasks WHERE task_id = ?1", taskId) as { status: string; result: string | null };
const agentNotices = (alias: string) => db.all(
  "SELECT id, type, content, from_session, in_reply_to, requires_response, meta_json, acked FROM inbox WHERE session_name = ?1 AND network_id = ?2 AND from_session = 'hub' AND id LIKE 'exp_%' ORDER BY created_at, id",
  alias, NET,
) as Array<{ id: string; type: string; content: string; from_session: string; in_reply_to: string; requires_response: string; meta_json: string; acked: number }>;
const userNotices = (userId: string) => db.all(
  "SELECT message_id, from_session, title, content, meta_json FROM user_inbox WHERE user_id = ?1 AND network_id = ?2 AND kind = ?3 ORDER BY created_at, message_id",
  userId, NET, KIND,
) as Array<{ message_id: string; from_session: string; title: string; content: string; meta_json: string }>;

beforeAll(async () => {
  ({ db } = await import("./db.js"));
  const { addNetworkMember, createNetworkTokenForNode, register } = await import("./auth.js");
  ({ TASK_EXPIRED_NOTICE_KIND: KIND } = await import("./task-expiry-notice.js"));
  const boss = register(`exp_boss_${stamp}`, PW);
  expect(boss.ok).toBe(true);
  bossToken = boss.token!; NET = boss.network_id!;
  const bossId = boss.user!.user_id;
  const uma = register(`exp_uma_${stamp}`, PW);
  umaToken = uma.token!; umaId = uma.user!.user_id; umaName = uma.user!.username;
  expect(addNetworkMember(NET, umaId, "member", bossId, { agentAccess: "all" }).ok).toBe(true);
  for (const key of ["sender", "target", "other"] as const) {
    const alias = `exp-${key}-${stamp}`;
    const nodeId = `n_exp_${key}_${stamp}`;
    const minted = createNetworkTokenForNode(bossId, NET, alias, nodeId);
    expect(minted.ok).toBe(true);
    nodes[key] = { alias, nodeId, token: minted.token! };
  }
  const mod: any = await import("./server.js");
  patrol = mod.patrolExpiredTasks;
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
  for (const n of Object.values(nodes)) {
    const r = await tool(n.token, "report_status", { resume_id: `sdk-${n.nodeId}`, alias: n.alias, status: "idle", node_id: n.nodeId, network_id: NET });
    expect(r.ok).toBe(true);
  }
}, 30_000);

beforeEach(() => {
  // 每条用例自己的数据:上一条留下的开着的任务不许算进「前面还有几个」,也不许被这一次巡检过期。
  db.run("UPDATE tasks SET status = 'replied', completed_at = datetime('now') WHERE network_id = ?1 AND status IN ('created', 'delivered', 'acked', 'running')", [NET]);
  db.run("DELETE FROM inbox WHERE network_id = ?1 AND id LIKE 'exp_%'", [NET]);
  db.run("DELETE FROM user_inbox WHERE network_id = ?1 AND kind = ?2", [NET, KIND]);
});

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("#500 consumed before the deadline → not expired", () => {
  test("consumed_at < expires_at keeps the task; a late consumed_at (after the deadline) does not", async () => {
    const taken = await dispatch(nodes.sender.token, nodes.target.alias);
    const late = await dispatch(nodes.sender.token, nodes.target.alias);
    backdate(taken); backdate(late);
    db.run("UPDATE tasks SET consumed_at = datetime('now', '-30 minutes') WHERE task_id = ?1", [taken]);
    db.run("UPDATE tasks SET consumed_at = datetime('now') WHERE task_id = ?1", [late]);
    patrol();
    expect(taskRow(taken).status).toBe("delivered");
    expect(taskRow(late).status).toBe("expired");
    // 通知只说过期的那一条。
    const n = agentNotices(nodes.sender.alias);
    expect(n.length).toBe(1);
    expect(n[0].content).toContain(late);
    expect(n[0].content).not.toContain(taken);
  });
});

describe("#500 sender is an agent node", () => {
  test("exactly one terminal reply-row notice + new_reply push; get_inbox returns it", async () => {
    const sub = await subscribe(`/events/${encodeURIComponent(nodes.sender.alias)}?network_id=${NET}`, nodes.sender.token);
    try {
      // 目标上有一条比它早、还开着的任务(别人派的,没到期)→ 「前面还有 1 个」。
      const ahead = await dispatch(bossToken, nodes.target.alias);
      db.run("UPDATE tasks SET created_at = datetime('now', '-90 minutes') WHERE task_id = ?1", [ahead]);
      const id = await dispatch(nodes.sender.token, nodes.target.alias);
      backdate(id);
      patrol();
      expect(taskRow(id).status).toBe("expired");
      expect(taskRow(ahead).status).toBe("delivered");

      const n = agentNotices(nodes.sender.alias);
      expect(n.length).toBe(1);
      expect(n[0].type).toBe("reply");
      expect(n[0].from_session).toBe("hub");
      expect(n[0].requires_response).toBe("none");
      expect(n[0].in_reply_to).toBe(id);
      for (const frag of ["[Hub] 任务已过期", nodes.target.alias, id, "等了 61 分钟", "期限 60 分钟", "还有 1 个", "retry_task", "不要原样重发", "do not blindly resend"]) {
        expect(n[0].content).toContain(frag);
      }
      expect(JSON.parse(n[0].meta_json).task_expired).toEqual({ target: nodes.target.alias, task_ids: [id], queued_ahead: 1 });

      await until(() => sub.events.some((e) => e.type === "new_reply" && e.message_id === n[0].id));
      const push = sub.events.find((e) => e.type === "new_reply" && e.message_id === n[0].id);
      expect(push).toMatchObject({ from: "hub", in_reply_to: id, status: "expired" });

      const inbox = await tool(nodes.sender.token, "get_inbox", { alias: nodes.sender.alias, limit: 50 });
      const got = JSON.stringify(inbox);
      expect(got).toContain(n[0].id);
      // 目标节点自己什么都没多收(过期的任务行已 acked,通知只给发送方)。
      expect(agentNotices(nodes.target.alias).length).toBe(0);

      // 再巡检一次:不重复发。
      patrol();
      expect(agentNotices(nodes.sender.alias).length).toBe(1);
    } finally { sub.close(); }
  });
});

describe("#500 sender is a person (Dashboard / App)", () => {
  test("user_inbox task_expired from the target node + desktop_message push; no agent inbox row", async () => {
    const sub = await subscribe(`/events/users/me?network_id=${NET}`, umaToken);
    try {
      const id = await dispatch(umaToken, nodes.target.alias);
      backdate(id);
      patrol();
      expect(taskRow(id).status).toBe("expired");
      const n = userNotices(umaId);
      expect(n.length).toBe(1);
      expect(n[0].from_session).toBe(nodes.target.alias);
      expect(n[0].title).toBe("任务已过期");
      for (const frag of [nodes.target.alias, id, "等了 61 分钟", "retry_task", "不要原样重发"]) expect(n[0].content).toContain(frag);
      await until(() => sub.events.some((e) => e.type === "desktop_message" && e.message_id === n[0].message_id));
      expect(sub.events.find((e) => e.type === "desktop_message" && e.message_id === n[0].message_id)).toMatchObject({ kind: KIND, from: nodes.target.alias });
      // 没有往「用户名」那个 alias 的 agent inbox 里塞东西。
      expect(agentNotices(umaName).length).toBe(0);
    } finally { sub.close(); }
  });
});

describe("#500 sender is the scheduler", () => {
  test("no notice to anyone; the task still expires", async () => {
    const id = `sched_task_${stamp}`;
    db.run(
      `INSERT INTO tasks (task_id, from_name, to_name, to_node_id, priority, status, content, requires_response, created_at, delivered_at, expires_at, network_id, meta_json)
       VALUES (?1, 'scheduler', ?2, ?3, 'normal', 'delivered', 'scheduled', 'reply', datetime('now', '-61 minutes'), datetime('now', '-61 minutes'), datetime('now', '-1 minutes'), ?4, ?5)`,
      [id, nodes.target.alias, nodes.target.nodeId, NET, JSON.stringify({ auth_origin: "hub_scheduler" })],
    );
    patrol();
    expect(taskRow(id).status).toBe("expired");
    const anyAgent = db.get("SELECT COUNT(*) AS n FROM inbox WHERE network_id = ?1 AND id LIKE 'exp_%'", NET) as { n: number };
    expect(Number(anyAgent.n)).toBe(0);
    const anyUser = db.get("SELECT COUNT(*) AS n FROM user_inbox WHERE network_id = ?1 AND kind = ?2", NET, KIND) as { n: number };
    expect(Number(anyUser.n)).toBe(0);
  });
});

describe("#500 child task expires", () => {
  test("parent sender is told; parent stays open with its result untouched", async () => {
    const parent = await dispatch(umaToken, nodes.sender.alias);
    const child = await dispatch(nodes.sender.token, nodes.target.alias, { parent_task_id: parent });
    backdate(child);
    patrol();
    expect(taskRow(child).status).toBe("expired");
    expect(taskRow(parent)).toEqual({ status: "delivered", result: null });
    // 子任务的发送方(父任务的执行者)照常收到过期通知。
    expect(agentNotices(nodes.sender.alias).length).toBe(1);
    // 父任务的发送方(人)收到一条「子任务已过期」,出现在与父任务执行者的会话里。
    const n = userNotices(umaId);
    expect(n.length).toBe(1);
    expect(n[0].title).toBe("子任务已过期");
    expect(n[0].from_session).toBe(nodes.sender.alias);
    for (const frag of [parent, child, nodes.target.alias, "父任务没有被结束"]) expect(n[0].content).toContain(frag);
  });
});

describe("#500 one notice per (sender, target) per patrol pass", () => {
  test("5 expiring to the same target → one summarized notice listing all 5", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await dispatch(nodes.sender.token, nodes.target.alias));
    // 再来一条派给另一个目标:那是另一组,单独一条。
    const elsewhere = await dispatch(nodes.sender.token, nodes.other.alias);
    for (const id of [...ids, elsewhere]) backdate(id);
    patrol();
    for (const id of ids) expect(taskRow(id).status).toBe("expired");
    const n = agentNotices(nodes.sender.alias);
    expect(n.length).toBe(2);
    const batch = n.find((x) => x.content.includes(nodes.target.alias))!;
    expect(batch.content).toContain("[Hub] 5 个任务已过期");
    for (const id of ids) expect(batch.content).toContain(id);
    expect(batch.content).not.toContain(elsewhere);
    expect(JSON.parse(batch.meta_json).task_expired.task_ids.sort()).toEqual([...ids].sort());
    const single = n.find((x) => x.content.includes(nodes.other.alias))!;
    expect(single.content).toContain(elsewhere);
  });
});
