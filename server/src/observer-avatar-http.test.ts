// #461 + #462 — HTTP integration tests against the real Bun.serve hub.
//
// Pattern mirrors uploads-http.test.ts / api-host-supervisors-fallback:
// temp DB + ephemeral port, `import("./index.js")` side effect boots the
// server, real fetch() against the production code path (auth included).
//
// #461: GET /events/network/:id observer stream — membership auth, summary
//       events for third-party REST dispatches, no content leakage.
// #462: PUT /api/nodes/:ref/avatar + GET /api/nodes round trip — persistence,
//       XSS-shaped rejects, clear semantics, write-permission gate.

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register, login } from "./auth.js";
import { db } from "./db.js";

const SERVER_DB = mkdtempSync(join(tmpdir(), "anet-obs-avatar-db-")) + "/commhub.db";
const PORT = 17000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;

let memberToken = "";
let memberNetworkId = "";
let outsiderToken = "";
const TARGET_ALIAS = "obs-target-agent";
const AVATAR_NODE_ID = "node_avatar_test_1";

beforeAll(async () => {
  process.env.COMMHUB_DB = SERVER_DB;
  process.env.PORT = String(PORT);
  process.env.HOST = "127.0.0.1";

  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const pw = "BootstrapPw123Aa!";

  let r = register(`obs_member_${suffix}`, pw, undefined, "seed");
  if (!r.ok || !r.token) {
    const lr = login(`obs_member_${suffix}`, pw);
    if (lr.token) { memberToken = lr.token; memberNetworkId = lr.network_id ?? ""; }
  } else {
    memberToken = r.token;
    memberNetworkId = r.network_id ?? "";
  }
  expect(memberToken).toBeTruthy();
  expect(memberNetworkId).toBeTruthy();

  const r2 = register(`obs_outsider_${suffix}`, pw, undefined, "seed");
  if (r2.ok && r2.token) outsiderToken = r2.token;
  expect(outsiderToken).toBeTruthy();

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

  await import("./index.js");
  await new Promise((r) => setTimeout(r, 100));
});

afterAll(() => {
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
});

describe("#461 observer receives third-party dispatch summaries", () => {
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
    expect(evt.status).toBe("delivered");
    expect(evt.priority).toBe("high");
    expect(evt.network_id).toBe(memberNetworkId);
    expect(evt.scope).toBe("network");
    // The acceptance line: summary must NOT leak the task body.
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
