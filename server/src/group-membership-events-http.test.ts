// RFC-042 §9.3 补口(看板 #457):入群 / 退群实时事件 group_membership_changed。
// HTTP 集成测试(真实 Bun.serve,私有端口,临时库;PostgreSQL 由 test2123 梯子用 COMMHUB_TEST_PG_URL 跑同一个文件)。
// 钉住:手动拉人 / 移人、调进 / 调出部门、换负责人、移出网络 → 被加 / 被移的人和提交后的当前群成员各收到一条;
// 不相干的人收不到;事件只在提交之后推 —— 整个事务回滚一条不推,内层 savepoint 回滚只丢内层那几笔。

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register } from "./auth.js";
import { db } from "./db.js";
import { groupTx, syncDepartmentGroups, isGroupMember } from "./department-groups.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-group-membership-ev-"));
let BASE = "";
let hub: any = null;
const PW = "GroupMembershipEvPassw0rd!x";
let NET = "";
const U: Record<string, { token: string; id: string; username: string }> = {};
const DEPT: Record<string, string> = {};
const GRP: Record<string, string> = {};
const S: Record<string, { events: any[]; close: () => void }> = {};

async function send(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json };
}
const CG = (suffix = "") => `/api/networks/${NET}/chat-groups${suffix}`;
const place = async (who: string, dept: string | null) =>
  expect((await send(U.owner.token, "PUT", `/api/networks/${NET}/members/${U[who].id}/department`, { department_id: dept })).status).toBe(200);

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 只看成员事件;清空所有订阅者已收到的,便于每个用例从零数。 */
const mev = (who: string) => S[who].events.filter((e) => e.type === "group_membership_changed");
// 先等上一个用例里没被等的收件人(比如 hank)的事件落地,再清空 —— 否则它会串到下一个用例里。
const reset = async () => { await sleep(150); for (const k of Object.keys(S)) S[k].events.length = 0; };
const match = (who: string, group: string, member: string, change: string, source: string) =>
  mev(who).filter((e) => e.group_id === GRP[group] && e.member_user_id === U[member].id && e.change === change && e.source === source);

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";
  const stamp = Date.now();
  const a = register(`gme_owner_${stamp}`, PW, undefined, "Owner");
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
  U.alice = await add(`gme_alice_${stamp}`, "member"); // 研发部(旁观的当前成员)
  U.carol = await add(`gme_carol_${stamp}`, "member"); // 研发部,之后被调去市场部
  U.dave = await add(`gme_dave_${stamp}`, "member");   // 市场部,被手动拉进 / 移出研发部群
  U.erin = await add(`gme_erin_${stamp}`, "member");   // 未分配,之后调进研发部
  U.frank = await add(`gme_frank_${stamp}`, "member"); // 未分配:回滚用例的对象
  U.gina = await add(`gme_gina_${stamp}`, "member");   // 未分配:不相干的人 / 负责人用例
  U.hank = await add(`gme_hank_${stamp}`, "member");   // 研发部,之后被移出网络

  const mk = async (name: string, extra: Record<string, unknown> = {}) => {
    const r = await send(U.owner.token, "POST", `/api/networks/${NET}/departments`, { name, ...extra });
    expect(r.status).toBe(201);
    return r.body.department.id as string;
  };
  DEPT.rd = await mk("研发部");
  DEPT.market = await mk("市场部");
  for (const w of ["alice", "carol", "hank"]) await place(w, DEPT.rd);
  await place("dave", DEPT.market);
  for (const key of ["rd", "market"]) {
    const r = await send(U.owner.token, "POST", `/api/networks/${NET}/departments/${DEPT[key]}/group`, {});
    expect(r.status).toBe(201);
    GRP[key] = r.body.group.id;
  }
  for (const w of ["owner", "alice", "carol", "dave", "erin", "frank", "gina", "hank"]) S[w] = await subscribe(w);
}, 30_000);

afterAll(() => {
  for (const s of Object.values(S)) try { s.close(); } catch {}
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("manual add / remove", () => {
  test("manual add: the added user and current members get one `added` event; outsiders get nothing", async () => {
    await reset();
    const r = await send(U.owner.token, "POST", CG(`/${GRP.rd}/members`), { user_id: U.dave.id });
    expect(r.status).toBe(201);
    await until(() => ["dave", "alice", "carol"].every((w) => match(w, "rd", "dave", "added", "manual").length > 0));
    expect(match("dave", "rd", "dave", "added", "manual")).toHaveLength(1);
    expect(match("alice", "rd", "dave", "added", "manual")).toHaveLength(1);
    expect(match("carol", "rd", "dave", "added", "manual")).toHaveLength(1);
    const ev = match("dave", "rd", "dave", "added", "manual")[0];
    expect(ev).toMatchObject({ type: "group_membership_changed", network_id: NET, group_id: GRP.rd, member_user_id: U.dave.id, change: "added", source: "manual", scope: "user" });
    expect(ev.user_id).toBe(U.dave.id); // 信封 user_id = 收件人
    expect(match("alice", "rd", "dave", "added", "manual")[0].user_id).toBe(U.alice.id);
    expect(new Date(ev.at).toISOString()).toBe(ev.at);
    await sleep(100);
    expect(mev("gina")).toHaveLength(0);
    expect(mev("erin")).toHaveLength(0);
  });

  test("manual remove: the removed user and the remaining members get one `removed` event", async () => {
    await reset();
    const r = await send(U.owner.token, "DELETE", CG(`/${GRP.rd}/members/${U.dave.id}`));
    expect(r.status).toBe(200);
    await until(() => ["dave", "alice"].every((w) => match(w, "rd", "dave", "removed", "manual").length > 0));
    expect(match("dave", "rd", "dave", "removed", "manual")).toHaveLength(1);
    expect(match("alice", "rd", "dave", "removed", "manual")).toHaveLength(1);
    await sleep(100);
    expect(mev("gina")).toHaveLength(0);
  });

  test("a refused write (409 already_group_member) emits nothing", async () => {
    await reset();
    expect((await send(U.owner.token, "POST", CG(`/${GRP.rd}/members`), { user_id: U.alice.id })).status).toBe(409);
    await sleep(150);
    for (const w of Object.keys(S)) expect(mev(w)).toHaveLength(0);
  });
});

describe("department sync", () => {
  test("move-in: erin into 研发部 → `added`/department to erin and the 研发部 group's members", async () => {
    await reset();
    await place("erin", DEPT.rd);
    await until(() => ["erin", "alice"].every((w) => match(w, "rd", "erin", "added", "department").length > 0));
    expect(match("erin", "rd", "erin", "added", "department")).toHaveLength(1);
    expect(match("alice", "rd", "erin", "added", "department")).toHaveLength(1);
    await sleep(100);
    expect(mev("dave")).toHaveLength(0); // 市场部群没变
    expect(isGroupMember(GRP.rd, U.erin.id)).toBe(true);
  });

  test("move-out: carol 研发部 → 市场部 → removed from 研发部 group, added to 市场部 group", async () => {
    await reset();
    await place("carol", DEPT.market);
    await until(() => ["carol", "alice"].every((w) => match(w, "rd", "carol", "removed", "department").length > 0) && ["carol", "dave"].every((w) => match(w, "market", "carol", "added", "department").length > 0));
    expect(match("carol", "rd", "carol", "removed", "department")).toHaveLength(1);
    expect(match("alice", "rd", "carol", "removed", "department")).toHaveLength(1);
    expect(match("carol", "market", "carol", "added", "department")).toHaveLength(1);
    expect(match("dave", "market", "carol", "added", "department")).toHaveLength(1);
    // alice 不在市场部群:不该收到市场部群的变化
    await sleep(100);
    expect(mev("alice").filter((e) => e.group_id === GRP.market)).toHaveLength(0);
  });

  test("head change: gina made 研发部 leader joins the group; unsetting removes her", async () => {
    await reset();
    expect((await send(U.owner.token, "PATCH", `/api/networks/${NET}/departments/${DEPT.rd}`, { leader_user_id: U.gina.id })).status).toBe(200);
    await until(() => ["gina", "alice"].every((w) => match(w, "rd", "gina", "added", "department").length > 0));
    expect(match("gina", "rd", "gina", "added", "department")).toHaveLength(1);
    expect(match("alice", "rd", "gina", "added", "department")).toHaveLength(1);
    // 部门写会踢掉负责人的用户流(RFC-040,权限变了要重连重新鉴权)—— App 会重连;这里同样重订阅一次。
    S.gina.close();
    S.gina = await subscribe("gina");
    await reset();
    expect((await send(U.owner.token, "PATCH", `/api/networks/${NET}/departments/${DEPT.rd}`, { leader_user_id: null })).status).toBe(200);
    await until(() => ["gina", "alice"].every((w) => match(w, "rd", "gina", "removed", "department").length > 0));
    expect(match("gina", "rd", "gina", "removed", "department")).toHaveLength(1);
    expect(match("alice", "rd", "gina", "removed", "department")).toHaveLength(1);
  });

  test("rename-only PATCH (no roster change) emits nothing", async () => {
    await reset();
    expect((await send(U.owner.token, "PATCH", `/api/networks/${NET}/departments/${DEPT.rd}`, { name: "研发中心" })).status).toBe(200);
    await sleep(150);
    for (const w of Object.keys(S)) expect(mev(w)).toHaveLength(0);
  });
});

describe("post-commit only", () => {
  test("a rolled-back write emits nothing and changes nothing", async () => {
    await reset();
    expect(() => groupTx(() => {
      db.run("UPDATE network_members SET department_id = ?3 WHERE network_id = ?1 AND user_id = ?2", [NET, U.frank.id, DEPT.rd]);
      syncDepartmentGroups(NET);
      expect(isGroupMember(GRP.rd, U.frank.id)).toBe(true); // 事务里确实对过账
      throw new Error("boom");
    })).toThrow("boom");
    expect(isGroupMember(GRP.rd, U.frank.id)).toBe(false);
    await sleep(200);
    for (const w of Object.keys(S)) expect(mev(w)).toHaveLength(0);
    // 下一次提交的写也不会把回滚掉的那笔捎带出去
    await place("erin", DEPT.rd); // 无变化的调人(erin 已在研发部)
    await sleep(150);
    for (const w of Object.keys(S)) expect(mev(w).filter((e) => e.member_user_id === U.frank.id)).toHaveLength(0);
  });

  test("an inner savepoint rollback drops only its own changes; the outer commit still emits", async () => {
    await reset();
    groupTx(() => {
      db.run("UPDATE network_members SET department_id = ?3 WHERE network_id = ?1 AND user_id = ?2", [NET, U.gina.id, DEPT.rd]);
      syncDepartmentGroups(NET);
      try {
        groupTx(() => {
          db.run("UPDATE network_members SET department_id = ?3 WHERE network_id = ?1 AND user_id = ?2", [NET, U.frank.id, DEPT.rd]);
          syncDepartmentGroups(NET);
          throw new Error("inner");
        });
      } catch {}
      // 事务还没提交:这时一条都不该推出去
      expect(mev("alice")).toHaveLength(0);
    });
    expect(isGroupMember(GRP.rd, U.gina.id)).toBe(true);
    expect(isGroupMember(GRP.rd, U.frank.id)).toBe(false);
    await until(() => match("alice", "rd", "gina", "added", "department").length > 0);
    expect(match("alice", "rd", "gina", "added", "department")).toHaveLength(1);
    await sleep(100);
    for (const w of Object.keys(S)) expect(mev(w).filter((e) => e.member_user_id === U.frank.id)).toHaveLength(0);
  });
});

describe("network member removal", () => {
  test("removing hank from the network → remaining 研发部 members get `removed`/network_removal", async () => {
    // 调部门 / 换负责人会踢掉当事人的用户流(RFC-040,App 会重连):erin、gina 先重订阅。
    for (const w of ["erin", "gina"]) { S[w].close(); S[w] = await subscribe(w); }
    await reset();
    const r = await send(U.owner.token, "DELETE", `/api/networks/${NET}/members/${U.hank.id}`);
    expect(r.status).toBe(200);
    await until(() => ["alice", "erin", "gina"].every((w) => match(w, "rd", "hank", "removed", "network_removal").length > 0));
    expect(match("alice", "rd", "hank", "removed", "network_removal")).toHaveLength(1);
    expect(match("erin", "rd", "hank", "removed", "network_removal")).toHaveLength(1);
    expect(match("gina", "rd", "hank", "removed", "network_removal")).toHaveLength(1);
    // 不能再有一条 department 来源的重复移出(移出网络已经删了所有行,对账没东西可删)
    expect(match("alice", "rd", "hank", "removed", "department")).toHaveLength(0);
    expect(isGroupMember(GRP.rd, U.hank.id)).toBe(false);
  });
});
