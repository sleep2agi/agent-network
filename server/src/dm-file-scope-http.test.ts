// 人与人私信的文件只给私信里的人看(owner 2026-09-30「给人好像发不了图片」的后续)。
//
// 规则:文件上传时带 `?purpose=dm`(App 私信输入框这么传)= 它第一次用途就是私信 → 私信文件(index scope=dm)。
// 私信文件只有上传者、带着它的私信的收发双方、管理员能下载;同网络的其他成员和节点令牌(Agent)都 404
// (与其它拒绝同一个形状,不泄露文件存在)。不带 purpose 上传的文件 —— 例如先在 agent 会话里发过 —— 永远不会
// 变成私信文件,之后转进私信也照旧全网成员可见。私信文件只能由看得见它的人再转发。

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register, addNetworkMember } from "./auth.js";
import { db } from "./db.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-dm-file-scope-"));
const PW = "DmFileScopePassw0rd!";
let BASE = "";
let hub: any = null;
let NET = "";
type U = { token: string; id: string };
let admin: U, alice: U, bob: U, carol: U, dave: U;
let adminNtok = "";

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
async function upload(token: string, body: string, query: string) {
  const form = new FormData();
  form.append("file", new Blob([new TextEncoder().encode(body)], { type: "image/png" }), "shot.png");
  const res = await fetch(`${BASE}/api/upload?network_id=${NET}${query}`, { method: "POST", body: form, headers: auth(token) });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}
async function uploadId(token: string, body: string, query = "") {
  const r = await upload(token, body, query);
  expect(r.status).toBe(200);
  return r.body.file_id as string;
}
async function dm(from: U, to: U, fileId: string, message = "") {
  const res = await fetch(`${BASE}/api/dm`, {
    method: "POST",
    headers: { ...auth(from.token), "Content-Type": "application/json" },
    body: JSON.stringify({ network_id: NET, to_user_id: to.id, message, attachments: [{ type: "file", file_id: fileId, name: "shot.png", mime: "image/png" }] }),
  });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}
const fileStatus = async (token: string, fileId: string, method = "GET") =>
  (await fetch(`${BASE}/api/files/${fileId}`, { method, headers: auth(token) })).status;
const entry = (fileId: string) => JSON.parse(readFileSync(join(DIR, "uploads", ".index", `${fileId}.json`), "utf8"));

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";
  const stamp = Date.now();
  const a = register(`dmfs_admin_${stamp}`, PW);
  db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [a.user!.user_id]);
  admin = { token: a.token!, id: a.user!.user_id };
  adminNtok = a.network_token!;
  NET = a.network_id!;
  // alice / bob / carol see every agent (agent_access=all) — the members for whom a network-scoped file was readable
  // before, i.e. where the gap was. dave is a restricted member (only granted agents).
  const mk = (name: string, agentAccess: "all" | "granted"): U => {
    const r = register(`${name}_${stamp}`, PW);
    expect(addNetworkMember(NET, r.user!.user_id, "member", admin.id, { agentAccess }).ok).toBe(true);
    return { token: r.token!, id: r.user!.user_id };
  };
  alice = mk("dmfs_alice", "all"); bob = mk("dmfs_bob", "all"); carol = mk("dmfs_carol", "all"); dave = mk("dmfs_dave", "granted");
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("upload ?purpose=dm", () => {
  test("marks the index entry; absent purpose writes no scope key (old shape)", async () => {
    expect(entry(await uploadId(alice.token, "p1", "&purpose=dm")).scope).toBe("dm");
    expect("scope" in entry(await uploadId(alice.token, "p2"))).toBe(false);
  });
  test("an unknown purpose is refused, not silently treated as network scope", async () => {
    const r = await upload(alice.token, "p3", "&purpose=DM");
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("bad_purpose");
  });
});

describe("a DM file is readable only by the people in the DM", () => {
  test("alice → bob: alice and bob read it; carol (same network, not in the DM) and agents get 404; admin reads", async () => {
    const fid = await uploadId(alice.token, "alice-to-bob", "&purpose=dm");
    expect((await dm(alice, bob, fid)).status).toBe(200);
    expect(await fileStatus(alice.token, fid)).toBe(200);
    expect(await fileStatus(bob.token, fid)).toBe(200);
    expect(await fileStatus(carol.token, fid)).toBe(404);
    expect(await fileStatus(carol.token, fid, "HEAD")).toBe(404);
    expect(await fileStatus(adminNtok, fid)).toBe(404);
    expect(await fileStatus(admin.token, fid)).toBe(200);
  });
  test("bob → alice (other direction): same rule", async () => {
    const fid = await uploadId(bob.token, "bob-to-alice", "&purpose=dm");
    expect((await dm(bob, alice, fid)).status).toBe(200);
    expect(await fileStatus(bob.token, fid)).toBe(200);
    expect(await fileStatus(alice.token, fid)).toBe(200);
    expect(await fileStatus(carol.token, fid)).toBe(404);
  });
  test("a restricted member in the DM reads it both ways; out of it, not", async () => {
    const toDave = await uploadId(alice.token, "alice-to-dave", "&purpose=dm");
    expect((await dm(alice, dave, toDave)).status).toBe(200);
    expect(await fileStatus(dave.token, toDave)).toBe(200);
    const fromDave = await uploadId(dave.token, "dave-to-alice", "&purpose=dm");
    expect((await dm(dave, alice, fromDave)).status).toBe(200);
    expect(await fileStatus(alice.token, fromDave)).toBe(200);
    expect(await fileStatus(bob.token, fromDave)).toBe(404);
    const other = await uploadId(alice.token, "alice-to-bob-2", "&purpose=dm");
    await dm(alice, bob, other);
    expect(await fileStatus(dave.token, other)).toBe(404);
  });
  test("before it is sent, only the uploader reads it", async () => {
    const fid = await uploadId(alice.token, "draft", "&purpose=dm");
    expect(await fileStatus(alice.token, fid)).toBe(200);
    expect(await fileStatus(bob.token, fid)).toBe(404);
  });
  test("the DM thread still returns the attachment to both sides", async () => {
    const fid = await uploadId(alice.token, "thread", "&purpose=dm");
    await dm(alice, bob, fid, "看图");
    const t = await (await fetch(`${BASE}/api/dm?network_id=${NET}&with=${alice.id}`, { headers: auth(bob.token) })).json() as any;
    expect(JSON.parse(t.messages[0].meta_json).attachments[0].file_id).toBe(fid);
  });
});

describe("nobody unlocks a DM file by putting its id into their own DM", () => {
  test("carol DMs alice's DM file to bob → 403, and she still can't read it", async () => {
    const fid = await uploadId(alice.token, "secret", "&purpose=dm");
    expect((await dm(alice, bob, fid)).status).toBe(200);
    const r = await dm(carol, bob, fid);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("attachment_not_accessible");
    expect(await fileStatus(carol.token, fid)).toBe(404);
  });
  test("bob (who received it) may forward it to carol, and then carol reads it", async () => {
    const fid = await uploadId(alice.token, "forwardable", "&purpose=dm");
    expect((await dm(alice, bob, fid)).status).toBe(200);
    expect((await dm(bob, carol, fid)).status).toBe(200);
    expect(await fileStatus(carol.token, fid)).toBe(200);
  });
});

describe("files whose first use was not a DM keep their scope", () => {
  test("uploaded in an agent chat, then forwarded into a DM → still readable by every member", async () => {
    const fid = await uploadId(alice.token, "agent-chat-first");
    // first use: an agent task (what ChatScreen does: upload without purpose, send_task with the file id)
    db.run(
      `INSERT INTO tasks (task_id, from_name, to_name, status, content, network_id, meta_json) VALUES (?1, ?2, 'dmfs-agent', 'delivered', 'see image', ?3, ?4)`,
      [`t_dmfs_${Date.now()}`, "dmfs_alice", NET, JSON.stringify({ attachments: [{ type: "file", file_id: fid }] })],
    );
    expect(await fileStatus(carol.token, fid)).toBe(200);
    expect((await dm(alice, bob, fid)).status).toBe(200);
    expect("scope" in entry(fid)).toBe(false);
    expect(await fileStatus(carol.token, fid)).toBe(200);
    expect(await fileStatus(bob.token, fid)).toBe(200);
    expect(await fileStatus(adminNtok, fid)).toBe(200);
  });
  test("an old app's DM upload (no purpose) behaves exactly as before", async () => {
    const fid = await uploadId(alice.token, "old-app");
    expect((await dm(alice, bob, fid)).status).toBe(200);
    expect(await fileStatus(carol.token, fid)).toBe(200);
  });
});

describe("index entry integrity", () => {
  test("a hand-edited unknown scope makes the entry invalid (404), never network-wide", async () => {
    const fid = await uploadId(alice.token, "tamper", "&purpose=dm");
    const path = join(DIR, "uploads", ".index", `${fid}.json`);
    writeFileSync(path, JSON.stringify({ ...entry(fid), scope: "public" }));
    expect(await fileStatus(alice.token, fid)).toBe(404);
    expect(await fileStatus(carol.token, fid)).toBe(404);
  });
});
