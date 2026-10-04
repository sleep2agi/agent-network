// #552 — every rejected REST POST /api/task leaves exactly one hub log line.
//
// Incident: a restricted member's app sends were refused and the hub log
// showed nothing, so "never arrived" and "rejected" were indistinguishable.
// Real Bun.serve on a private port + temp DB; console.log is captured around
// each request. The line must carry status + error + user + requested
// alias/network/client_request_id, and must NOT carry the bearer token or the
// task text.

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register } from "./auth.js";
import { db } from "./db.js";
import { formatTaskRejection } from "./task-rejection-log.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-task-reject-log-"));
let BASE = "";
let hub: any = null;
const PW = "RejectLogPassw0rd!x";
let adminToken = "";
let adminName = "";
let NET = "";
let aliceToken = "";
const AGENT = { alias: "rejlog-agent", node: "node_rejlog" };
const SECRET_TEXT = "TOP-SECRET-TASK-BODY-552";

async function postTask(token: string | null, body: string): Promise<{ status: number; json: any; lines: string[] }> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: any[]) => { lines.push(args.map(String).join(" ")); };
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${BASE}/api/task`, { method: "POST", headers, body });
    const text = await res.text();
    let json: any = text;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, lines };
  } finally {
    console.log = orig;
  }
}
const rejectedLines = (lines: string[]) => lines.filter(l => l.includes("→ /api/task →") && l.includes("REJECTED"));

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";

  const admin = register(`rejlog_admin_${Date.now()}`, PW, undefined, "Admin");
  expect(admin.ok).toBe(true);
  adminToken = admin.token!;
  adminName = admin.user!.username;
  NET = admin.network_id!;
  db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [admin.user!.user_id]);
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, owner_user_id, updated_at) VALUES (?1, ?2, ?2, ?3, ?4, datetime('now'))`,
    [AGENT.node, AGENT.alias, NET, admin.user!.user_id],
  );
  db.run(
    `INSERT INTO sessions (resume_id, alias, node_id, status, network_id, updated_at, last_seen_at)
     VALUES (?1, ?2, ?3, 'idle', ?4, datetime('now'), datetime('now'))`,
    [`resume_${AGENT.node}`, AGENT.alias, AGENT.node, NET],
  );

  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;

  // A restricted member (default agent_access='granted', zero grants) who also
  // owns a personal network → two memberships, like the #552 app user.
  const created = await fetch(`${BASE}/api/admin/users`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ username: "rejlog_alice", password: PW, network_id: NET, role: "member" }),
  });
  expect(created.status).toBe(200);
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "rejlog_alice", password: PW }),
  });
  expect(login.status).toBe(200);
  aliceToken = (await login.json() as any).token;
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

function assertNoSecrets(line: string, token: string) {
  expect(line).not.toContain(token);
  expect(line).not.toContain(SECRET_TEXT);
  expect(line).not.toContain("file_");
}

describe("#552 REST POST /api/task rejections are logged", () => {
  test("alias_not_found (404): one line with status, error, user, alias, network, client_request_id", async () => {
    const r = await postTask(adminToken, JSON.stringify({ alias: "no-such-agent", task: SECRET_TEXT, network_id: NET, meta: { client_request_id: "crid-552-a" } }));
    expect(r.status).toBe(404);
    expect(r.json.error).toBe("alias_not_found");
    const lines = rejectedLines(r.lines);
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/^\[\d\d:\d\d:\d\d\] /);
    expect(lines[0]).toContain(`${adminName} → /api/task → no-such-agent: REJECTED 404 alias_not_found`);
    expect(lines[0]).toContain(`net=${NET}`);
    expect(lines[0]).toContain("crid=crid-552-a");
    assertNoSecrets(lines[0], adminToken);
  });

  test("network_id_required (400) for a member of two networks who omits network_id", async () => {
    const r = await postTask(aliceToken, JSON.stringify({ alias: AGENT.alias, task: SECRET_TEXT }));
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("network_id_required");
    const lines = rejectedLines(r.lines);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain(`rejlog_alice → /api/task → ${AGENT.alias}: REJECTED 400 network_id_required (net=-)`);
    assertNoSecrets(lines[0], aliceToken);
  });

  test("agent_not_granted (403) — the restricted-member case from #552", async () => {
    const r = await postTask(aliceToken, JSON.stringify({ alias: AGENT.alias, task: SECRET_TEXT, network_id: NET, attachments: [{ file_id: "file_deadbeef" }] }));
    expect(r.status).toBe(403);
    expect(r.json.error).toBe("agent_not_granted");
    const lines = rejectedLines(r.lines);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain(`rejlog_alice → /api/task → ${AGENT.alias}: REJECTED 403 agent_not_granted (net=${NET})`);
    assertNoSecrets(lines[0], aliceToken);
  });

  test("invalid JSON (400) is logged with the user and '-' placeholders", async () => {
    const r = await postTask(aliceToken, "{not json");
    expect(r.status).toBe(400);
    const lines = rejectedLines(r.lines);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("rejlog_alice → /api/task → -: REJECTED 400 invalid JSON (net=-)");
  });

  test("a successful send logs no REJECTED line", async () => {
    const r = await postTask(adminToken, JSON.stringify({ alias: AGENT.alias, task: "hello", network_id: NET }));
    expect(r.status).toBe(200);
    expect(rejectedLines(r.lines).length).toBe(0);
  });
});

describe("formatTaskRejection", () => {
  test("request-supplied values cannot inject extra log lines and are clipped", () => {
    const line = formatTaskRejection({
      status: 404, error: "alias_not_found", username: null,
      body: { alias: "evil\n[00:00:00] admin → forged", network_id: "n".repeat(200), meta: { client_request_id: "x\r\ny" } },
    });
    expect(line).not.toContain("\n");
    expect(line).not.toContain("\r");
    expect(line).toContain("anon → /api/task → evil [00:00:00] admin → forged: REJECTED 404 alias_not_found");
    expect(line).toContain(`net=${"n".repeat(64)}…`);
    expect(line).toContain("crid=x y");
  });
});
