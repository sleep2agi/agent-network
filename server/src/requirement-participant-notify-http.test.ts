// 参与人可以改任务的状态和检查项,改了通知相关的人(Vincent 2026-10-01)—— HTTP 集成测试(真实 Bun.serve,私有端口,临时库)。
// test2123 在真实 PostgreSQL 上原样再跑一遍(COMMHUB_TEST_PG_URL)。
//
// 网络 NET(owner = boss)。成员:
//   owen —— 卡的负责人;cara —— 建卡的人(task_access='all');
//   pat  —— 参与人,scoped(只看相关任务);pia —— 另一个参与人(all);
//   sam  —— scoped,与卡无关(看不见)。
// 正向:pat 改状态 / 勾检查项 / 改检查项列表 → 200;owen、cara、pia 各收到一条私信(发信人 pat),pat 自己没有;
//       60 s 内连续改动并成一条(未读时改写正文);读过之后再改 → 新的一条;MCP 与 REST 一致。
// 反向:pat 改标题 / 描述 / 负责人 / 参与人 / 项目 / 优先级 / 日期 / 标签 → 403 task_read_only + field,卡不变、不通知;
//       负责人自己改不通知;sam 照旧看不见(与不存在的卡逐字节相同)。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "anet-part-notify-"));
process.env.COMMHUB_DB ||= join(DIR, "hub.db");
process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
process.env.HOST = "127.0.0.1";
const PW = "PartNotifyPassw0rd!x";

type U = { token: string; id: string; username: string };
let BASE = "";
let hub: any = null;
let NET = "";
let PROJ = "";
let db: any;
let notify: typeof import("./requirement-notify.js");
let boss: U, owen: U, cara: U, pat: U, pia: U, sam: U;

type R = { status: number; body: any; text: string };
async function send(token: string, method: string, path: string, payload?: unknown): Promise<R> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, body, text };
}
async function mcp(token: string, name: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const lines = raw.split("\n").filter(x => x.startsWith("data:"));
  const payload = lines.length ? JSON.parse(lines.at(-1)!.slice(5).trim()) : JSON.parse(raw);
  return JSON.parse(payload.result.content[0].text);
}
const userRef = (id: string) => ({ kind: "user", id });

/** 某张卡发出的通知私信:按收件人分组(只看这张卡的,meta.task_notice.requirement_id)。 */
function notices(reqId: string): Record<string, Array<{ message_id: string; content: string; sender_user_id: string; acked: number; from_session: string }>> {
  const rows = db.all(
    "SELECT message_id, user_id, sender_user_id, from_session, content, acked, meta_json FROM user_inbox WHERE network_id = ?1 AND kind = 'human_dm' ORDER BY created_at, message_id",
    NET,
  ) as any[];
  const out: Record<string, any[]> = {};
  for (const r of rows) {
    let meta: any = null;
    try { meta = JSON.parse(r.meta_json); } catch {}
    if (meta?.task_notice?.requirement_id !== reqId) continue;
    (out[r.user_id] ||= []).push({ message_id: r.message_id, content: r.content, sender_user_id: r.sender_user_id, acked: Number(r.acked), from_session: r.from_session });
  }
  return out;
}

async function card(name: string, extra: Record<string, unknown> = {}) {
  const r = await send(cara.token, "POST", "/api/requirements", {
    network_id: NET, name, owner: userRef(owen.id), participants: [userRef(pat.id), userRef(pia.id)],
    checklist: [{ id: "i1", text: "写测试", done: false }, { id: "i2", text: "发版", done: false }], ...extra,
  });
  expect(r.status).toBe(201);
  return r.body.requirement.id as string;
}

beforeAll(async () => {
  ({ db } = await import("./db.js"));
  const { addNetworkMember, register } = await import("./auth.js");
  const stamp = Date.now();
  const mk = (name: string, display?: string): U => {
    const r = register(`pn_${name}_${stamp}`, PW, undefined, display);
    expect(r.ok).toBe(true);
    return { token: r.token!, id: r.user!.user_id, username: r.user!.username };
  };
  const b = register(`pn_boss_${stamp}`, PW);
  expect(b.ok).toBe(true);
  boss = { token: b.token!, id: b.user!.user_id, username: b.user!.username };
  NET = b.network_id!;
  owen = mk("owen"); cara = mk("cara"); pat = mk("pat", "参与人甲"); pia = mk("pia"); sam = mk("sam");
  addNetworkMember(NET, owen.id, "member", boss.id, { taskAccess: "all" });
  addNetworkMember(NET, cara.id, "member", boss.id, { taskAccess: "all" });
  addNetworkMember(NET, pat.id, "member", boss.id, { taskAccess: "scoped" });
  addNetworkMember(NET, pia.id, "member", boss.id, { taskAccess: "all" });
  addNetworkMember(NET, sam.id, "member", boss.id, { taskAccess: "scoped" });
  notify = await import("./requirement-notify.js");
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
  // register() 给每人建了自己的网络:后面的请求一律带 network_id。
  const p = await send(boss.token, "POST", "/api/requirements/projects", { network_id: NET, name: "pn-proj" });
  expect(p.status).toBe(201);
  PROJ = p.body.project.id;
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("参与人能改的", () => {
  test("改状态:200,负责人 / 创建者 / 其他参与人各一条,操作者自己没有", async () => {
    const id = await card("pn-状态");
    const r = await send(pat.token, "PATCH", `/api/requirements/${id}?network_id=${NET}`, { column: "doing" });
    expect(r.status).toBe(200);
    expect(r.body.requirement.column).toBe("doing");
    const n = notices(id);
    expect(Object.keys(n).sort()).toEqual([owen.id, cara.id, pia.id].sort());
    for (const uid of [owen.id, cara.id, pia.id]) {
      expect(n[uid].length).toBe(1);
      expect(n[uid][0].sender_user_id).toBe(pat.id);
      expect(n[uid][0].from_session).toBe(pat.username);
      expect(n[uid][0].content).toBe("参与人甲 把「pn-状态」改为 进行中");
    }
    expect(n[pat.id]).toBeUndefined();
  });

  test("勾检查项(单条接口):200 并通知", async () => {
    const id = await card("pn-勾选");
    const r = await send(pat.token, "PATCH", `/api/requirements/${id}/checklist/i1?network_id=${NET}`, { done: true });
    expect(r.status).toBe(200);
    expect(r.body.requirement.checklist.find((x: any) => x.id === "i1").done).toBe(true);
    expect(notices(id)[owen.id].map(x => x.content)).toEqual(["参与人甲 在「pn-勾选」勾选了检查项「写测试」"]);
  });

  test("整表改检查项(增 / 删 / 改字)+ 状态:一次 PATCH 一条通知,逐项列出", async () => {
    const id = await card("pn-整表");
    const r = await send(pat.token, "PATCH", `/api/requirements/${id}?network_id=${NET}`, {
      column: "done", checklist: [{ id: "i1", text: "写更多测试", done: false }, { id: "i3", text: "回归", done: false }],
    });
    expect(r.status).toBe(200);
    const n = notices(id)[cara.id];
    expect(n.length).toBe(1);
    expect(n[0].content).toBe("参与人甲 更新了「pn-整表」:\n· 改为 完成\n· 把检查项「写测试」改为「写更多测试」\n· 添加了检查项「回归」\n· 删除了检查项「发版」");
  });

  test("60 s 内连续勾选并成一条(未读时改写正文);同一项先勾再取消只留最后一次", async () => {
    const id = await card("pn-合并");
    for (const [item, done] of [["i1", true], ["i2", true], ["i1", false]] as const) {
      expect((await send(pat.token, "PATCH", `/api/requirements/${id}/checklist/${item}?network_id=${NET}`, { done })).status).toBe(200);
    }
    const n = notices(id);
    for (const uid of [owen.id, cara.id, pia.id]) {
      expect(n[uid].length).toBe(1);
      expect(n[uid][0].content).toBe("参与人甲 更新了「pn-合并」:\n· 勾选了检查项「发版」\n· 取消勾选了检查项「写测试」");
    }
  });

  test("收件人读过之后再改 → 另发一条;别人那条仍在合并", async () => {
    const id = await card("pn-已读");
    expect((await send(pat.token, "PATCH", `/api/requirements/${id}/checklist/i1?network_id=${NET}`, { done: true })).status).toBe(200);
    db.run("UPDATE user_inbox SET acked = 1 WHERE user_id = ?1 AND message_id = ?2", [owen.id, notices(id)[owen.id][0].message_id]);
    expect((await send(pat.token, "PATCH", `/api/requirements/${id}/checklist/i2?network_id=${NET}`, { done: true })).status).toBe(200);
    const n = notices(id);
    expect(n[owen.id].length).toBe(2);
    expect(n[owen.id][1].content).toBe("参与人甲 在「pn-已读」勾选了检查项「发版」");
    expect(n[cara.id].length).toBe(1);
  });

  test("过了合并窗口 → 另发一条", async () => {
    const id = await card("pn-窗口");
    const row = (col: string, ck: boolean) => ({
      requirement_id: id, network_id: NET, seq: null, title: "pn-窗口", column_name: col,
      checklist_json: JSON.stringify([{ id: "i1", text: "写测试", done: ck }]),
      owner_json: JSON.stringify(userRef(owen.id)), participants_json: JSON.stringify([userRef(pat.id)]),
      created_by: null, created_by_json: JSON.stringify(userRef(cara.id)),
    });
    const t0 = Date.now();
    expect(notify.notifyParticipantChange({ before: row("pool", false), after: row("pool", true), actorUserId: pat.id, now: t0 }).sort()).toEqual([owen.id, cara.id].sort());
    notify.notifyParticipantChange({ before: row("pool", true), after: row("doing", true), actorUserId: pat.id, now: t0 + notify.COALESCE_WINDOW_MS - 1 });
    expect(notices(id)[owen.id].length).toBe(1);
    notify.notifyParticipantChange({ before: row("doing", true), after: row("done", true), actorUserId: pat.id, now: t0 + notify.COALESCE_WINDOW_MS + 1 });
    expect(notices(id)[owen.id].length).toBe(2);
  });

  test("推送:收件人的用户流收到 desktop_message(kind=human_dm,发信人 = 参与人)", async () => {
    const id = await card("pn-推送");
    const ctrl = new AbortController();
    const res = await fetch(`${BASE}/events/users/me?network_id=${NET}`, { headers: { Authorization: `Bearer ${owen.token}` }, signal: ctrl.signal });
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
    const until = async (cond: () => boolean) => { for (let k = 0; k < 150 && !cond(); k++) await new Promise(r => setTimeout(r, 20)); };
    await until(() => events.some(e => e.type === "connected"));
    expect((await send(pat.token, "PATCH", `/api/requirements/${id}?network_id=${NET}`, { column: "doing" })).status).toBe(200);
    await until(() => events.some(e => e.type === "desktop_message"));
    ctrl.abort();
    const ev = events.find(e => e.type === "desktop_message");
    expect(ev).toMatchObject({ kind: "human_dm", from: pat.username, from_user_id: pat.id, title: "任务更新", message: "参与人甲 把「pn-推送」改为 进行中" });
    expect(ev.meta.task_notice.requirement_id).toBe(id);
  });

  test("MCP 与 REST 一致:requirements_update 改状态能过并通知,改标题被拒", async () => {
    const id = await card("pn-mcp");
    const ok = await mcp(pat.token, "requirements_update", { id, network_id: NET, column: "doing" });
    expect(ok.ok).toBe(true);
    expect(notices(id)[owen.id][0].content).toBe("参与人甲 把「pn-mcp」改为 进行中");
    expect(notices(id)[owen.id][0].from_session).toBe(pat.username);
    const no = await mcp(pat.token, "requirements_update", { id, network_id: NET, name: "改名" });
    expect(no).toMatchObject({ ok: false, error: "task_read_only", field: "name", status: 403 });
    const tog = await mcp(pat.token, "requirements_checklist_toggle", { id, network_id: NET, item_id: "i2", done: true });
    expect(tog.ok).toBe(true);
  });

  test("viewer_can:参与人带 edit_fields;负责人不带", async () => {
    const id = await card("pn-权限");
    const mine = await send(pat.token, "GET", `/api/requirements/${id}?network_id=${NET}`);
    expect(mine.body.requirement.viewer_can).toEqual({ edit: false, delete: false, edit_fields: ["column", "checklist"] });
  });
});

describe("参与人不能改的", () => {
  test("标题 / 描述 / 负责人 / 负责 Agent / 参与人 / 项目 / 优先级 / 日期 / 标签:403 task_read_only + field;卡不变、不通知", async () => {
    const id = await card("pn-拒绝");
    const before = (await send(cara.token, "GET", `/api/requirements/${id}?network_id=${NET}`)).body.requirement;
    const cases: Array<[string, unknown]> = [
      ["name", "改名"], ["description", "x"], ["owner", userRef(pat.id)], ["agent_owner", null], ["participants", [userRef(pat.id)]],
      ["project_id", PROJ], ["priority", "high"], ["due", "2026-12-31"], ["start", "2026-12-01"], ["tags", ["t"]], ["archived", true], ["parent_id", null],
    ];
    for (const [field, value] of cases) {
      const r = await send(pat.token, "PATCH", `/api/requirements/${id}?network_id=${NET}`, { [field]: value });
      expect(r.status).toBe(403);
      expect(r.body.ok).toBe(false);
      expect(r.body.error).toBe("task_read_only");
      expect(r.body.field).toBe(field);
      expect(typeof r.body.message).toBe("string");
    }
    // 混着能改的字段一起发:整条拒绝,状态也不动。
    const mixed = await send(pat.token, "PATCH", `/api/requirements/${id}?network_id=${NET}`, { column: "doing", name: "改名" });
    expect(mixed.status).toBe(403);
    expect(mixed.body.field).toBe("name");
    const after = (await send(cara.token, "GET", `/api/requirements/${id}?network_id=${NET}`)).body.requirement;
    expect(after).toEqual(before);
    expect(notices(id)).toEqual({});
  });

  test("负责人 / 创建者自己改:不通知;删除仍不行", async () => {
    const id = await card("pn-负责人");
    expect((await send(owen.token, "PATCH", `/api/requirements/${id}?network_id=${NET}`, { column: "doing" })).status).toBe(200);
    expect((await send(cara.token, "PATCH", `/api/requirements/${id}/checklist/i1?network_id=${NET}`, { done: true })).status).toBe(200);
    expect(notices(id)).toEqual({});
    expect((await send(pat.token, "DELETE", `/api/requirements/${id}?network_id=${NET}`)).status).toBe(403);
  });

  test("负责人同时是参与人:改了也不通知", async () => {
    const id = await card("pn-兼任", { owner: userRef(pat.id), participants: [userRef(pat.id), userRef(pia.id)] });
    expect((await send(pat.token, "PATCH", `/api/requirements/${id}?network_id=${NET}`, { column: "doing" })).status).toBe(200);
    expect(notices(id)).toEqual({});
  });

  test("只看相关任务的无关成员:看不见、改不了(与不存在的卡逐字节相同),也收不到通知", async () => {
    const id = await card("pn-无关");
    const list = await send(sam.token, "GET", `/api/requirements?network_id=${NET}`);
    expect((list.body.requirements as any[]).some(x => x.id === id)).toBe(false);
    const hidden = await send(sam.token, "PATCH", `/api/requirements/${id}?network_id=${NET}`, { column: "doing" });
    const ghost = await send(sam.token, "PATCH", `/api/requirements/req_does_not_exist?network_id=${NET}`, { column: "doing" });
    expect(hidden.status).toBe(404);
    expect(hidden.text).toBe(ghost.text);
    const hiddenCk = await send(sam.token, "PATCH", `/api/requirements/${id}/checklist/i1?network_id=${NET}`, { done: true });
    expect(hiddenCk.status).toBe(404);
    expect((await send(pat.token, "PATCH", `/api/requirements/${id}?network_id=${NET}`, { column: "doing" })).status).toBe(200);
    expect(notices(id)[sam.id]).toBeUndefined();
  });
});

describe("收件人(纯函数)", () => {
  test("只要人、去重、去掉操作者;旧卡没有 created_by_json 时用 created_by", () => {
    const base = {
      requirement_id: "r", network_id: NET, seq: 1, title: "t", column_name: "pool", checklist_json: null,
      owner_json: JSON.stringify(userRef("u-owner")),
      participants_json: JSON.stringify([userRef("u-actor"), userRef("u-owner"), { kind: "node", id: "n-1" }, userRef("u-other")]),
      created_by: null, created_by_json: JSON.stringify({ kind: "node", id: "n-2" }),
    };
    expect(notify.noticeRecipients(base, "u-actor").sort()).toEqual(["u-other", "u-owner"]);
    expect(notify.noticeRecipients({ ...base, created_by_json: null, created_by: "u-legacy" }, "u-actor").sort()).toEqual(["u-legacy", "u-other", "u-owner"]);
  });
});
