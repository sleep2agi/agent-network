// 人员列表的在线状态 —— HTTP 集成测试(真实 Bun.serve,私有端口,临时库)。
//
// GET /api/networks/:id/humans 给每个人加 online / last_seen_at(判据 = 此刻有没有活着的用户流
// /events/users/me);用户流上推 member_presence。两个方向都测:
//   看得到:普通成员、受限成员、viewer;连上 → online=true,断开 → online=false + last_seen_at。
//   看不到:非成员 403;节点令牌只拿身份字段(含头像),无在线状态;别的网络的人收不到推送;自己收不到自己的。

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register } from "./auth.js";
import { db, hashToken, generateNetworkToken, generateId } from "./db.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-member-presence-"));
let BASE = "";
let hub: any = null;

const PW = "PresenceTestPassw0rd!x";
let ownerToken = "";
let NET = "";
const users: Record<string, { token: string; userId: string }> = {};
let nodeToken = "";

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function get(token: string, path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, { headers: auth(token) });
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, body };
}
async function post(token: string, path: string, payload: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers: { ...auth(token), "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, body };
}
async function login(username: string): Promise<{ token: string; userId: string }> {
  const r = await post("", "/api/auth/login", { username, password: PW });
  expect(r.status).toBe(200);
  return { token: r.body.token, userId: r.body.user.user_id };
}

/** 一条用户流:收集 data: 帧,close() 模拟 app 退出。 */
async function openUserStream(token: string, networkId: string) {
  const ctrl = new AbortController();
  const res = await fetch(`${BASE}/events/users/me?network_id=${encodeURIComponent(networkId)}`, { headers: auth(token), signal: ctrl.signal });
  expect(res.status).toBe(200);
  const events: any[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value);
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          for (const line of frame.split("\n")) if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)));
        }
      }
    } catch { /* aborted */ }
  })();
  await waitFor(() => events.some((e) => e.type === "connected"));
  return { events, close: () => ctrl.abort(), presence: () => events.filter((e) => e.type === "member_presence") };
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor timed out");
}

const humanOf = async (token: string, userId: string) =>
  (await get(token, `/api/networks/${NET}/humans`)).body.humans.find((h: any) => h.user_id === userId);

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";

  const owner = register(`pres_owner_${Date.now()}`, PW, undefined, "Owner");
  expect(owner.ok).toBe(true);
  ownerToken = owner.token!;
  NET = owner.network_id!;
  db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [owner.user!.user_id]);
  users.owner = { token: ownerToken, userId: owner.user!.user_id };

  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;

  // 受限成员(默认 agent_access=granted)、viewer、普通成员;外人自己一个网络。
  for (const [name, role] of [["pres_alpha", "member"], ["pres_beta", "member"], ["pres_gamma", "viewer"]] as const) {
    const r = await post(ownerToken, "/api/admin/users", { username: name, password: PW, network_id: NET, role });
    expect(r.status).toBe(200);
    users[name] = await login(name);
  }
  const outsider = register(`pres_out_${Date.now()}`, PW);
  expect(outsider.ok).toBe(true);
  users.outsider = { token: outsider.token!, userId: outsider.user!.user_id };
  users.outsider_net = { token: outsider.token!, userId: outsider.network_id! };

  nodeToken = generateNetworkToken();
  db.run("INSERT INTO api_tokens (token_id, token_hash, user_id, network_id, name, scope) VALUES (?1, ?2, ?3, ?4, 'pres-node', 'network')",
    [generateId("tok"), hashToken(nodeToken), users.owner.userId, NET]);
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("GET /api/networks/:id/humans — online / last_seen_at", () => {
  test("never connected since hub start → online=false, last_seen_at=null (unknown, not 'long ago')", async () => {
    const r = await get(users.pres_alpha.token, `/api/networks/${NET}/humans`);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.humans[0]).sort()).toEqual(["avatar_url", "display_name", "last_seen_at", "online", "user_id", "username"]);
    expect(r.body.humans.every((h: any) => h.avatar_url === null)).toBe(true);
    const beta = r.body.humans.find((h: any) => h.user_id === users.pres_beta.userId);
    expect(beta.online).toBe(false);
    expect(beta.last_seen_at).toBeNull();
  });

  test("user stream open → online for member, restricted member and viewer; closed → offline with last_seen_at", async () => {
    const watcher = await openUserStream(users.pres_alpha.token, NET);
    const before = Date.now();
    const beta = await openUserStream(users.pres_beta.token, NET);

    for (const viewer of ["pres_alpha", "pres_gamma", "owner"]) {
      const h = await humanOf(users[viewer].token, users.pres_beta.userId);
      expect(h.online).toBe(true);
      expect(Date.parse(h.last_seen_at)).toBeGreaterThanOrEqual(before - 1000);
    }
    // 推送:alpha 收到 beta 上线;beta 收不到自己的。
    await waitFor(() => watcher.presence().some((e) => e.member_user_id === users.pres_beta.userId && e.online === true));
    const up = watcher.presence().find((e) => e.member_user_id === users.pres_beta.userId)!;
    expect(up.network_id).toBe(NET);
    expect(up.user_id).toBe(users.pres_alpha.userId); // 收件人
    expect(beta.presence().filter((e) => e.member_user_id === users.pres_beta.userId)).toEqual([]);

    beta.close();
    await waitFor(async () => (await humanOf(users.pres_alpha.token, users.pres_beta.userId)).online === false);
    const off = await humanOf(users.pres_gamma.token, users.pres_beta.userId);
    expect(off.online).toBe(false);
    expect(Date.parse(off.last_seen_at)).toBeGreaterThanOrEqual(before - 1000);
    await waitFor(() => watcher.presence().some((e) => e.member_user_id === users.pres_beta.userId && e.online === false));
    const down = watcher.presence().find((e) => e.member_user_id === users.pres_beta.userId && e.online === false)!;
    expect(typeof down.last_seen_at).toBe("string");
    watcher.close();
  });

  test("two streams for one user: closing one keeps them online, no offline event", async () => {
    const watcher = await openUserStream(users.pres_alpha.token, NET);
    const a = await openUserStream(users.pres_beta.token, NET);
    const b = await openUserStream(users.pres_beta.token, NET);
    await waitFor(() => watcher.presence().some((e) => e.member_user_id === users.pres_beta.userId && e.online));
    a.close();
    await new Promise((r) => setTimeout(r, 200));
    expect((await humanOf(users.pres_alpha.token, users.pres_beta.userId)).online).toBe(true);
    expect(watcher.presence().filter((e) => e.member_user_id === users.pres_beta.userId && !e.online)).toEqual([]);
    b.close();
    await waitFor(async () => (await humanOf(users.pres_alpha.token, users.pres_beta.userId)).online === false);
    watcher.close();
  });
});

describe("who must NOT see presence", () => {
  test("non-member → 403, no humans at all", async () => {
    const r = await get(users.outsider.token, `/api/networks/${NET}/humans`);
    expect(r.status).toBe(403);
    expect(r.body.humans).toBeUndefined();
  });

  test("node token → identity fields including avatar, no online / last_seen_at", async () => {
    const beta = await openUserStream(users.pres_beta.token, NET);
    const r = await get(nodeToken, `/api/networks/${NET}/humans`);
    expect(r.status).toBe(200);
    for (const h of r.body.humans) {
      expect(Object.keys(h).sort()).toEqual(["avatar_url", "display_name", "user_id", "username"]);
      expect(h.avatar_url).toBeNull();
    }
    // 节点令牌也不能订阅用户流(既有行为,这里钉住:不能借它收 member_presence)。
    expect((await fetch(`${BASE}/events/users/me?network_id=${NET}`, { headers: auth(nodeToken) })).status).toBe(403);
    beta.close();
    await waitFor(async () => (await humanOf(users.pres_alpha.token, users.pres_beta.userId)).online === false);
  });

  test("a user connected in another network gets no member_presence about this network's people", async () => {
    const outsiderStream = await openUserStream(users.outsider.token, users.outsider_net.userId);
    const watcher = await openUserStream(users.pres_alpha.token, NET);
    const beta = await openUserStream(users.pres_beta.token, NET);
    await waitFor(() => watcher.presence().some((e) => e.member_user_id === users.pres_beta.userId && e.online));
    beta.close();
    await waitFor(() => watcher.presence().some((e) => e.member_user_id === users.pres_beta.userId && !e.online));
    expect(outsiderStream.presence()).toEqual([]);
    watcher.close();
    outsiderStream.close();
  });
});
