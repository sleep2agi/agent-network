// GET /api/stats/routes?by=caller — per-route caller classes (token kind + User-Agent family).
// Production serves the full GET /api/status ~2.8/s and every caller arrives as 127.0.0.1 through the
// frp tunnel, with no access log; this breakdown is how we tell who it is. Pinned over real HTTP:
//   - without by=caller the body is byte-for-byte what routeStats() produced before this change;
//   - with it, each route carries callers [{class, count, bytes}] counted per class;
//   - no token, user id, node id, username or raw User-Agent text ever reaches the output;
//   - distinct classes per route are capped, the rest folded into "(other)";
//   - still admin-only.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROUTE_MAX_CALLERS_PER_ROUTE, ROUTE_OVERFLOW_KEY, routeStats } from "./route-timing.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-route-callers-"));
process.env.HOME = DIR;
process.env.COMMHUB_DB ||= join(DIR, "hub.db");
process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");

const PW = "RouteCallersPassw0rd!";
const NODE_ID = "node_route_callers_probe";
const NODE_NAME = "rc-probe-node";
const UA_MARKER = "zz-ua-marker-41c9";
let BASE = "";
let hub: any = null;
let admin = "";
let adminId = "";
let adminName = "";
let member = "";
let ntok = "";

const get = (path: string, headers: Record<string, string> = {}) => fetch(`${BASE}${path}`, { headers });
const auth = (token: string, ua?: string) => ({ Authorization: `Bearer ${token}`, ...(ua === undefined ? {} : { "User-Agent": ua }) });
async function byCaller(): Promise<{ text: string; rows: any[] }> {
  const res = await get("/api/stats/routes?minutes=5&by=caller", auth(admin));
  expect(res.status).toBe(200);
  const text = await res.text();
  return { text, rows: JSON.parse(text).routes };
}

beforeAll(async () => {
  process.env.HOST = "127.0.0.1";
  const { register, createNetworkTokenForNode } = await import("./auth.js");
  const { db } = await import("./db.js");
  adminName = `rc_admin_${Date.now()}`;
  const a = register(adminName, PW);
  admin = a.token!;
  adminId = a.user!.user_id;
  db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [adminId]);
  member = register(`rc_member_${Date.now()}`, PW).token!;
  const minted = createNetworkTokenForNode(adminId, a.network_id!, NODE_NAME, NODE_ID);
  expect(minted.ok).toBe(true);
  ntok = minted.token!;
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("GET /api/stats/routes?by=caller", () => {
  test("without by=caller the body is exactly the pre-existing routeStats() output", async () => {
    await get("/api/status", auth(admin, "node"));
    await get("/api/status?light=1", auth(ntok, "agent-node/2.5.0-preview.88"));
    // The stats request is recorded only after its body is built, so nothing lands between these two.
    const expected = JSON.stringify({ ok: true, ...routeStats(5 * 60_000) });
    const res = await get("/api/stats/routes?minutes=5", auth(admin));
    expect(await res.text()).toBe(expected);
    const body = JSON.parse(expected);
    expect(Object.keys(body)).toEqual(["ok", "window_ms", "samples", "oldest_at", "routes"]);
    for (const r of body.routes) expect(Object.keys(r)).toEqual(["route", "count", "total_ms", "avg_ms", "p95_ms", "max_ms", "bytes", "errors"]);
  });

  test("callers are counted per class: token kind + UA family", async () => {
    const before = (await byCaller()).rows.find(r => r.route === "GET /api/status")?.callers ?? [];
    const count = (cs: any[], cls: string) => cs.find(c => c.class === cls)?.count ?? 0;
    for (let i = 0; i < 3; i++) expect((await get("/api/status", auth(member, "node"))).status).toBe(200);
    await get("/api/status", auth(ntok, `agent-node/2.5.0-preview.88 (${UA_MARKER})`));
    await get("/api/status", auth(member, `Mozilla/5.0 (X11; ${UA_MARKER}) Chrome/130.0`));
    await get("/api/status", { "User-Agent": "curl/8.5.0" }); // anonymous → 401, still counted
    const row = (await byCaller()).rows.find(r => r.route === "GET /api/status")!;
    const callers = row.callers as any[];
    expect(count(callers, "user node") - count(before, "user node")).toBe(3);
    expect(count(callers, "node agent-node/2.5.0-preview.88") - count(before, "node agent-node/2.5.0-preview.88")).toBe(1);
    expect(count(callers, "user browser") - count(before, "user browser")).toBe(1);
    expect(count(callers, "anon curl/8.5.0") - count(before, "anon curl/8.5.0")).toBe(1);
    expect(callers.reduce((n: number, c: any) => n + c.count, 0)).toBe(row.count);
    expect(callers.reduce((n: number, c: any) => n + c.bytes, 0)).toBe(row.bytes);
    for (const c of callers) expect(Object.keys(c)).toEqual(["class", "count", "bytes"]);
  });

  test("no token, id, username or raw User-Agent text in the output", async () => {
    await get(`/api/status?token=${ntok}`, { "User-Agent": `${UA_MARKER}/1.0` });
    const { text, rows } = await byCaller();
    for (const secret of [admin, member, ntok, adminId, adminName, NODE_ID, NODE_NAME, UA_MARKER, "Mozilla", "X11", "127.0.0.1", "ntok_", "utok_"]) {
      expect(text).not.toContain(secret);
    }
    const classes = rows.flatMap(r => r.callers.map((c: any) => c.class));
    expect(classes).toContain("node other");
    for (const cls of classes) expect(cls).toMatch(/^(\(other\)|(node|user|master|token|anon) [a-z0-9._-]+(\/[0-9A-Za-z.-]+)?)$/);
  });

  test("distinct classes per route are capped, the rest folded into (other)", async () => {
    const n = ROUTE_MAX_CALLERS_PER_ROUTE + 5;
    for (let i = 0; i < n; i++) await get("/api/networks", auth(member, `curl/${i}.0.0`));
    const row = (await byCaller()).rows.find(r => r.route === "GET /api/networks")!;
    expect(row.callers.length).toBe(ROUTE_MAX_CALLERS_PER_ROUTE);
    expect(row.callers.at(-1).class).toBe(ROUTE_OVERFLOW_KEY);
    expect(row.callers.reduce((s: number, c: any) => s + c.count, 0)).toBe(row.count);
  });

  test("still admin-only", async () => {
    expect((await get("/api/stats/routes?by=caller", auth(member))).status).toBe(403);
    expect((await get("/api/stats/routes?by=caller", auth(ntok))).status).toBe(403);
  });
});
