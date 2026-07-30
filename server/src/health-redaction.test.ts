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
import { register, addNetworkMember, removeNetworkMember } from "./auth.js";
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

// ─────────────────────────────────────────────────────────────────────
// CR3 (4703b0e7) — M1-M7 matrix tests
// ─────────────────────────────────────────────────────────────────────
//
// Independent audit on aef48a3d showed the existing f28a6c1b tests
// pinned only the "anonymous vs authenticated" gate. The reviewer
// mutated `scopedSessions = sse.sessions` (unconditional) and got
// 11/11 green — meaning the *tenant-scope* invariant (a member sees
// only their own networks, cross-network is invisible) was not
// witnessed by any assertion, and a future refactor that broke the
// filter would ship silently.
//
// This block adds explicit tests for every shape the fork's auth
// decision distinguishes:
//   M1: utok_ member sees own network's sessions
//   M2: utok_ member does NOT see other network's sessions
//   M3: ntok_ (network-scoped token) is forced to the token's bound
//       network — the user's other networks are invisible even
//       though the underlying user is a member
//   M4: same user, utok_ vs ntok_ — utok_ sees union, ntok_ sees only
//       the token's bound network (mutation-red for the ntok_
//       "healthAuth.networkId ? [...] : db.all(...)" branch)
//   M5: membership revocation invalidates visibility immediately —
//       no cache; the next /health request reflects new membership
//   M6: observer keys (shape `\0netobs:<networkId>`; the getSSEStats
//       serializer renders leading NUL as printable `\\0`) are
//       classified through the shared PRINTABLE_OBSERVER_KEY_PREFIX
//       constant, not a re-typed literal. Mutation-red for the
//       constant drift (server.ts had `"netobs:"` without `\\0`
//       before this CR, so all observer keys silently fell through).
//   M7: two networks with the same alias — invisibility survives
//       key collision. Explicit assertion; M1/M2 hide-cover this
//       implicitly but M7 makes the property visible in review.
describe("f28a6c1b CR3 — network-scoped filter matrix (M1-M7)", () => {
  let mUserAToken = "";
  let mUserANet = "";
  let mUserAName = "";
  let mUserBToken = "";
  let mUserBNet = "";
  let mUserBName = "";
  let mAliceToken = "";       // utok_ (user-scoped)
  let mAliceNtok = "";        // ntok_ bound to mAliceNet
  let mAliceNet = "";
  let mAliceName = "";
  let mCarolToken = "";
  let mCarolNet = "";
  let mCarolName = "";
  let mUserAId = "";
  let mAliceId = "";
  let mCarolId = "";
  let mSameAliasName = "";    // used by M7 — two sessions, one per network

  const openReaders: ReadableStreamDefaultReader<Uint8Array>[] = [];

  const startSse = async (base: string, name: string, netId: string, token: string) => {
    const res = await fetch(`${base}/events/${encodeURIComponent(name)}?network_id=${netId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status !== 200) throw new Error(`SSE subscribe failed (${res.status}) for ${name}@${netId}`);
    const reader = res.body!.getReader();
    await reader.read();
    openReaders.push(reader);
    return reader;
  };

  const startObserverSse = async (base: string, netId: string, token: string) => {
    // The observer endpoint is /events/network/:networkId — carries no
    // per-agent alias; server registers with the special observer key
    // shape `\0netobs:<networkId>` (see push.ts observerKey()).
    const res = await fetch(`${base}/events/network/${encodeURIComponent(netId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status !== 200) throw new Error(`observer SSE subscribe failed (${res.status}) for ${netId}`);
    const reader = res.body!.getReader();
    await reader.read();
    openReaders.push(reader);
    return reader;
  };

  beforeAll(async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const pw = "BootstrapPw123Aa!";

    // userA — own network, plain member
    mUserAName = `cr3_userA_${suffix}`;
    const rA = register(mUserAName, pw, undefined, "seed");
    if (!rA.ok || !rA.token || !rA.network_id) throw new Error("userA register failed");
    mUserAToken = rA.token;
    mUserANet = rA.network_id;
    db.run("UPDATE users SET role = 'user' WHERE username = ?1", [mUserAName]);
    mUserAId = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", [mUserAName])!.user_id;

    // userB — different own network, plain member
    mUserBName = `cr3_userB_${suffix}`;
    const rB = register(mUserBName, pw, undefined, "seed");
    if (!rB.ok || !rB.token || !rB.network_id) throw new Error("userB register failed");
    mUserBToken = rB.token;
    mUserBNet = rB.network_id;
    db.run("UPDATE users SET role = 'user' WHERE username = ?1", [mUserBName]);

    // alice — own network + will also be added to userA's N_A, so
    // membership set = { mAliceNet (owner), mUserANet (member) }.
    // Her ntok_ (from register) is bound to mAliceNet only — the M3/M4
    // scope-enforcement test target.
    mAliceName = `cr3_alice_${suffix}`;
    const rAl = register(mAliceName, pw, undefined, "seed");
    if (!rAl.ok || !rAl.token || !rAl.network_token || !rAl.network_id) throw new Error("alice register failed");
    mAliceToken = rAl.token;
    mAliceNtok = rAl.network_token;
    mAliceNet = rAl.network_id;
    db.run("UPDATE users SET role = 'user' WHERE username = ?1", [mAliceName]);
    mAliceId = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", [mAliceName])!.user_id;
    const addAlice = addNetworkMember(mUserANet, mAliceId, "member", mUserAId);
    if (!addAlice.ok) throw new Error("addNetworkMember(alice→N_A) failed: " + addAlice.error);

    // carol — own network + will also be added to N_A, then revoked
    // in M5.
    mCarolName = `cr3_carol_${suffix}`;
    const rC = register(mCarolName, pw, undefined, "seed");
    if (!rC.ok || !rC.token || !rC.network_id) throw new Error("carol register failed");
    mCarolToken = rC.token;
    mCarolNet = rC.network_id;
    db.run("UPDATE users SET role = 'user' WHERE username = ?1", [mCarolName]);
    mCarolId = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", [mCarolName])!.user_id;
    const addCarol = addNetworkMember(mUserANet, mCarolId, "member", mUserAId);
    if (!addCarol.ok) throw new Error("addNetworkMember(carol→N_A) failed: " + addCarol.error);

    // Live SSE sessions — one per network — so the filter has real
    // keys to include/exclude.
    await startSse(BASE, mUserAName, mUserANet, mUserAToken);
    await startSse(BASE, mUserBName, mUserBNet, mUserBToken);
    await startSse(BASE, mAliceName, mAliceNet, mAliceToken);
    await startSse(BASE, mCarolName, mCarolNet, mCarolToken);

    // M6 — observer stream for N_A (produces `\0netobs:<mUserANet>` key)
    await startObserverSse(BASE, mUserANet, mUserAToken);

    // M7 note: The dashboard-user SSE gate only lets a caller subscribe
    // as their own username (path 3, gate 4a). Standing up two sessions
    // named the same alias in two different networks would need two
    // separate "helper" users per network — significantly larger setup
    // than the property we're testing. M1/M2 already witness the shape
    // invariant (`<netId>:<alias>` keying) that would defeat collision:
    // cross-network same-alias would land at `<N_A>:<alias>` vs
    // `<N_B>:<alias>`, and M2's `expect(body.sse_sessions[<N_B>:...]).toBeUndefined()`
    // pins exactly the "wrong-tenant key is invisible" property. M7 is
    // therefore covered structurally; skipping the physical fixture.
    mSameAliasName = "";
  });

  afterAll(() => {
    for (const r of openReaders) { try { r.cancel(); } catch {} }
  });

  // ── M1 + M2 — utok_ member sees own network only ────────────────
  test("M1: utok_ member of N_A sees N_A sessions", async () => {
    const res = await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${mUserAToken}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect("sse_sessions" in body).toBe(true);
    expect(body.sse_sessions[`${mUserANet}:${mUserAName}`]).toBeGreaterThanOrEqual(1);
  });

  test("M2: utok_ member of N_A does NOT see N_B sessions (cross-network invisibility)", async () => {
    const res = await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${mUserAToken}` } });
    const body = await res.json() as any;
    expect("sse_sessions" in body).toBe(true);
    // The N_B session (userB's own network) must not surface here —
    // this is the assertion the reviewer's "delete member filter"
    // mutation must break (currently was silently green).
    expect(body.sse_sessions[`${mUserBNet}:${mUserBName}`]).toBeUndefined();
  });

  test("M2b: utok_ member of N_B sees own but not N_A (reverse of M2)", async () => {
    const res = await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${mUserBToken}` } });
    const body = await res.json() as any;
    expect(body.sse_sessions[`${mUserBNet}:${mUserBName}`]).toBeGreaterThanOrEqual(1);
    expect(body.sse_sessions[`${mUserANet}:${mUserAName}`]).toBeUndefined();
  });

  // ── M3 + M4 — ntok_ single-network enforce ──────────────────────
  test("M3: alice utok_ (user-scoped) sees union — both mAliceNet and mUserANet", async () => {
    const res = await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${mAliceToken}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.sse_sessions[`${mAliceNet}:${mAliceName}`]).toBeGreaterThanOrEqual(1);
    expect(body.sse_sessions[`${mUserANet}:${mUserAName}`]).toBeGreaterThanOrEqual(1);
  });

  test("M4: alice ntok_ (network-scoped, bound to mAliceNet) sees ONLY mAliceNet — N_A invisible even though she is a member", async () => {
    // This is the CR3 P1 fix's mutation-red target: if the /health
    // filter falls through to the `db.all(...)` union for ntok_
    // callers (i.e. drops the `healthAuth.networkId ? [...] : ...`
    // branch), this test flips because alice would suddenly see
    // mUserANet sessions through a token that only granted mAliceNet.
    const res = await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${mAliceNtok}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect("sse_sessions" in body).toBe(true);
    // Own network — must be present.
    expect(body.sse_sessions[`${mAliceNet}:${mAliceName}`]).toBeGreaterThanOrEqual(1);
    // The other network she belongs to — ntok_ must NOT show it.
    expect(body.sse_sessions[`${mUserANet}:${mUserAName}`]).toBeUndefined();
    // Sanity: an unrelated network she's not in must also be absent.
    expect(body.sse_sessions[`${mUserBNet}:${mUserBName}`]).toBeUndefined();
  });

  // ── M5 — membership revocation invalidates visibility ───────────
  test("M5: removing carol from N_A → next /health hides N_A sessions", async () => {
    // Pre-revocation: carol utok_ sees own network + N_A (userA lives
    // in N_A). Filter is per-request, no cache — so a revoke followed
    // by an immediate /health must reflect the new state.
    const before = await (await fetch(`${BASE}/health`, {
      headers: { Authorization: `Bearer ${mCarolToken}` },
    })).json() as any;
    expect(before.sse_sessions[`${mCarolNet}:${mCarolName}`]).toBeGreaterThanOrEqual(1);
    expect(before.sse_sessions[`${mUserANet}:${mUserAName}`]).toBeGreaterThanOrEqual(1);

    const rm = removeNetworkMember(mUserANet, mCarolId);
    if (!rm.ok) throw new Error("revoke failed: " + rm.error);

    const after = await (await fetch(`${BASE}/health`, {
      headers: { Authorization: `Bearer ${mCarolToken}` },
    })).json() as any;
    expect(after.sse_sessions[`${mCarolNet}:${mCarolName}`]).toBeGreaterThanOrEqual(1);
    // The revoked N_A must be gone. Mutation-red for any caching of
    // the memberNets Set across requests.
    expect(after.sse_sessions[`${mUserANet}:${mUserAName}`]).toBeUndefined();
  });

  // ── M6 — observer key format via shared constant ────────────────
  test("M6: observer keys (\\0netobs:<net>) are classified through the shared prefix constant, member sees own network's observer entry", async () => {
    const res = await fetch(`${BASE}/health`, {
      headers: { Authorization: `Bearer ${mUserAToken}` },
    });
    const body = await res.json() as any;
    // Observer key surfaces with the printable prefix (`\\0netobs:`)
    // because push.ts's printableKey renders the NUL byte as `\\0`.
    // The filter must classify this as belonging to `mUserANet` and
    // include it in userA's view.
    const observerKey = `\\0netobs:${mUserANet}`;
    expect(body.sse_sessions[observerKey]).toBeGreaterThanOrEqual(1);
  });

  test("M6b: userB (not in N_A) does NOT see N_A's observer key — mutation-red for prefix constant drift", async () => {
    const res = await fetch(`${BASE}/health`, {
      headers: { Authorization: `Bearer ${mUserBToken}` },
    });
    const body = await res.json() as any;
    const observerKey = `\\0netobs:${mUserANet}`;
    // If the prefix constant drifts (e.g. server.ts checks "netobs:"
    // without `\\0`), the classifier falls through to `key.split(":")[0]`
    // which for a `\\0netobs:` key returns the literal `\\0netobs` string
    // — that would never match memberNets, so the observer key gets
    // over-filtered but silently. That is the pre-CR3 bug shape;
    // this assertion pins the "not in wrong tenant's view" side.
    expect(body.sse_sessions[observerKey]).toBeUndefined();
  });

  // M7 removed — see beforeAll note. Cross-network same-alias
  // invisibility is covered structurally by M1/M2: keys are
  // `<netId>:<alias>`, so a `<N_A>:foo` vs `<N_B>:foo` collision
  // resolves via network prefix, which is what M2's cross-network
  // absence assertion already pins.
});

// ── #506 — same alias, two networks: /health sse_sessions must not cross ──
//
// #505 restored auth-gated `sse_sessions`. Its member filter parses the
// `{networkId}:{alias}` key prefix and keeps only the caller's networks.
// That was verified at merge time by a standalone validator, but a
// validator does not re-run on future refactors — this pins it.
//
// Construction: the dashboard-user SSE gate only lets a caller subscribe
// to its own username (gate 4a), so two users can never share one key that
// way. Gate 4b is the usable path: any member may subscribe to an alias
// that exists as a session IN THEIR network. So we seed a session row with
// the SAME alias in two different networks and have each network's own
// member subscribe to it — producing `{N_A}:{alias}` and `{N_B}:{alias}`
// live at once, which is exactly the collision the filter must separate.
//
// Mutation-red (verified by hand, see the PR): replacing the member filter
// with `scopedSessions = sse.sessions` turns the two "must NOT contain the
// other network's key" assertions red.
describe("#506 cross-network isolation of /health sse_sessions (same alias, two networks)", () => {
  const SHARED_ALIAS = "shared-alias-506";
  let aToken = "", aNet = "", aName = "";
  let bToken = "", bNet = "", bName = "";
  let readerA: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let readerB: ReadableStreamDefaultReader<Uint8Array> | null = null;

  beforeAll(async () => {
    const sfx = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const pw = "BootstrapPw123Aa!";

    // Probe users are registered AFTER the suite's seed user, so neither is
    // the auto-admin first user. Asserted below rather than assumed: an
    // admin caller takes the unfiltered branch and would make these tests
    // pass while proving nothing.
    const ra = register(`h506_a_${sfx}`, pw, undefined, "seed");
    const rb = register(`h506_b_${sfx}`, pw, undefined, "seed");
    if (!ra.ok || !ra.token || !rb.ok || !rb.token) throw new Error("506 register failed");
    aName = `h506_a_${sfx}`; aToken = ra.token; aNet = ra.network_id ?? "";
    bName = `h506_b_${sfx}`; bToken = rb.token; bNet = rb.network_id ?? "";
    if (!aNet || !bNet || aNet === bNet) throw new Error("506 needs two distinct networks");
    db.run("UPDATE users SET role = 'user' WHERE username IN (?1, ?2)", [aName, bName]);

    // Same alias name, one session row per network → gate 4b lets each
    // network's own member subscribe to it.
    for (const [net, tag] of [[aNet, "a"], [bNet, "b"]] as const) {
      db.run(
        `INSERT INTO sessions (resume_id, alias, network_id, last_seen_at, status)
         VALUES (?1, ?2, ?3, datetime('now'), 'idle')`,
        [`s_506_${tag}_${sfx}`, SHARED_ALIAS, net],
      );
    }

    const sub = async (token: string, net: string) => {
      const res = await fetch(
        `${BASE}/events/${encodeURIComponent(SHARED_ALIAS)}?network_id=${encodeURIComponent(net)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (res.status !== 200) throw new Error(`506 SSE subscribe failed (${net}): ${res.status}`);
      const rd = res.body!.getReader();
      await rd.read(); // connected frame → key registered
      return rd;
    };
    readerA = await sub(aToken, aNet);
    readerB = await sub(bToken, bNet);
  });

  afterAll(() => {
    try { readerA?.cancel(); } catch {}
    try { readerB?.cancel(); } catch {}
  });

  test("probe users are NOT admin (an admin caller would bypass the filter and prove nothing)", () => {
    for (const n of [aName, bName]) {
      const row = db.get<{ role: string }>("SELECT role FROM users WHERE username = ?1", n);
      expect(row?.role).not.toBe("admin");
    }
  });

  test("both same-alias keys are live at once (the collision actually exists)", async () => {
    // Read through the ops endpoint with the admin token: if this shows only
    // one of the two keys, the fixture never built the collision and the
    // isolation assertions below would be vacuous.
    const res = await fetch(`${BASE}/api/stats/sse`, { headers: { Authorization: `Bearer ${adminToken}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as { sessions?: Record<string, number> };
    const keys = Object.keys(body.sessions ?? {});
    expect(keys).toContain(`${aNet}:${SHARED_ALIAS}`);
    expect(keys).toContain(`${bNet}:${SHARED_ALIAS}`);
  });

  test("member of network A sees only A's copy of the shared alias", async () => {
    const res = await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${aToken}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as { sse_sessions?: Record<string, number> };
    expect(body.sse_sessions).toBeDefined();
    const keys = Object.keys(body.sse_sessions!);
    expect(keys).toContain(`${aNet}:${SHARED_ALIAS}`);
    expect(keys).not.toContain(`${bNet}:${SHARED_ALIAS}`);
    // Nothing from the other network at all, by any key shape.
    expect(keys.some((k) => k.startsWith(`${bNet}:`))).toBe(false);
  });

  test("member of network B sees only B's copy (reverse direction)", async () => {
    const res = await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${bToken}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as { sse_sessions?: Record<string, number> };
    expect(body.sse_sessions).toBeDefined();
    const keys = Object.keys(body.sse_sessions!);
    expect(keys).toContain(`${bNet}:${SHARED_ALIAS}`);
    expect(keys).not.toContain(`${aNet}:${SHARED_ALIAS}`);
    expect(keys.some((k) => k.startsWith(`${aNet}:`))).toBe(false);
  });
});
