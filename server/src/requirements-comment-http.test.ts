// #474(MCP 任务生命周期测试报告问题 5)—— 评论 / 进展:只追加,进「动态」(requirement_events kind=comment),
// 不改任务本身。钉住:
//   - Agent(节点令牌)经 MCP、人经 REST 都能评论,署名是调用者;description / updated_at 一个字节都不动;
//   - requirements_events 里是 kind=comment、new.text 全文,单任务的动态体积可控;
//   - 看不见这张卡的人评论 = 404(和读一样),只读角色 = 403,空 / 超长 = 400 + 提示;
//   - 只追加:没有改 / 删评论的路由。
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register, createNetworkTokenForNode } from "./auth.js";
import { db } from "./db.js";
import { COMMENT_MAX_CHARS } from "./requirements.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-req-comment-"));
let BASE = "";
let hub: any = null;
const PW = "ReqCommentPassw0rd!xyz";
let NET = "";
const U: Record<string, { token: string; id: string }> = {};
let card = { id: "", seq: 0 };

async function rest(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json, bytes: text.length };
}
async function rpc(token: string, name: string, args: Record<string, unknown>): Promise<{ data: any; raw: any; bytes: number }> {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const lines = raw.split("\n").filter(x => x.startsWith("data:"));
  const out = lines.length ? JSON.parse(lines.at(-1)!.slice(5).trim()) : JSON.parse(raw);
  const text = out.result?.content?.[0]?.text ?? "";
  let data: any = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { data, raw: out, bytes: text.length };
}
const mcp = async (token: string, name: string, args: Record<string, unknown>) => (await rpc(token, name, args)).data;
const cardRow = (id: string) => db.get<{ description: string | null; updated_at: string | null; updated_by_json: string | null }>("SELECT description, updated_at, updated_by_json FROM requirements WHERE requirement_id = ?1", id)!;

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";
  const a = register(`cmt_owner_${Date.now()}`, PW, undefined, "Owner");
  U.owner = { token: a.token!, id: a.user!.user_id };
  NET = a.network_id!;
  db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [U.owner.id]);
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
  const mk = async (username: string, role: string) => {
    expect((await rest(U.owner.token, "POST", "/api/admin/users", { username, password: PW, network_id: NET, role })).status).toBe(200);
    const login = await rest("", "POST", "/api/auth/login", { username, password: PW });
    return { token: login.body.token as string, id: login.body.user.user_id as string };
  };
  const stamp = Date.now();
  U.member = await mk(`cmt_member_${stamp}`, "member");
  U.viewer = await mk(`cmt_viewer_${stamp}`, "viewer");
  U.scoped = await mk(`cmt_scoped_${stamp}`, "member");
  expect((await rest(U.owner.token, "PUT", `/api/networks/${NET}/members/${U.scoped.id}/task-grants`, { task_access: "scoped", project_grants: [] })).status).toBe(200);
  U.nodeA = { token: createNetworkTokenForNode(U.owner.id, NET, "示例-甲", "node_cmt_a").token!, id: "node_cmt_a" };
  const created = (await mcp(U.nodeA.token, "requirements_create", { name: "示例任务:评论", description: "## 背景\n原文。" })).requirement;
  card = { id: created.id, seq: created.seq };
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("requirements_comment", () => {
  test("an Agent comments over MCP (#N): one comment event, attributed to the node; the task itself is untouched", async () => {
    const before = cardRow(card.id);
    const r = await mcp(U.nodeA.token, "requirements_comment", { id: `#${card.seq}`, text: "进展:示例草稿已写完,等人看。" });
    expect(r.ok).toBe(true);
    expect(r.event.kind).toBe("comment");
    expect(r.event.field).toBeNull();
    expect(r.event.new).toEqual({ text: "进展:示例草稿已写完,等人看。" });
    expect(r.event.actor).toEqual({ kind: "node", id: "node_cmt_a" });
    expect(r.event.requirement_id).toBe(card.id);
    const after = cardRow(card.id);
    expect(after).toEqual(before); // description, updated_at, updated_by all unchanged
  });

  test("a person comments over REST; both show in requirements_events with the full text, newest first", async () => {
    const r = await rest(U.member.token, "POST", `/api/requirements/${card.id}/comments`, { text: "  好的,我下午看。  " });
    expect(r.status).toBe(201);
    expect(r.body.event.new.text).toBe("好的,我下午看。"); // trimmed
    expect(r.body.event.actor).toEqual({ kind: "user", id: U.member.id });
    const ev = await rpc(U.nodeA.token, "requirements_events", { requirement_id: `#${card.seq}` });
    const comments = ev.data.events.filter((e: any) => e.kind === "comment");
    expect(comments.map((e: any) => e.new.text)).toEqual(["好的,我下午看。", "进展:示例草稿已写完,等人看。"]);
    expect(ev.data.events.at(-1).kind).toBe("created");
  });

  test("full text up to the cap, and the timeline stays small", async () => {
    const long = "长".repeat(COMMENT_MAX_CHARS);
    const r = await mcp(U.nodeA.token, "requirements_comment", { id: card.id, text: long });
    expect(r.ok).toBe(true);
    expect(r.event.new.text.length).toBe(COMMENT_MAX_CHARS);
    const ev = await rpc(U.nodeA.token, "requirements_events", { requirement_id: card.id });
    // 1 created + 3 comments (one of them 4000 chars): well under 20 KB.
    expect(ev.bytes).toBeLessThan(20_000);
    expect(ev.data.events.some((e: any) => e.kind === "comment" && e.new.text === long)).toBe(true);
  });

  test("bad input: empty → invalid_comment, over the cap → comment_too_long (REST), MCP schema → -32602; both with hints", async () => {
    const empty = await rest(U.member.token, "POST", `/api/requirements/${card.id}/comments`, { text: "   " });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toBe("invalid_comment");
    expect(empty.body.field).toBe("text");
    const tooLong = await rest(U.member.token, "POST", `/api/requirements/${card.id}/comments`, { text: "x".repeat(COMMENT_MAX_CHARS + 1) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error).toBe("comment_too_long");
    expect(tooLong.body.hint).toContain("Split");
    const viaMcp = await rpc(U.nodeA.token, "requirements_comment", { id: card.id, text: "x".repeat(COMMENT_MAX_CHARS + 1) });
    expect(String(viaMcp.raw.error?.code ?? viaMcp.raw.result?.content?.[0]?.text)).toMatch(/-32602|too big|Too big/i);
  });

  test("permissions: a non-reader gets 404 (like reading), a read-only role 403; neither writes anything", async () => {
    const count = () => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM requirement_events WHERE requirement_id = ?1 AND kind = 'comment'", card.id)!.n;
    const n = count();
    // scoped member with no grant cannot see the task → cannot read it → cannot comment on it.
    expect((await rest(U.scoped.token, "GET", `/api/requirements/${card.id}`)).status).toBe(404);
    const scoped = await rest(U.scoped.token, "POST", `/api/requirements/${card.id}/comments`, { text: "看不见也想评论" });
    expect(scoped.status).toBe(404);
    expect(scoped.body.error).toBe("requirement_not_found");
    const viewer = await rest(U.viewer.token, "POST", `/api/requirements/${card.id}/comments`, { text: "只读角色" });
    expect(viewer.status).toBe(403);
    expect(viewer.body.error).toBe("permission_denied");
    expect(count()).toBe(n);
    // …and the scoped member does not see the comments in the network timeline either.
    const ev = await rest(U.scoped.token, "GET", `/api/requirements/events?network_id=${NET}`);
    expect((ev.body.events ?? []).some((e: any) => e.requirement_id === card.id)).toBe(false);
  });

  test("append-only: no route edits or deletes a comment; unknown task → requirement_not_found with a hint", async () => {
    expect((await rest(U.owner.token, "PATCH", `/api/requirements/${card.id}/comments`, { text: "改" })).status).toBe(404);
    expect((await rest(U.owner.token, "DELETE", `/api/requirements/${card.id}/comments`)).status).toBe(404);
    const missing = await mcp(U.nodeA.token, "requirements_comment", { id: "#9999", text: "没有这张卡" });
    expect(missing.error).toBe("requirement_not_found");
    expect(missing.hint).toContain("requirements_list");
  });

  test("discoverable: tools/list carries requirements_comment, and requirements_events mentions comments", async () => {
    const res = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${U.nodeA.token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const raw = await res.text();
    const lines = raw.split("\n").filter(x => x.startsWith("data:"));
    const tools = (lines.length ? JSON.parse(lines.at(-1)!.slice(5).trim()) : JSON.parse(raw)).result.tools as any[];
    const byName = new Map(tools.map(t => [t.name, t]));
    expect(String(byName.get("requirements_comment")?.description)).toContain("append-only");
    expect(String(byName.get("requirements_events")?.description)).toContain("kind=comment");
  });
});
