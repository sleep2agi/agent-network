// #473 — /health information-leak redaction.
//
// Public-hub audit (通信龙, 2026-07-30) showed anonymous GET /health
// returning the full SSE key breakdown: `{networkId}:{alias}` for every
// live connection — network id + all 95 agent aliases on the audited
// hub. The fix keeps /health anonymous (HARD CONSTRAINT: the central
// watchdog curls it every minute; auth here would blind it) but strips
// the per-key detail down to aggregate counts; the detail moved behind
// auth at GET /api/stats/sse (master token or admin only).
//
// Witnessed-red: on pre-fix main (8c11edf5) the "no leak" test below is
// red — the /health body contains the connected alias and network id.

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register } from "./auth.js";
import { db } from "./db.js";

const SERVER_DB = mkdtempSync(join(tmpdir(), "anet-health-red-db-")) + "/commhub.db";

let BASE = "";
let server: any = null;
let sseReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

let userToken = "";
let userNetworkId = "";
let userName = "";
let adminToken = "";

beforeAll(async () => {
  process.env.COMMHUB_DB = process.env.COMMHUB_DB || SERVER_DB;
  process.env.HOST = "127.0.0.1";

  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const pw = "BootstrapPw123Aa!";

  // Burn a seed registration first so our member is NOT auto-admin (the
  // "first registered user → admin" rule only bites when this suite owns
  // the DB; per-file runs need this guard). We set roles explicitly below.
  register(`health_seed_${suffix}`, pw, undefined, "seed");

  userName = `health_user_${suffix}`;
  const r = register(userName, pw, undefined, "seed");
  if (!r.ok || !r.token) throw new Error("register failed: " + JSON.stringify(r));
  userToken = r.token;
  userNetworkId = r.network_id ?? "";
  if (!userNetworkId) throw new Error("no network for user");
  // Pin to plain member — defend against any residual auto-admin.
  db.run("UPDATE users SET role = 'user' WHERE username = ?1", [userName]);

  const adminName = `health_admin_${suffix}`;
  const a = register(adminName, pw, undefined, "seed");
  if (!a.ok || !a.token) throw new Error("admin register failed: " + JSON.stringify(a));
  adminToken = a.token;
  // Explicit promotion — "first registered user is auto-admin" does not
  // hold in aggregate runs (see api-host-supervisors-fallback.test.ts).
  db.run("UPDATE users SET role = 'admin' WHERE username = ?1", [adminName]);

  const { bootServer } = await import("./server.js");
  server = bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${server.port}`;

  // Open a real SSE connection so the stats have a key that WOULD leak:
  // the dashboard-user channel (sessionName === own username, Path 3
  // gate 4a) registers `${networkId}:${username}` in the clients map.
  const res = await fetch(`${BASE}/events/${encodeURIComponent(userName)}?network_id=${userNetworkId}`, {
    headers: { Authorization: `Bearer ${userToken}` },
  });
  if (res.status !== 200) throw new Error("SSE subscribe failed: " + res.status);
  sseReader = res.body!.getReader();
  await sseReader.read(); // consume the connected frame → registration done
});

afterAll(() => {
  try { sseReader?.cancel(); } catch {}
  try { server?.stop?.(true); } catch {}
  try { rmSync(SERVER_DB, { recursive: true, force: true }); } catch {}
});

describe("#473 anonymous /health — watchdog contract intact, no topology leak", () => {
  test("stays anonymous 200 with parseable aggregates (watchdog judge: curl -sf gets 2xx)", async () => {
    const res = await fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe("string");
    expect(typeof body.sessions_count).toBe("number");
    expect(typeof body.sse_connections).toBe("number");
    expect(body.sse_connections).toBeGreaterThanOrEqual(1);
  });

  test("CLI count source stays truthful: health.sse_connections == /api/stats/sse total (no fake 0)", async () => {
    // The CLI's `anet doctor` line reads health.sse_connections now
    // (was Object.keys(sse_sessions).length). This pins that aggregate to
    // the same number the auth-gated detail endpoint reports — so a live
    // hub with N connections shows N, never the "0 active" regression the
    // review caught. There is exactly one live SSE connection in setup.
    const health = await (await fetch(`${BASE}/health`)).json() as any;
    const detail = await (await fetch(`${BASE}/api/stats/sse`, { headers: { Authorization: `Bearer ${adminToken}` } })).json() as any;
    expect(health.sse_connections).toBe(detail.total);
    expect(health.sse_connections).toBeGreaterThanOrEqual(1);
  });

  test("does NOT expose SSE key detail: no sse_sessions field, no alias, no network id", async () => {
    const res = await fetch(`${BASE}/health`);
    const text = await res.text();
    const body = JSON.parse(text);
    expect("sse_sessions" in body).toBe(false);
    // The live connection's identifying strings must not appear anywhere
    // in the anonymous body.
    expect(text).not.toContain(userName);
    expect(text).not.toContain(userNetworkId);
  });
});

describe("f28a6c1b /health sse_sessions — auth-gated restoration for dashboard 'online' widget", () => {
  // The dashboard's server-side Next.js proxy (agent-network-dashboard
  // `app/api/hub/health/route.ts` → `hubFetch('/health')`) forwards the
  // logged-in user's V3 utok_ as `Authorization: Bearer …`. Anonymous
  // callers (public watchdog, internet strangers) still get NO
  // sse_sessions — that leak stays closed. Authenticated callers get
  // the sessions map scoped to their networks (ops sees all).

  test("regular member with valid utok_: sse_sessions present, filtered to member's networks", async () => {
    const res = await fetch(`${BASE}/health`, {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    // Field must be present when authenticated — otherwise dashboard
    // "online" widget shows 0.
    expect("sse_sessions" in body).toBe(true);
    // Must contain the member's own SSE connection key.
    const ownKey = `${userNetworkId}:${userName}`;
    expect(body.sse_sessions[ownKey]).toBeGreaterThanOrEqual(1);
    // Watchdog aggregate contract unchanged.
    expect(body.sse_connections).toBeGreaterThanOrEqual(1);
  });

  test("admin with valid utok_: sse_sessions present, full unfiltered map (ops parity with /api/stats/sse)", async () => {
    const res = await fetch(`${BASE}/health`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect("sse_sessions" in body).toBe(true);
    // Admin sees the member's key even though they live in a different
    // network (admin scope spans everything, same as /api/stats/sse).
    const memberKey = `${userNetworkId}:${userName}`;
    expect(body.sse_sessions[memberKey]).toBeGreaterThanOrEqual(1);
    // Sanity: admin's view must match the auth-gated ops endpoint.
    const opsRes = await fetch(`${BASE}/api/stats/sse`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const ops = await opsRes.json() as any;
    expect(body.sse_sessions).toEqual(ops.sessions);
  });

  test("anonymous still gets NO sse_sessions (leak stays closed, mutation-red witness)", async () => {
    // This is the mutation-red assertion for the auth gate: if the
    // handler stops distinguishing anonymous from authenticated and
    // starts including sse_sessions unconditionally, this test turns
    // RED. Distinct from the older `does NOT expose SSE key detail`
    // test — that one guards against any regression restoring the
    // OLD unconditional leak; this one guards against a well-meaning
    // "just always send it if authenticated is optional" bug.
    const res = await fetch(`${BASE}/health`);
    const body = await res.json() as any;
    expect("sse_sessions" in body).toBe(false);
  });

  test("invalid/garbage token: treated as anonymous — no sse_sessions", async () => {
    const res = await fetch(`${BASE}/health`, {
      headers: { Authorization: "Bearer utok_completely_fake_nonexistent" },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    // resolveRequestAuth returns null for unresolvable tokens, so the
    // handler must NOT fall through to "authenticated" branch. Otherwise
    // a bad token would degrade to "anonymous with sse_sessions" — that
    // would be the leak in a different disguise.
    expect("sse_sessions" in body).toBe(false);
  });
});

describe("#473 GET /api/stats/sse — detail survives, behind ops auth", () => {
  test("anonymous → 401", async () => {
    const res = await fetch(`${BASE}/api/stats/sse`);
    expect(res.status).toBe(401);
  });

  test("regular member token → 403 (detail spans every network)", async () => {
    const res = await fetch(`${BASE}/api/stats/sse`, { headers: { Authorization: `Bearer ${userToken}` } });
    expect(res.status).toBe(403);
  });

  test("admin → 200 with the full key breakdown (ops capability preserved)", async () => {
    const res = await fetch(`${BASE}/api/stats/sse`, { headers: { Authorization: `Bearer ${adminToken}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(typeof body.total).toBe("number");
    expect(body.sessions[`${userNetworkId}:${userName}`]).toBeGreaterThanOrEqual(1);
  });

  test("legacy master token → 200 (ops path — restAuth null, isLegacyAuthToken)", () => {
    // COMMHUB_AUTH_TOKEN is captured at module import, so this path needs
    // a fresh process with the env set before boot (aggregate order can't
    // guarantee this file imports server.ts first). Subprocess, like the
    // patrol test. Reviewer flagged this path had code but no test.
    const script = `
      process.env.COMMHUB_AUTH_TOKEN = "master-secret-xyz";
      const { startHub } = await import("./src/server.js");
      const hub = startHub({ port: 0, hostname: "127.0.0.1" });
      const base = "http://127.0.0.1:" + hub.port;
      const anon = await fetch(base + "/api/stats/sse");
      const master = await fetch(base + "/api/stats/sse", { headers: { Authorization: "Bearer master-secret-xyz" } });
      const health = await fetch(base + "/health");
      const hb = await health.json();
      console.log("RESULT:" + JSON.stringify({
        anon: anon.status,
        master: master.status,
        masterOk: (await master.json()).ok,
        healthHasSseSessions: "sse_sessions" in hb,
      }));
      hub.stop(true);
      process.exit(0);
    `;
    const child = Bun.spawnSync({
      cmd: ["bun", "-e", script],
      cwd: `${import.meta.dir}/..`,
      env: { ...process.env, COMMHUB_DB: process.env.COMMHUB_DB || "/tmp/anet-473-master.db" },
      timeout: 15_000,
    });
    const out = new TextDecoder().decode(child.stdout);
    const m = out.match(/RESULT:(\{.*\})/);
    expect(m).not.toBeNull();
    const r = JSON.parse(m![1]);
    expect(r.anon).toBe(401);        // token configured → anonymous rejected
    expect(r.master).toBe(200);      // legacy master token → ops access
    expect(r.masterOk).toBe(true);
    expect(r.healthHasSseSessions).toBe(false); // /health still redacted with a token set
  }, 20_000);
});
