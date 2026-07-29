// #461 + #462 — HTTP integration tests against the real Bun.serve hub.
//
// Boots a PRIVATE server instance via the #434 seam (`bootServer({ port: 0 })`,
// same signature as PR #438) and derives BASE from the actual bound port.
// This keeps the suite alive in aggregate runs: `await import("./server.js")`
// is a module-cache no-op when another file booted first, so relying on the
// import side effect + own PORT env leaves every fetch ConnectionRefused
// while the tests still "run" (通信龙 #461 review, finding 2). Gate:
//   bun test src/uploads-http.test.ts src/observer-avatar-http.test.ts → 0 fail
//
// #461: GET /events/network/:id observer stream — membership auth incl.
//       member-removal revocation, summary events for third-party traffic
//       (REST dispatch + MCP send_reply), no content leakage.
// #462: PUT /api/nodes/:ref/avatar + GET /api/nodes round trip — persistence,
//       href normalization, XSS-shaped rejects, clear semantics, write gate.

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { register, login, addNetworkMember, removeNetworkMember, createNetworkTokenForNode } from "./auth.js";
import { registerTools } from "./tools.js";
import { db } from "./db.js";

const SERVER_DB = mkdtempSync(join(tmpdir(), "anet-obs-avatar-db-")) + "/commhub.db";

let BASE = "";
let privateServer: any = null;

let memberToken = "";
let memberNetworkId = "";
let memberUserId = "";
let outsiderToken = "";
let outsiderUserId = "";
const TARGET_ALIAS = "obs-target-agent";
const AVATAR_NODE_ID = "node_avatar_test_1";

beforeAll(async () => {
  // Kept for per-file runs launched without an external COMMHUB_DB (the
  // documented contract still is to set it externally; see db-adapter.ts).
  process.env.COMMHUB_DB = process.env.COMMHUB_DB || SERVER_DB;
  process.env.HOST = "127.0.0.1";
  // (#438 corrective: importing server.js is side-effect-free — no
  // default instance, no PORT juggling; only the private bootServer
  // instance below listens.)

  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const pw = "BootstrapPw123Aa!";

  const memberName = `obs_member_${suffix}`;
  let r = register(memberName, pw, undefined, "seed");
  if (!r.ok || !r.token) {
    const lr = login(memberName, pw);
    if (lr.token) { memberToken = lr.token; memberNetworkId = lr.network_id ?? ""; }
  } else {
    memberToken = r.token;
    memberNetworkId = r.network_id ?? "";
  }
  expect(memberToken).toBeTruthy();
  expect(memberNetworkId).toBeTruthy();
  memberUserId = db.get<any>("SELECT user_id FROM users WHERE username = ?1", memberName)?.user_id ?? "";
  expect(memberUserId).toBeTruthy();

  const outsiderName = `obs_outsider_${suffix}`;
  const r2 = register(outsiderName, pw, undefined, "seed");
  if (r2.ok && r2.token) outsiderToken = r2.token;
  expect(outsiderToken).toBeTruthy();
  outsiderUserId = db.get<any>("SELECT user_id FROM users WHERE username = ?1", outsiderName)?.user_id ?? "";
  expect(outsiderUserId).toBeTruthy();

  // Target agent session in the member's network, freshly seen → online.
  db.run(
    `INSERT INTO sessions (resume_id, alias, status, network_id, updated_at, last_seen_at)
     VALUES (?1, ?2, 'idle', ?3, datetime('now'), datetime('now'))`,
    [`resume_${suffix}`, TARGET_ALIAS, memberNetworkId]
  );

  // Node row for the avatar round trip.
  db.run(
    `INSERT OR REPLACE INTO nodes (node_id, node_name, alias, network_id, created_at, updated_at)
     VALUES (?1, 'avatar-test-node', ?2, ?3, datetime('now'), datetime('now'))`,
    [AVATAR_NODE_ID, TARGET_ALIAS, memberNetworkId]
  );

  // Private instance on an OS-assigned port — collision-free by
  // construction (kernel-assigned).
  const mod: any = await import("./server.js");
  privateServer = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${privateServer.port}`;
});

afterAll(() => {
  try { privateServer?.stop?.(true); } catch {}
  try { rmSync(SERVER_DB, { recursive: true, force: true }); } catch {}
});

function auth(token: string): Record<string, string> {
  return { "Authorization": `Bearer ${token}` };
}

/** Read the next SSE data frame from a fetch Response, with timeout. */
async function readFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs = 3_000,
): Promise<Record<string, any>> {
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error(`no SSE frame within ${timeoutMs}ms`)), deadline - Date.now()),
      ),
    ]);
    if (result.done) throw new Error("SSE stream ended unexpectedly");
    buf += decoder.decode(result.value, { stream: true });
    const sep = buf.indexOf("\n\n");
    if (sep === -1) continue;
    const rawFrame = buf.slice(0, sep);
    buf = buf.slice(sep + 2);
    const dataLine = rawFrame.split("\n").find((l) => l.startsWith("data: "));
    if (!dataLine) continue;
    return JSON.parse(dataLine.slice(6));
  }
  throw new Error(`no SSE frame within ${timeoutMs}ms`);
}

describe("#461 GET /events/network/:id — auth", () => {
  test("anonymous → 401", async () => {
    const res = await fetch(`${BASE}/events/network/${memberNetworkId}`);
    expect(res.status).toBe(401);
  });

  test("non-member user token → 403", async () => {
    const res = await fetch(`${BASE}/events/network/${memberNetworkId}`, { headers: auth(outsiderToken) });
    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
  });

  test("member user token → SSE stream with observer connected frame", async () => {
    const res = await fetch(`${BASE}/events/network/${memberNetworkId}`, { headers: auth(memberToken) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") || "").toContain("text/event-stream");
    const reader = res.body!.getReader();
    const connected = await readFrame(reader);
    expect(connected.type).toBe("connected");
    expect(connected.observer).toBe(true);
    expect(connected.network_id).toBe(memberNetworkId);
    await reader.cancel();
  });

  test("membership removal revokes observer access — ntok exploit repro (通信龙 review finding 1)", async () => {
    // Exact repro of the review's exploit: add user C to network A, mint
    // an ntok BOUND to A, remove C from A — the same live ntok must lose
    // the stream. network_members IS the revocation mechanism because
    // removeNetworkMember does not revoke the user's tokens; the old
    // `!role && authCtx.networkId !== observedNetId` OR-form let the
    // token's network binding bypass the membership check (utok would
    // not catch this: its authCtx.networkId is null, so only ntok
    // exercises the vulnerable branch — verified by stubbing the OR
    // back in: THIS test goes red, the utok variants stay green).
    const added = addNetworkMember(memberNetworkId, outsiderUserId, "member");
    expect(added.ok).toBe(true);
    const minted = createNetworkTokenForNode(outsiderUserId, memberNetworkId, "revocation-probe");
    expect(minted.ok).toBe(true);
    const ntok = minted.token!;
    expect(ntok.startsWith("ntok_")).toBe(true);

    const whileMember = await fetch(`${BASE}/events/network/${memberNetworkId}`, { headers: auth(ntok) });
    expect(whileMember.status).toBe(200);
    const reader = whileMember.body!.getReader();
    expect((await readFrame(reader)).type).toBe("connected");
    await reader.cancel();

    const removed = removeNetworkMember(memberNetworkId, outsiderUserId);
    expect(removed.ok).toBe(true);
    // The review's failing probe: /events/network/A with the still-live
    // network-bound token → must now be 403, not 200.
    const afterRemoval = await fetch(`${BASE}/events/network/${memberNetworkId}`, { headers: auth(ntok) });
    expect(afterRemoval.status).toBe(403);
    // utok of the removed user is denied too.
    const utokAfter = await fetch(`${BASE}/events/network/${memberNetworkId}`, { headers: auth(outsiderToken) });
    expect(utokAfter.status).toBe(403);
  });
});

describe("#461 observer receives third-party traffic summaries", () => {
  test("REST /api/task dispatch → observer gets new_task summary, no content", async () => {
    const res = await fetch(`${BASE}/events/network/${memberNetworkId}`, { headers: auth(memberToken) });
    const reader = res.body!.getReader();
    await readFrame(reader); // connected

    const secret = `SECRET-TASK-CONTENT-${Date.now()}`;
    const dispatch = await fetch(`${BASE}/api/task`, {
      method: "POST",
      headers: { ...auth(memberToken), "Content-Type": "application/json" },
      body: JSON.stringify({ alias: TARGET_ALIAS, task: secret, priority: "high", from: "third-party-sender", network_id: memberNetworkId }),
    });
    expect([200, 202]).toContain(dispatch.status);
    const dispatched = await dispatch.json() as any;
    expect(dispatched.task_id).toBeTruthy();

    const evt = await readFrame(reader);
    expect(evt.type).toBe("new_task");
    expect(evt.task_id).toBe(dispatched.task_id);
    expect(evt.from).toBe("third-party-sender");
    expect(evt.to).toBe(TARGET_ALIAS);
    // Online session was seeded → delivered; offline would report queued.
    expect(evt.status).toBe("delivered");
    expect(evt.priority).toBe("high");
    expect(evt.network_id).toBe(memberNetworkId);
    expect(evt.scope).toBe("network");
    // The acceptance line: summary must NOT leak the task body.
    expect(JSON.stringify(evt)).not.toContain(secret);
    await reader.cancel();
  });

  test("MCP send_reply → observer gets new_reply summary, reply text NOT in frame", async () => {
    // Drive the REAL registered MCP handler (same interception pattern as
    // ack-create-request.test.ts) with the member's network enforced, and
    // read the observer stream over real HTTP.
    const res = await fetch(`${BASE}/events/network/${memberNetworkId}`, { headers: auth(memberToken) });
    const reader = res.body!.getReader();
    await readFrame(reader); // connected

    const tools: Record<string, (args: any) => Promise<any>> = {};
    const mcp = new McpServer({ name: "test", version: "0" }) as any;
    mcp.tool = (name: string, _desc: string, _schema: any, handler: any) => { tools[name] = handler; };
    registerTools(mcp, undefined, memberNetworkId, memberUserId);
    expect(typeof tools["send_reply"]).toBe("function");

    const secret = `SECRET-REPLY-TEXT-${Date.now()}`;
    const result = await tools["send_reply"]({
      alias: TARGET_ALIAS,
      text: secret,
      status: "replied",
      from_session: "reply-worker",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);

    const evt = await readFrame(reader);
    expect(evt.type).toBe("new_reply");
    expect(evt.from).toBe("reply-worker");
    expect(evt.to).toBe(TARGET_ALIAS);
    expect(evt.status).toBe("replied");
    expect(evt.message_id).toBe(parsed.message_id);
    expect(evt.network_id).toBe(memberNetworkId);
    expect(JSON.stringify(evt)).not.toContain(secret);
    await reader.cancel();
  });
});

describe("#462 PUT /api/nodes/:ref/avatar + GET /api/nodes", () => {
  test("set avatar → 200, GET /api/nodes returns it (cross-device persistence)", async () => {
    const avatarUrl = "https://cdn.example.com/avatars/custom-1.png";
    const put = await fetch(`${BASE}/api/nodes/${AVATAR_NODE_ID}/avatar`, {
      method: "PUT",
      headers: { ...auth(memberToken), "Content-Type": "application/json" },
      body: JSON.stringify({ avatar_url: avatarUrl }),
    });
    expect(put.status).toBe(200);
    const putBody = await put.json() as any;
    expect(putBody.ok).toBe(true);
    expect(putBody.avatar_url).toBe(avatarUrl);

    const list = await fetch(`${BASE}/api/nodes?node_id=${AVATAR_NODE_ID}`, { headers: auth(memberToken) });
    expect(list.status).toBe(200);
    const listBody = await list.json() as any;
    expect(listBody.ok).toBe(true);
    const row = listBody.nodes.find((n: any) => n.node_id === AVATAR_NODE_ID);
    expect(row).toBeTruthy();
    expect(row.avatar_url).toBe(avatarUrl);
    // #312 discipline still holds — internals must not leak.
    expect("config_snapshot" in row).toBe(false);
  });

  test("markup-hostile chars are stored NORMALIZED (href), not raw (通信龙 review finding 3)", async () => {
    const put = await fetch(`${BASE}/api/nodes/${AVATAR_NODE_ID}/avatar`, {
      method: "PUT",
      headers: { ...auth(memberToken), "Content-Type": "application/json" },
      body: JSON.stringify({ avatar_url: 'https://cdn.example.com/a"b.png' }),
    });
    expect(put.status).toBe(200);
    const putBody = await put.json() as any;
    expect(putBody.avatar_url).toBe("https://cdn.example.com/a%22b.png");
    const row = db.get<any>("SELECT avatar_url FROM nodes WHERE node_id = ?1", AVATAR_NODE_ID);
    expect(row.avatar_url).toBe("https://cdn.example.com/a%22b.png");
    expect(row.avatar_url).not.toContain('"');
  });

  test("clear avatar with null → avatar_url null in list", async () => {
    const put = await fetch(`${BASE}/api/nodes/${AVATAR_NODE_ID}/avatar`, {
      method: "PUT",
      headers: { ...auth(memberToken), "Content-Type": "application/json" },
      body: JSON.stringify({ avatar_url: null }),
    });
    expect(put.status).toBe(200);
    const list = await fetch(`${BASE}/api/nodes?node_id=${AVATAR_NODE_ID}`, { headers: auth(memberToken) });
    const listBody = await list.json() as any;
    const row = listBody.nodes.find((n: any) => n.node_id === AVATAR_NODE_ID);
    expect(row.avatar_url).toBeNull();
  });

  test("javascript: URL → 400 invalid_avatar_url, value NOT persisted", async () => {
    const put = await fetch(`${BASE}/api/nodes/${AVATAR_NODE_ID}/avatar`, {
      method: "PUT",
      headers: { ...auth(memberToken), "Content-Type": "application/json" },
      body: JSON.stringify({ avatar_url: "javascript:alert(1)" }),
    });
    expect(put.status).toBe(400);
    const body = await put.json() as any;
    expect(body.error).toBe("invalid_avatar_url");
    const row = db.get<any>("SELECT avatar_url FROM nodes WHERE node_id = ?1", AVATAR_NODE_ID);
    expect(row.avatar_url ?? null).toBeNull();
  });

  test("data: URL → 400", async () => {
    const put = await fetch(`${BASE}/api/nodes/${AVATAR_NODE_ID}/avatar`, {
      method: "PUT",
      headers: { ...auth(memberToken), "Content-Type": "application/json" },
      body: JSON.stringify({ avatar_url: "data:text/html,<script>alert(1)</script>" }),
    });
    expect(put.status).toBe(400);
  });

  test("anonymous → 401; non-member → 404/403 (network-scoped lookup)", async () => {
    const anon = await fetch(`${BASE}/api/nodes/${AVATAR_NODE_ID}/avatar`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ avatar_url: "https://example.com/x.png" }),
    });
    expect(anon.status).toBe(401);

    // Outsider's network scope can't even see the node → 404 (or 403 if
    // visibility rules change later; both deny the write).
    const outsider = await fetch(`${BASE}/api/nodes/${AVATAR_NODE_ID}/avatar`, {
      method: "PUT",
      headers: { ...auth(outsiderToken), "Content-Type": "application/json" },
      body: JSON.stringify({ avatar_url: "https://example.com/x.png" }),
    });
    expect([403, 404]).toContain(outsider.status);
    const row = db.get<any>("SELECT avatar_url FROM nodes WHERE node_id = ?1", AVATAR_NODE_ID);
    expect(row.avatar_url ?? null).toBeNull();
  });
});
