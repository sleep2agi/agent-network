// RFC-042(看板 #457)部门群,第三个 PR:群消息、未读、实时推送。
// HTTP 集成测试(真实 Bun.serve,私有端口,临时库;PostgreSQL 由 test2123 梯子用 COMMHUB_TEST_PG_URL 跑同一个文件)。
// 钉住:只有当前群成员能发 / 读 / 标已读(管理者不是成员也 404,Agent 403 humans_only);按 client_request_id 去重;
// 翻页游标;未读 = 别人发的、入群后的、超过已读位置的;已读只前进;推 group_message 给发送那一刻的每个成员、不给非成员;
// 被同步移出的人立刻读不到历史、收不到推送、打不开群里的附件;群附件对群成员可见、不能借群解锁别人的私信文件。

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register, createNetworkTokenForNode } from "./auth.js";
import { db } from "./db.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-group-msgs-"));
let BASE = "";
let hub: any = null;
const PW = "GroupMsgsPassw0rd!x";
let NET = "";
const U: Record<string, { token: string; id: string; username: string }> = {};
const DEPT: Record<string, string> = {};
const GRP: Record<string, string> = {};

async function send(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json };
}
const CG = (suffix = "") => `/api/networks/${NET}/chat-groups${suffix}`;
const msgs = (g: string) => CG(`/${GRP[g]}/messages`);
const post = (who: string, g: string, body: Record<string, unknown>) => send(U[who].token, "POST", msgs(g), body);
const unread = async (who: string, g: string) => {
  const r = await send(U[who].token, "GET", CG());
  expect(r.status).toBe(200);
  return r.body.groups.find((x: any) => x.id === GRP[g])?.unread as number;
};
const place = async (who: string, dept: string | null) =>
  expect((await send(U.owner.token, "PUT", `/api/networks/${NET}/members/${U[who].id}/department`, { department_id: dept })).status).toBe(200);

async function upload(token: string, body: string, query = "") {
  const form = new FormData();
  form.append("file", new Blob([new TextEncoder().encode(body)], { type: "image/png" }), "shot.png");
  const res = await fetch(`${BASE}/api/upload?network_id=${NET}${query}`, { method: "POST", body: form, headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  return ((await res.json()) as any).file_id as string;
}
const fileStatus = async (token: string, fileId: string) => (await fetch(`${BASE}/api/files/${fileId}`, { headers: { Authorization: `Bearer ${token}` } })).status;
const att = (fileId: string) => [{ type: "file", file_id: fileId, name: "shot.png", mime: "image/png" }];

/** 订阅 /events/users/me,收集事件。 */
async function subscribe(who: string) {
  const ctrl = new AbortController();
  const res = await fetch(`${BASE}/events/users/me?network_id=${NET}`, { headers: { Authorization: `Bearer ${U[who].token}` }, signal: ctrl.signal });
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

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";
  const stamp = Date.now();
  const a = register(`gm_owner_${stamp}`, PW, undefined, "Owner");
  expect(a.ok).toBe(true);
  U.owner = { token: a.token!, id: a.user!.user_id, username: a.user!.username };
  NET = a.network_id!;
  db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [U.owner.id]);
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
  const add = async (username: string, role: string) => {
    expect((await send(U.owner.token, "POST", "/api/admin/users", { username, password: PW, network_id: NET, role })).status).toBe(200);
    const login = await send("", "POST", "/api/auth/login", { username, password: PW });
    expect(login.status).toBe(200);
    return { token: login.body.token as string, id: login.body.user.user_id as string, username };
  };
  U.head = await add(`gm_head_${stamp}`, "member");     // 研发部负责人 + 成员
  U.alice = await add(`gm_alice_${stamp}`, "member");   // 研发部
  U.bob = await add(`gm_bob_${stamp}`, "member");       // 后端组(研发部子部门)
  U.carol = await add(`gm_carol_${stamp}`, "member");   // 研发部,之后被调走(同步移出)
  U.dave = await add(`gm_dave_${stamp}`, "member");     // 市场部(不在研发部群)
  U.viewer = await add(`gm_viewer_${stamp}`, "viewer"); // 研发部,只读角色也能聊天
  U.node = { token: createNetworkTokenForNode(U.owner.id, NET, "gm-node", "node_gm").token!, id: "node_gm", username: "gm-node" };
  const o = register(`gm_outsider_${stamp}`, PW);
  U.outsider = { token: o.token!, id: o.user!.user_id, username: o.user!.username };

  const mk = async (name: string, extra: Record<string, unknown> = {}) => {
    const r = await send(U.owner.token, "POST", `/api/networks/${NET}/departments`, { name, ...extra });
    expect(r.status).toBe(201);
    return r.body.department.id as string;
  };
  DEPT.rd = await mk("研发部", { leader_user_id: U.head.id });
  DEPT.backend = await mk("后端组", { parent_id: DEPT.rd });
  DEPT.market = await mk("市场部");
  for (const w of ["head", "alice", "carol", "viewer"]) await place(w, DEPT.rd);
  await place("bob", DEPT.backend);
  await place("dave", DEPT.market);
  for (const key of ["rd", "backend", "market"]) {
    const r = await send(U.owner.token, "POST", `/api/networks/${NET}/departments/${DEPT[key]}/group`, {});
    expect(r.status).toBe(201);
    GRP[key] = r.body.group.id;
  }
  // 入群时间是秒级:等过这一秒,下面「入群后发的才算未读」的口径就不受同一秒的影响。
  await new Promise((r) => setTimeout(r, 1100));
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("send + history", () => {
  test("a member sends: 200, DM-shaped row with seq / kind / direction, one audit row", async () => {
    const r = await post("alice", "rd", { message: "大家好" });
    expect(r.status).toBe(200);
    expect(r.body.duplicate).toBe(false);
    expect(r.body.message).toMatchObject({ group_id: GRP.rd, network_id: NET, sender_user_id: U.alice.id, from_session: U.alice.username, content: "大家好", kind: "group_message", direction: "out", meta_json: null });
    expect(typeof r.body.message.seq).toBe("number");
    expect(r.body.message.created_at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}$/);
    const audits = db.all<{ target_id: string }>("SELECT target_id FROM audit_log WHERE action = 'chat_group_message_sent' AND user_id = ?1", U.alice.id);
    expect(audits.map((x) => x.target_id)).toEqual([GRP.rd]);
  });

  test("bob (sub-department member) and the viewer are in the group and can send", async () => {
    expect((await post("bob", "rd", { message: "后端在" })).status).toBe(200);
    expect((await post("viewer", "rd", { message: "只读角色也能聊天" })).status).toBe(200);
  });

  test("history: newest first, direction per reader, cursor pagination by seq", async () => {
    const all = await send(U.bob.token, "GET", msgs("rd"));
    expect(all.status).toBe(200);
    expect(all.body.messages.map((m: any) => m.content)).toEqual(["只读角色也能聊天", "后端在", "大家好"]);
    expect(all.body.messages.map((m: any) => m.direction)).toEqual(["in", "out", "in"]);
    expect(all.body.next_before).toBeNull();
    const p1 = await send(U.bob.token, "GET", `${msgs("rd")}?limit=2`);
    expect(p1.body.messages.map((m: any) => m.content)).toEqual(["只读角色也能聊天", "后端在"]);
    expect(p1.body.next_before).toBe(p1.body.messages[1].seq);
    const p2 = await send(U.bob.token, "GET", `${msgs("rd")}?limit=2&before=${p1.body.next_before}`);
    expect(p2.body.messages.map((m: any) => m.content)).toEqual(["大家好"]);
    expect(p2.body.next_before).toBeNull();
    expect((await send(U.bob.token, "GET", `${msgs("rd")}?before=abc`)).status).toBe(400);
  });

  test("validation mirrors DM: empty → 400 message_required, > 10000 chars → 400 message_too_long, bad attachments → 400", async () => {
    expect((await post("alice", "rd", { message: "   " })).body.error).toBe("message_required");
    expect((await post("alice", "rd", { message: "x".repeat(10_001) })).body.error).toBe("message_too_long");
    expect((await post("alice", "rd", { message: "x".repeat(10_000) })).status).toBe(200);
    const bad = await post("alice", "rd", { message: "a", attachments: [{ type: "file", file_id: "../etc" }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("bad_attachments");
  });
});

describe("dedup by client_request_id (not by content)", () => {
  test("a retried bubble returns the same message and stores one row; same text without an id stores two", async () => {
    const a = await post("alice", "rd", { message: "重试", client_request_id: "cr-1" });
    const b = await post("alice", "rd", { message: "重试", client_request_id: "cr-1" });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body.duplicate).toBe(true);
    expect(b.body.message.message_id).toBe(a.body.message.message_id);
    expect(b.body.message.seq).toBe(a.body.message.seq);
    expect(Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM chat_group_messages WHERE message_id = ?1", a.body.message.message_id)!.n)).toBe(1);
    const c = await post("alice", "rd", { message: "重试" });
    const d = await post("alice", "rd", { message: "重试" });
    expect(c.body.message.message_id).not.toBe(d.body.message.message_id);
  });
  test("the same client_request_id from another sender or in another group is a different message", async () => {
    const mine = await post("alice", "rd", { message: "x", client_request_id: "cr-2" });
    const his = await post("bob", "rd", { message: "x", client_request_id: "cr-2" });
    const other = await post("bob", "backend", { message: "x", client_request_id: "cr-2" });
    expect(new Set([mine.body.message.message_id, his.body.message.message_id, other.body.message.message_id]).size).toBe(3);
    expect(his.body.duplicate).toBe(false);
    expect(other.body.duplicate).toBe(false);
  });
});

describe("unread + read", () => {
  test("unread counts others' messages after my read cursor; own messages never count", async () => {
    // 先都读到最新,再从干净的 0 开始数。
    for (const w of ["alice", "bob", "head"]) expect((await send(U[w].token, "POST", CG(`/${GRP.rd}/read`), {})).body.unread).toBe(0);
    expect(await unread("bob", "rd")).toBe(0);
    for (const t of ["一", "二", "三"]) expect((await post("alice", "rd", { message: t })).status).toBe(200);
    expect(await unread("bob", "rd")).toBe(3);
    expect(await unread("head", "rd")).toBe(3);
    expect(await unread("alice", "rd")).toBe(0);
    // GET messages 也带上 unread(读历史不等于标已读)
    expect((await send(U.bob.token, "GET", msgs("rd"))).body.unread).toBe(3);
    // /api/dm/threads 只增字段 group_threads
    const th = await send(U.bob.token, "GET", `/api/dm/threads?network_id=${NET}`);
    expect(th.status).toBe(200);
    expect(Array.isArray(th.body.threads)).toBe(true);
    const rd = th.body.group_threads.find((g: any) => g.group_id === GRP.rd);
    expect(rd).toMatchObject({ unread: 3, name: "研发部", department_id: DEPT.rd });
    expect(th.body.group_threads.map((g: any) => g.group_id).sort()).toEqual([GRP.backend, GRP.rd].sort());
  });

  test("read up to a seq, never backwards, clamps past the latest; bad seq → 400", async () => {
    const page = await send(U.bob.token, "GET", msgs("rd"));
    const [newest, middle] = page.body.messages;
    const r1 = await send(U.bob.token, "POST", CG(`/${GRP.rd}/read`), { seq: middle.seq });
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ last_read_seq: middle.seq, unread: 1 });
    const back = await send(U.bob.token, "POST", CG(`/${GRP.rd}/read`), { seq: 1 });
    expect(back.body).toMatchObject({ last_read_seq: middle.seq, unread: 1 });
    const far = await send(U.bob.token, "POST", CG(`/${GRP.rd}/read`), { seq: newest.seq + 1000 });
    expect(far.body).toMatchObject({ last_read_seq: newest.seq, unread: 0 });
    expect((await send(U.bob.token, "POST", CG(`/${GRP.rd}/read`), { seq: -1 })).body.error).toBe("invalid_seq");
    expect((await send(U.bob.token, "POST", CG(`/${GRP.rd}/read`), { seq: "5" })).status).toBe(400);
    expect(await unread("bob", "rd")).toBe(0);
    expect(await unread("head", "rd")).toBe(3);
  });
});

describe("live push", () => {
  test("group_message goes to every current member (sender included, each with own unread), not to non-members", async () => {
    const subs = { head: await subscribe("head"), alice: await subscribe("alice"), dave: await subscribe("dave"), owner: await subscribe("owner") };
    const r = await post("alice", "rd", { message: "推送测试", client_request_id: "push-1" });
    expect(r.body.delivered_to).toBe(2); // head + alice 在线;dave / owner 不是成员
    await until(() => subs.head.events.some((e) => e.type === "group_message") && subs.alice.events.some((e) => e.type === "group_message"));
    await new Promise((res) => setTimeout(res, 150));
    const ev = subs.head.events.find((e) => e.type === "group_message");
    expect(ev).toMatchObject({ message_id: r.body.message.message_id, seq: r.body.message.seq, group_id: GRP.rd, group_name: "研发部", kind: "group_message", from: U.alice.username, from_user_id: U.alice.id, message: "推送测试", unread: 4, network_id: NET, user_id: U.head.id });
    expect(subs.alice.events.find((e) => e.type === "group_message")).toMatchObject({ message_id: r.body.message.message_id, unread: 0 });
    expect(subs.dave.events.some((e) => e.type === "group_message")).toBe(false);
    expect(subs.owner.events.some((e) => e.type === "group_message")).toBe(false);
    // 重投不推第二次
    expect((await post("alice", "rd", { message: "推送测试", client_request_id: "push-1" })).body.delivered_to).toBe(0);
    await new Promise((res) => setTimeout(res, 150));
    expect(subs.head.events.filter((e) => e.type === "group_message").length).toBe(1);
    // 标已读推 group_read 给自己(多端同步角标)
    await send(U.head.token, "POST", CG(`/${GRP.rd}/read`), {});
    await until(() => subs.head.events.some((e) => e.type === "group_read"));
    expect(subs.head.events.find((e) => e.type === "group_read")).toMatchObject({ group_id: GRP.rd, unread: 0, last_read_seq: r.body.message.seq });
    for (const s of Object.values(subs)) s.close();
  });
});

describe("who may use the message endpoints", () => {
  test("non-member (incl. a network owner/admin who is not in the group) → 404 on send / history / read", async () => {
    for (const w of ["dave", "owner"]) {
      expect((await post(w, "rd", { message: "x" })).body.error).toBe("group_not_found");
      expect((await send(U[w].token, "GET", msgs("rd"))).status).toBe(404);
      expect((await send(U[w].token, "POST", CG(`/${GRP.rd}/read`), {})).status).toBe(404);
    }
    // 管理者照样看得到群资料(第 1 个 PR 的口径不变),只是读不到消息。
    expect((await send(U.owner.token, "GET", CG(`/${GRP.rd}`))).status).toBe(200);
    expect((await post("alice", "rd", { message: "x" })).status).toBe(200);
    expect((await send(U.alice.token, "GET", CG("/grp_doesnotexist0000000/messages"))).status).toBe(404);
  });
  test("node token → 403 humans_only; outside the network → 403; no token → 401", async () => {
    const n = await post("node", "rd", { message: "x" });
    expect(n.status).toBe(403);
    expect(n.body.error).toBe("humans_only");
    expect((await send(U.node.token, "GET", msgs("rd"))).body.error).toBe("humans_only");
    expect((await send(U.node.token, "POST", CG(`/${GRP.rd}/read`), {})).status).toBe(403);
    expect((await post("outsider", "rd", { message: "x" })).status).toBe(403);
    expect((await send("", "GET", msgs("rd"))).status).toBe(401);
  });
  test("wrong method → 405; messages/<x> → 404", async () => {
    expect((await send(U.alice.token, "DELETE", msgs("rd"))).status).toBe(405);
    expect((await send(U.alice.token, "GET", CG(`/${GRP.rd}/read`))).status).toBe(405);
    expect((await send(U.alice.token, "GET", `${msgs("rd")}/abc`)).status).toBe(404);
  });
  test("chat-groups list carries unread / last_message_at only for groups I'm in", async () => {
    const r = await send(U.owner.token, "GET", CG());
    const rd = r.body.groups.find((g: any) => g.id === GRP.rd);
    expect(rd).toMatchObject({ is_member: false, unread: 0, last_message_at: null });
    const mine = (await send(U.alice.token, "GET", CG())).body.groups.find((g: any) => g.id === GRP.rd);
    expect(mine.is_member).toBe(true);
    expect(typeof mine.last_message_at).toBe("string");
  });
});

describe("attachments", () => {
  let fid = "";
  test("a DM-scoped upload sent to the group is readable by current members only", async () => {
    fid = await upload(U.alice.token, "group-image", "&purpose=dm");
    expect(await fileStatus(U.bob.token, fid)).toBe(404); // 还没发:只有上传者
    const r = await post("alice", "rd", { message: "看图", attachments: att(fid) });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body.message.meta_json).attachments[0].file_id).toBe(fid);
    for (const w of ["alice", "bob", "head", "carol", "viewer"]) expect(await fileStatus(U[w].token, fid)).toBe(200);
    expect(await fileStatus(U.dave.token, fid)).toBe(404);
    expect(await fileStatus(U.node.token, fid)).toBe(404);
    expect(await fileStatus(U.outsider.token, fid)).toBe(404);
  });
  test("a non-member can't unlock it by putting the id into their own group; a member who sees it may forward", async () => {
    const r = await post("dave", "market", { message: "偷", attachments: att(fid) });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("attachment_not_accessible");
    expect(await fileStatus(U.dave.token, fid)).toBe(404);
    expect((await post("bob", "backend", { message: "转发", attachments: att(fid) })).status).toBe(200);
  });
  test("restricted members (agent_access=granted): a plain upload in a group is readable by restricted members of that group only, and they may forward it", async () => {
    const { isAgentRestricted } = await import("./agent-access.js");
    db.run("UPDATE network_members SET agent_access = 'granted' WHERE network_id = ?1 AND user_id IN (?2, ?3)", [NET, U.head.id, U.dave.id]);
    expect(isAgentRestricted(U.head.id, NET)).toBe(true);
    expect(isAgentRestricted(U.dave.id, NET)).toBe(true);
    const plain = await upload(U.alice.token, "plain-network-file"); // 不带 purpose:网络文件
    expect(await fileStatus(U.head.token, plain)).toBe(404); // 受限成员原本读不到
    expect((await post("alice", "rd", { message: "网络文件", attachments: att(plain) })).status).toBe(200);
    expect(await fileStatus(U.head.token, plain)).toBe(200); // 进了他所在的群 → 能读
    expect(await fileStatus(U.dave.token, plain)).toBe(404); // 不在这个群的受限成员仍读不到
    expect((await post("dave", "market", { message: "x", attachments: att(plain) })).body.error).toBe("attachment_not_accessible");
    // head 在群里看得见它,可以转发(他是受限成员,走 restrictedMemberCanUseFile || groupMemberSeesFile)
    expect((await post("head", "rd", { message: "转一下", attachments: att(plain) })).status).toBe(200);
    db.run("UPDATE network_members SET agent_access = 'all' WHERE network_id = ?1 AND user_id IN (?2, ?3)", [NET, U.head.id, U.dave.id]);
  });
  test("someone else's DM file can't be pushed into a group by a member who never saw it", async () => {
    const secret = await upload(U.dave.token, "dave-secret", "&purpose=dm");
    const r = await post("alice", "rd", { message: "x", attachments: att(secret) });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("attachment_not_accessible");
  });
});

describe("removed by sync: no history, no push, no attachments", () => {
  test("carol is moved out of 研发部 → 404 on the group, file gone, no push", async () => {
    const before = await send(U.carol.token, "GET", msgs("rd"));
    expect(before.status).toBe(200);
    const fid = JSON.parse(before.body.messages.find((m: any) => m.meta_json)!.meta_json).attachments[0].file_id;
    expect(await fileStatus(U.carol.token, fid)).toBe(200);
    await place("carol", DEPT.market);
    expect((await send(U.carol.token, "GET", msgs("rd"))).status).toBe(404);
    expect((await post("carol", "rd", { message: "x" })).status).toBe(404);
    expect((await send(U.carol.token, "POST", CG(`/${GRP.rd}/read`), {})).status).toBe(404);
    expect(await fileStatus(U.carol.token, fid)).toBe(404);
    expect((await send(U.carol.token, "GET", CG())).body.groups.map((g: any) => g.id)).toEqual([GRP.market]);
    const sub = await subscribe("carol");
    const r = await post("alice", "rd", { message: "carol 走了" });
    expect(r.status).toBe(200);
    await new Promise((res) => setTimeout(res, 200));
    expect(sub.events.some((e) => e.type === "group_message")).toBe(false);
    // 进了市场部群:那边的消息照样推给她
    await post("dave", "market", { message: "欢迎" });
    await until(() => sub.events.some((e) => e.type === "group_message"));
    expect(sub.events.find((e) => e.type === "group_message")).toMatchObject({ group_id: GRP.market, from_user_id: U.dave.id });
    sub.close();
  });
  test("re-joining restores history; messages sent while away are not counted as unread", async () => {
    await new Promise((res) => setTimeout(res, 1100)); // 入群时间是秒级
    await place("carol", DEPT.rd);
    const r = await send(U.carol.token, "GET", msgs("rd"));
    expect(r.status).toBe(200);
    expect(r.body.messages.some((m: any) => m.content === "carol 走了")).toBe(true);
    expect(r.body.unread).toBe(0);
  });
});

describe("app API polish: last_message / member names / viewer_can / health capability", () => {
  // 状态:研发部群 = head(负责人)/ alice / bob / carol / viewer;owner 不是成员但能管(网络 owner + Hub 管理员)。
  const LONG = "第一行\n  第二行 " + "字".repeat(100);
  test("group_threads and chat-groups rows carry last_message: 80-char preview, attachments-only → empty text + count", async () => {
    db.run("UPDATE users SET display_name = ?2 WHERE user_id = ?1", [U.alice.id, "爱丽丝"]);
    const r1 = await post("alice", "rd", { message: LONG });
    expect(r1.status).toBe(200);
    const preview = ("第一行 第二行 " + "字".repeat(100)).slice(0, 80);
    const expected = { text: preview, attachment_count: 0, sender_user_id: U.alice.id, sender_name: "爱丽丝", at: r1.body.message.created_at };
    const th = await send(U.head.token, "GET", `/api/dm/threads?network_id=${NET}`);
    expect(th.status).toBe(200);
    const row = th.body.group_threads.find((g: any) => g.group_id === GRP.rd);
    expect(row.last_message).toEqual(expected);
    expect([...row.last_message.text].length).toBe(80);
    expect(row.last_at).toBe(expected.at);
    const list = await send(U.head.token, "GET", CG());
    expect(list.body.groups.find((g: any) => g.id === GRP.rd).last_message).toEqual(expected);

    const fid = await upload(U.bob.token, "png-bytes-preview");
    const r2 = await post("bob", "rd", { attachments: [...att(fid), ...att(fid)] });
    expect(r2.status).toBe(200);
    const th2 = await send(U.alice.token, "GET", `/api/dm/threads?network_id=${NET}`);
    // bob 没设 display_name → sender_name 回落到 username
    expect(th2.body.group_threads.find((g: any) => g.group_id === GRP.rd).last_message).toEqual({ text: "", attachment_count: 2, sender_user_id: U.bob.id, sender_name: U.bob.username, at: r2.body.message.created_at });
  });
  test("last_message is null for a group with no messages and for a group I can see but am not in", async () => {
    const d = await send(U.owner.token, "POST", `/api/networks/${NET}/departments`, { name: "空群部" });
    expect(d.status).toBe(201);
    await place("dave", d.body.department.id);
    const g = await send(U.owner.token, "POST", `/api/networks/${NET}/departments/${d.body.department.id}/group`, {});
    expect(g.status).toBe(201);
    GRP.empty = g.body.group.id;
    const mine = await send(U.dave.token, "GET", CG());
    expect(mine.body.groups.find((x: any) => x.id === GRP.empty).last_message).toBeNull();
    // owner 看得到研发部群(管理身份)但不是成员:不给预览
    const owner = await send(U.owner.token, "GET", CG());
    const rd = owner.body.groups.find((x: any) => x.id === GRP.rd);
    expect(rd.is_member).toBe(false);
    expect(rd.last_message).toBeNull();
    await place("dave", DEPT.market);
  });
  test("members carry username + display_name (empty when unset or equal to username)", async () => {
    db.run("UPDATE users SET display_name = ?2 WHERE user_id = ?1", [U.bob.id, U.bob.username]);
    const r = await send(U.alice.token, "GET", CG(`/${GRP.rd}`));
    expect(r.status).toBe(200);
    const by = (id: string) => r.body.members.find((m: any) => m.user_id === id);
    expect(by(U.alice.id)).toMatchObject({ username: U.alice.username, display_name: "爱丽丝", source: "department" });
    expect(by(U.bob.id)).toMatchObject({ username: U.bob.username, display_name: "" });       // 等于 username
    expect(by(U.carol.id)).toMatchObject({ username: U.carol.username, display_name: "" });   // 没设
    for (const m of r.body.members) expect(typeof m.username === "string" && m.username.length > 0).toBe(true);
    const d = await send(U.alice.token, "GET", `/api/networks/${NET}/departments/${DEPT.rd}/group`);
    expect(d.status).toBe(200);
    expect(d.body.members.find((m: any) => m.user_id === U.alice.id)).toMatchObject({ username: U.alice.username, display_name: "爱丽丝" });
    // 手动拉人的返回行也带名字
    const added = await send(U.head.token, "POST", CG(`/${GRP.rd}/members`), { user_id: U.dave.id });
    expect(added.status).toBe(201);
    expect(added.body.member).toMatchObject({ user_id: U.dave.id, username: U.dave.username, display_name: "", source: "manual" });
    expect((await send(U.head.token, "DELETE", CG(`/${GRP.rd}/members/${U.dave.id}`))).status).toBe(200);
  });
  test("viewer_can matches what the write endpoints actually allow", async () => {
    const can = async (who: string, gid: string) => (await send(U[who].token, "GET", CG(`/${gid}`))).body.group?.viewer_can;
    expect(await can("alice", GRP.rd)).toEqual({ manage: false, post: true });   // 普通成员
    expect(await can("head", GRP.rd)).toEqual({ manage: true, post: true });     // 部门负责人 + 成员
    expect(await can("head", GRP.backend)).toEqual({ manage: true, post: false }); // 上级负责人,不在子部门群
    expect(await can("owner", GRP.rd)).toEqual({ manage: true, post: false });   // 网络 owner,不是成员
    // 与写接口对照:manage=false → 改名 403;post=false → 发消息 404
    expect((await send(U.alice.token, "PATCH", CG(`/${GRP.rd}`), { name: "x" })).status).toBe(403);
    expect((await send(U.owner.token, "POST", msgs("rd"), { message: "x" })).status).toBe(404);
    const renamed = await send(U.head.token, "PATCH", CG(`/${GRP.rd}`), { name: "研发部" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.group.viewer_can).toEqual({ manage: true, post: true });
    // 列表行同口径
    const rows = (await send(U.alice.token, "GET", CG())).body.groups;
    expect(rows.find((g: any) => g.id === GRP.rd).viewer_can).toEqual({ manage: false, post: true });
    const headRows = (await send(U.head.token, "GET", CG())).body.groups;
    expect(headRows.find((g: any) => g.id === GRP.rd).viewer_can).toEqual({ manage: true, post: true });
    // 部门群接口:GET / POST
    const dg = await send(U.alice.token, "GET", `/api/networks/${NET}/departments/${DEPT.rd}/group`);
    expect(dg.body.group.viewer_can).toEqual({ manage: false, post: true });
    const dh = await send(U.head.token, "GET", `/api/networks/${NET}/departments/${DEPT.rd}/group`);
    expect(dh.body.group.viewer_can).toEqual({ manage: true, post: true });
    const nd = await send(U.owner.token, "POST", `/api/networks/${NET}/departments`, { name: "新建部", parent_id: DEPT.rd });
    expect(nd.status).toBe(201);
    const created = await send(U.head.token, "POST", `/api/networks/${NET}/departments/${nd.body.department.id}/group`, {});
    expect(created.status).toBe(201);
    expect(created.body.group.viewer_can).toEqual({ manage: true, post: false }); // 上级负责人建的,自己不在这个子部门
    expect(created.body.members).toEqual([]);
  });
  test("/health advertises chat_groups", async () => {
    const health = await fetch(`${BASE}/health`).then((r) => r.json()) as any;
    expect(health.capabilities).toContain("chat_groups");
  });
});

describe("delete network", () => {
  test("messages and read cursors go with the network", async () => {
    const tmp = register(`gm_tmp_${Date.now()}`, PW);
    const net = tmp.network_id!;
    const d = await send(tmp.token!, "POST", `/api/networks/${net}/departments`, { name: "临时部" });
    expect(d.status).toBe(201);
    expect((await send(tmp.token!, "PUT", `/api/networks/${net}/members/${tmp.user!.user_id}/department`, { department_id: d.body.department.id })).status).toBe(200);
    const g = await send(tmp.token!, "POST", `/api/networks/${net}/departments/${d.body.department.id}/group`, {});
    const gid = g.body.group.id;
    expect((await send(tmp.token!, "POST", `/api/networks/${net}/chat-groups/${gid}/messages`, { message: "hi" })).status).toBe(200);
    expect((await send(tmp.token!, "POST", `/api/networks/${net}/chat-groups/${gid}/read`, {})).status).toBe(200);
    expect(Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM chat_group_messages WHERE network_id = ?1", net)!.n)).toBe(1);
    (await import("./departments.js")).deleteDepartmentsForNetwork(net); // 删网络时调的那一个
    expect(Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM chat_group_messages WHERE network_id = ?1", net)!.n)).toBe(0);
    expect(Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM chat_group_reads WHERE network_id = ?1", net)!.n)).toBe(0);
  });
});
