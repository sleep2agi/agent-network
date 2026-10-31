// 任务动态(#429)—— HTTP 集成测试(真实 Bun.serve,临时库;PG 梯子上用 COMMHUB_TEST_PG_URL 原样再跑一遍)。
//   写路径    —— 新建 / PATCH 的每个字段 / 勾子任务 / 标签改名 / 删项目 / 删卡,各记字段级流水:谁、旧值 → 新值
//   同一事务  —— 流水写不进去,那次改动也不生效
//   可见范围  —— 与列表相同:scoped 成员只看到看得见的卡(删掉的按墓碑);Agent 受限成员看不见的节点被隐去
//   翻页      —— limit / next_cursor / since / requirement_id;参数不合法 400;capability `events`
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "anet-requirement-events-"));
process.env.COMMHUB_DB ||= join(DIR, "hub.db");
process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");

const PW = "EventsPassw0rd!x";
let BASE = "";
let hub: any = null;
let NET = "";
let admin = { token: "", id: "" };
let member = { token: "", id: "" };
let scoped = { token: "", id: "" };
let restricted = { token: "", id: "" };
let nodeToken = "";
let NODE = "";

type R = { status: number; body: any };
async function send(token: string, method: string, path: string, payload?: unknown): Promise<R> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, body };
}
const create = async (t: string, card: Record<string, unknown>) => {
  const r = await send(t, "POST", "/api/requirements", { network_id: NET, ...card });
  expect(r.status).toBe(201);
  return r.body.requirement as { id: string; seq: number };
};
const patch = (t: string, id: string, p: Record<string, unknown>) => send(t, "PATCH", `/api/requirements/${id}?network_id=${NET}`, p);
const events = (t: string, qs = "") => send(t, "GET", `/api/requirements/events?network_id=${NET}${qs}`);
const of = (list: any[], id: string) => list.filter(e => e.requirement_id === id);
const user = (id: string) => ({ kind: "user", id });

beforeAll(async () => {
  process.env.HOST = "127.0.0.1";
  const { register, createNetworkTokenForNode } = await import("./auth.js");
  const { db } = await import("./db.js");
  const a = register(`ev_admin_${Date.now()}`, PW, undefined, "Admin");
  expect(a.ok).toBe(true);
  admin = { token: a.token!, id: a.user!.user_id };
  NET = a.network_id!;
  db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [admin.id]);
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
  const mk = async (username: string) => {
    const r = await send(admin.token, "POST", "/api/admin/users", { username, password: PW, network_id: NET, role: "member" });
    expect(r.status).toBe(200);
    const login = await send("", "POST", "/api/auth/login", { username, password: PW });
    expect(login.status).toBe(200);
    return { token: login.body.token as string, id: login.body.user.user_id as string };
  };
  const stamp = Date.now();
  member = await mk(`ev_member_${stamp}`);
  scoped = await mk(`ev_scoped_${stamp}`);
  restricted = await mk(`ev_restricted_${stamp}`);
  db.run("UPDATE network_members SET task_access = 'all', agent_access = 'all' WHERE network_id = ?1 AND user_id = ?2", [NET, member.id]);
  db.run("UPDATE network_members SET task_access = 'scoped' WHERE network_id = ?1 AND user_id = ?2", [NET, scoped.id]);
  // 看全部任务,但一个 Agent 都没授权:所有节点对他隐去
  db.run("UPDATE network_members SET task_access = 'all', agent_access = 'granted' WHERE network_id = ?1 AND user_id = ?2", [NET, restricted.id]);
  NODE = `n_ev_${stamp}`;
  const ntok = createNetworkTokenForNode(admin.id, NET, "ev-node");
  expect(ntok.ok).toBe(true);
  nodeToken = ntok.token!;
  // Real legacy-client order: mint by name, then register; never fill owner.
  const registration = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${nodeToken}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "report_status", arguments: {
      resume_id: `ev-session-${stamp}`, alias: "ev-node", status: "idle", node_id: NODE,
    } } }),
  });
  expect(registration.status).toBe(200);
  await registration.text();
  expect(db.get<{owner_user_id: string | null}>("SELECT owner_user_id FROM nodes WHERE node_id=?1", NODE)?.owner_user_id).toBeNull();
  expect(db.get<{bound_node_id: string | null}>("SELECT bound_node_id FROM api_tokens WHERE token_id=?1", ntok.token_id!)?.bound_node_id).toBe(NODE);
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("requirement events", () => {
  test("capability `events` is advertised", async () => {
    const r = await send(admin.token, "GET", `/api/requirements?network_id=${NET}`);
    expect(r.body.capabilities).toContain("events");
  });

  test("create records one `created` event with the actor, title and seq", async () => {
    const card = await create(member.token, { name: "动态示例一" });
    const r = await events(admin.token, `&requirement_id=${card.id}`);
    expect(r.status).toBe(200);
    expect(r.body.events.length).toBe(1);
    const [e] = r.body.events;
    expect(e).toMatchObject({ kind: "created", field: null, actor: user(member.id), title: "动态示例一", seq: card.seq, new: { title: "动态示例一", column: "pool" } });
    expect(typeof e.id).toBe("string");
    expect(Date.parse(e.at)).toBeGreaterThan(0);
  });

  test("a PATCH records one event per changed field, old → new; unchanged fields and no-op PATCHes record nothing", async () => {
    const card = await create(admin.token, { name: "动态示例二", priority: "normal", tags: ["UI"] });
    const r1 = await patch(member.token, card.id, {
      column: "doing", priority: "high", due: "2026-10-03", name: "动态示例二(改)", tags: ["UI", "后端"],
      agent_owner: { kind: "node", id: NODE }, participants: [user(admin.id)], assignee: "",
    });
    expect(r1.status).toBe(200);
    const list = of((await events(admin.token)).body.events, card.id);
    const byField = Object.fromEntries(list.filter((e: any) => e.kind === "changed").map((e: any) => [e.field, e]));
    expect(Object.keys(byField).sort()).toEqual(["agent_owner", "column", "due", "participants", "priority", "tags", "title"]);
    expect(byField.column).toMatchObject({ old: "pool", new: "doing", actor: user(member.id) });
    expect(byField.priority).toMatchObject({ old: "normal", new: "high" });
    expect(byField.due).toMatchObject({ old: null, new: "2026-10-03" });
    expect(byField.title).toMatchObject({ old: "动态示例二", new: "动态示例二(改)" });
    expect(byField.tags).toMatchObject({ old: ["UI"], new: ["UI", "后端"] });
    expect(byField.agent_owner).toMatchObject({ old: null, new: { kind: "node", id: NODE } });
    expect(byField.participants).toMatchObject({ old: [], new: [user(admin.id)] });
    // every event of that PATCH carries the card's title after the change
    expect(new Set(list.filter((e: any) => e.kind === "changed").map((e: any) => e.title))).toEqual(new Set(["动态示例二(改)"]));
    const before = list.length;
    expect((await patch(member.token, card.id, { priority: "high", column: "doing" })).status).toBe(200);
    expect(of((await events(admin.token)).body.events, card.id).length).toBe(before);
    // archive / unarchive, description (length only, never the text), move to done
    await patch(member.token, card.id, { description: "一段描述" });
    await patch(member.token, card.id, { column: "done" });
    await patch(member.token, card.id, { archived: true });
    const later = of((await events(admin.token)).body.events, card.id).slice(0, 3);
    expect(later.map((e: any) => e.field)).toEqual(["archived", "column", "description"]);
    expect(later[0]).toMatchObject({ old: false, new: true });
    expect(later[1]).toMatchObject({ old: "doing", new: "done" });
    expect(later[2]).toMatchObject({ old: { chars: 0 }, new: { chars: 4 } });
    expect(JSON.stringify(later[2])).not.toContain("一段描述");
  });

  // 2026-10-31 —— **变化字段集合 == 实际被写库的字段集合**（外部复核那条的对账形态）。
  // 上一节断言的是「事件字段集合」；这里把它与「读回来的行真的变了哪些字段」逐项比对 ——
  // 只有两边相等，才能说「流水没有漏记，也没有凭空多记」。
  test("changed-field set equals the set of columns that actually changed in the stored row", async () => {
    const card = await create(admin.token, { name: "对账示例", priority: "normal" });
    const read = async () => (await send(admin.token, "GET", `/api/requirements/${card.id}?network_id=${NET}`)).body.requirement;
    const before = await read();
    // 2026-10-31 —— **同一个 PATCH 里混一个「赋相同值」的字段**（外部复核 (a) 的原话：
    // 「同一次 update 里加一个赋相同值的字段，断言它不在 changes 里」）。
    // 这是「变化集 vs 赋值集」两种实现唯一分叉的输入形态：
    //   只测「整单都是空操作」时，两种实现都绿；混一个不变字段，只有按值比较的那种才绿。
    const r = await patch(member.token, card.id, { column: "doing", priority: "high", due: "2026-10-09", assignee: "" });
    expect(r.status).toBe(200);
    const after = await read();
    // 只看这次 PATCH 涉及的四个字段（三个改了、一个赋的是原值）：读回来的行里**真的不同**的那些
    const keys = ["column", "priority", "due", "assignee"] as const;
    const actuallyChanged = keys.filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)).sort();
    const eventFields = of((await events(admin.token)).body.events, card.id)
      .filter((e: any) => e.kind === "changed")
      .map((e: any) => e.field).sort();
    expect(eventFields).toEqual(actuallyChanged);
    expect(actuallyChanged).toEqual(["column", "due", "priority"]);
    // 赋相同值的那个字段：既不在实际变化里，也不在流水里（否则「赋值集」实现会多记一条）
    expect(actuallyChanged).not.toContain("assignee");
    expect(eventFields).not.toContain("assignee");
  });

  test("checklist: ticking an item is `checklist_item` (repeat is a no-op); adding items is `checklist`", async () => {
    const card = await create(admin.token, { name: "动态示例三", checklist: [{ id: "a", text: "第一项" }, { id: "b", text: "第二项" }] });
    const tick = (done: boolean) => send(member.token, "PATCH", `/api/requirements/${card.id}/checklist/a?network_id=${NET}`, { done });
    expect((await tick(true)).status).toBe(200);
    expect((await tick(true)).status).toBe(200);
    let list = of((await events(admin.token)).body.events, card.id);
    const ticks = list.filter((e: any) => e.field === "checklist_item");
    expect(ticks.length).toBe(1);
    expect(ticks[0]).toMatchObject({ old: { id: "a", text: "第一项", done: false }, new: { id: "a", text: "第一项", done: true }, actor: user(member.id) });
    // a PATCH that only flips one item's done is also `checklist_item`
    await patch(member.token, card.id, { checklist: [{ id: "a", text: "第一项", done: true }, { id: "b", text: "第二项", done: true }] });
    await patch(member.token, card.id, { checklist: [{ id: "a", text: "第一项", done: true }, { id: "b", text: "第二项", done: true }, { id: "c", text: "第三项" }] });
    list = of((await events(admin.token)).body.events, card.id);
    expect(list[0]).toMatchObject({ field: "checklist", old: { total: 2, done: 2 }, new: { total: 3, done: 2 } });
    expect(list[1]).toMatchObject({ field: "checklist_item", new: { id: "b", done: true } });
  });

  test("the actor of a node token is the node", async () => {
    const card = await create(admin.token, { name: "动态示例四" });
    expect((await patch(nodeToken, card.id, { column: "doing" })).status).toBe(200);
    const [e] = of((await events(nodeToken)).body.events, card.id);
    expect(e).toMatchObject({ field: "column", actor: { kind: "node", id: NODE } });
  });

  test("tag rename, project delete and card delete each record per-card events", async () => {
    const p = await send(admin.token, "POST", `/api/requirements/projects?network_id=${NET}`, { name: `动态项目-${Date.now()}` });
    expect(p.status).toBe(201);
    const card = await create(admin.token, { name: "动态示例五", tags: ["旧标签"], project_id: p.body.project.id });
    expect((await send(admin.token, "POST", `/api/requirements/tags/ops?network_id=${NET}`, { op: "rename", from: "旧标签", to: "新标签" })).status).toBe(200);
    expect((await send(admin.token, "DELETE", `/api/requirements/projects/${p.body.project.id}?network_id=${NET}`)).status).toBe(200);
    expect((await send(admin.token, "DELETE", `/api/requirements/${card.id}?network_id=${NET}`)).status).toBe(200);
    const list = of((await events(admin.token)).body.events, card.id);
    expect(list.slice(0, 3).map((e: any) => [e.kind, e.field])).toEqual([["deleted", null], ["changed", "project"], ["changed", "tags"]]);
    expect(list[0]).toMatchObject({ title: "动态示例五", seq: expect.any(Number), actor: user(admin.id) });
    expect(list[1]).toMatchObject({ old: p.body.project.id, new: null });
    expect(list[2]).toMatchObject({ old: ["旧标签"], new: ["新标签"] });
  });

  test("the write and its events are one transaction: no events table → the PATCH fails and the card is unchanged", async () => {
    const { db } = await import("./db.js");
    const card = await create(admin.token, { name: "动态示例六", priority: "low" });
    db.exec("ALTER TABLE requirement_events RENAME TO requirement_events_away");
    try {
      const r = await patch(admin.token, card.id, { priority: "high" });
      expect(r.status).toBeGreaterThanOrEqual(500);
    } finally {
      db.exec("ALTER TABLE requirement_events_away RENAME TO requirement_events");
    }
    const now = await send(admin.token, "GET", `/api/requirements/${card.id}?network_id=${NET}`);
    expect(now.body.requirement.priority).toBe("low");
  });

  test("a scoped member sees events only for cards they can see — deleted ones by their tombstone", async () => {
    const mine = await create(scoped.token, { name: "动态示例七(scoped 自己建的)" });
    const theirs = await create(admin.token, { name: "动态示例八(scoped 看不见)" });
    const joined = await create(admin.token, { name: "动态示例九(scoped 是参与人)", participants: [user(scoped.id)] });
    await patch(admin.token, mine.id, { priority: "high" });
    await patch(admin.token, theirs.id, { priority: "high" });
    await send(admin.token, "DELETE", `/api/requirements/${joined.id}?network_id=${NET}`);
    const seen = (await events(scoped.token, "&limit=500")).body.events;
    expect(of(seen, mine.id).length).toBe(2);
    expect(of(seen, theirs.id).length).toBe(0);
    expect(of(seen, joined.id).map((e: any) => e.kind)).toEqual(["deleted", "created"]);
    // a filter on a card they cannot see answers like a card with no events
    expect((await events(scoped.token, `&requirement_id=${theirs.id}`)).body.events).toEqual([]);
  });

  test("the CARD payload hides a hidden node's alias too (assignee is a string, not a ref)", async () => {
    // 2026-10-31 —— #3285 的另一半，比事件列表**常用得多**的那一面。
    // assignee 是派生展示字段（自由文本），写侧在设 agent_owner 时回填别名；
    // 它没有 {kind,id} 形状 ⇒ isHiddenRef 判不了 ⇒ 只抹引用的话，卡列表上照样看得到别名。
    const card = await create(admin.token, { name: "动态示例十之半" });
    await patch(admin.token, card.id, { agent_owner: { kind: "node", id: NODE } });
    const mine = (await send(admin.token, "GET", `/api/requirements?network_id=${NET}&limit=500`)).body.requirements
      .find((c: any) => c.id === card.id);
    expect(mine.assignee).toBe("ev-node");            // 无限制的读者：看得到（这是如实回显）
    const theirs = (await send(restricted.token, "GET", `/api/requirements?network_id=${NET}&limit=500`)).body.requirements
      .find((c: any) => c.id === card.id);
    expect(theirs).toBeDefined();                      // 卡本身他看得见（不是「看不见的卡」那条规则）
    expect(theirs.assignee).toBeNull();                // 但执行人那一栏不能借别名漏出去
    expect(JSON.stringify(theirs)).not.toContain("ev-node");
  });

  test("an agent-restricted member: hidden nodes are masked, and an event that only differs by a hidden node is dropped", async () => {
    const card = await create(admin.token, { name: "动态示例十" });
    await patch(nodeToken, card.id, { priority: "high" });
    await patch(admin.token, card.id, { agent_owner: { kind: "node", id: NODE } });
    await patch(admin.token, card.id, { participants: [user(admin.id), { kind: "node", id: NODE }] });
    const seen = of((await events(restricted.token)).body.events, card.id);
    const all = of((await events(admin.token)).body.events, card.id);
    // 2026-10-31 —— 加了 `assignee` 这一条：它是**派生展示字段**（写侧在设 agent_owner 时
    // 同步回填），存的是**别名字符串**而不是 {kind,id} 引用。列表顺序按事件 id 倒序 ⇒
    // 它排在 agent_owner 之后、priority 之前。
    expect(all.map((e: any) => e.field)).toEqual(["participants", "agent_owner", "assignee", "priority", null]);
    expect(all[2]).toMatchObject({ field: "assignee", old: null, new: "ev-node" });
    // 受限成员那边：agent_owner 与**由它派生的 assignee** 都必须消失（后者是别名字符串，
    // 不走 isHiddenRef，2026-10-31 实测会漏；见 requirements.ts 的 hiddenAlias）。
    expect(seen.map((e: any) => e.field)).toEqual(["participants", "priority", null]);
    expect(seen[0]).toMatchObject({ old: [], new: [user(admin.id)] });
    expect(seen[1]).toMatchObject({ field: "priority", actor: null });
    expect(JSON.stringify(seen)).not.toContain(NODE);
    expect(JSON.stringify(seen)).not.toContain("ev-node");   // ← 别名也不能漏
  });

  test("paging: newest first, limit + next_cursor without overlap; since; bad params 400", async () => {
    const card = await create(admin.token, { name: "动态示例十一" });
    for (const priority of ["high", "low", "lowest", "normal"]) await patch(admin.token, card.id, { priority });
    const q = `&requirement_id=${card.id}`;
    const p1 = await events(admin.token, `${q}&limit=2`);
    expect(p1.body.events.length).toBe(2);
    expect(p1.body.has_more).toBe(true);
    expect(p1.body.events[0].new).toBe("normal");
    const p2 = await events(admin.token, `${q}&limit=2&cursor=${p1.body.next_cursor}`);
    const p3 = await events(admin.token, `${q}&limit=2&cursor=${p2.body.next_cursor}`);
    const ids = [...p1.body.events, ...p2.body.events, ...p3.body.events].map((e: any) => e.id);
    expect(new Set(ids).size).toBe(5);
    expect(p3.body.has_more).toBe(false);
    expect(p3.body.next_cursor).toBe(null);
    expect(ids.map(Number)).toEqual([...ids.map(Number)].sort((a, b) => b - a));
    // since = server_time of an earlier read → only what came after
    const t = p1.body.server_time;
    await patch(admin.token, card.id, { priority: "high" });
    const after = await events(admin.token, `${q}&since=${encodeURIComponent(t)}`);
    // since is inclusive (>=): an event written in the same millisecond as server_time comes back again,
    // and clients dedupe by id. Only the events not already seen must be exactly the new one.
    expect(after.body.events.every((e: any) => Date.parse(e.at) >= Date.parse(t))).toBe(true);
    const seen = new Set(ids);
    expect(after.body.events.filter((e: any) => !seen.has(e.id)).map((e: any) => e.new)).toEqual(["high"]);
    for (const bad of ["&limit=0", "&limit=501", "&limit=x", "&since=nope", "&cursor=abc", "&cursor=0"]) {
      expect((await events(admin.token, bad)).status).toBe(400);
    }
  });

  test("migration is idempotent and leaves the rows alone", async () => {
    const { db } = await import("./db.js");
    const { ensureRequirementEvents } = await import("./requirement-events.js");
    const n = Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM requirement_events")!.n);
    ensureRequirementEvents(db);
    ensureRequirementEvents(db);
    expect(Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM requirement_events")!.n)).toBe(n);
    expect(n).toBeGreaterThan(0);
  });
});
