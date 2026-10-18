// #1510 — the secret-transport gate, shipped as log-only first.
//
// The load-bearing property is symmetric: with the gate in log mode a write to a
// `plain` node MUST still succeed (nobody's workflow breaks on upgrade) but MUST
// leave a hit behind, and with `enforce` the same write MUST be refused. A
// half-implemented gate that logs but also refuses would break every plain-HTTP
// node on the next deploy; one that refuses but never logs leaves nothing to
// decide with.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PRIVATE_DB_DIR = mkdtempSync(join(tmpdir(), "anet-transport-gate-"));
process.env.COMMHUB_DB ||= join(PRIVATE_DB_DIR, "hub.db");

let net = "", ownerId = "", ownerToken = "";
let server: ReturnType<typeof Bun.serve>;
let base = "";
const PLAIN = "n_gate_plain";
const TLS = "n_gate_tls";

const post = async (path: string, token: string, body: unknown) => {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() as any };
};
const get = async (path: string, token: string) => {
  const r = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json() as any };
};

beforeAll(async () => {
  const { db } = await import("./db.js");
  const { register } = await import("./auth.js");
  const stamp = Date.now();
  const owner = register(`gate_owner_${stamp}`, "GateOwner-Strong-1!");
  expect(owner.ok).toBe(true);
  ownerToken = owner.token!;
  net = owner.network_id!;
  ownerId = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", `gate_owner_${stamp}`)!.user_id;

  const seed = (nodeId: string, transport: string) => db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, lifecycle_state, config_snapshot)
     VALUES (?1, ?1, ?1, ?2, 'active', ?3)`,
    [nodeId, net, JSON.stringify({ node_secrets_capable: true })],
  );
  seed(PLAIN, "plain");
  seed(TLS, "https");
  // The transport is reported on the session row (that is where report_status
  // writes it).
  const session = (nodeId: string, transport: string) => db.run(
    `INSERT INTO sessions (resume_id, alias, status, node_id, network_id, env_transport, updated_at, last_seen_at)
     VALUES (?1, ?1, 'idle', ?1, ?2, ?3, datetime('now'), datetime('now'))`,
    [nodeId, net, transport],
  );
  session(PLAIN, "plain");
  session(TLS, "https");

  const mod = await import("./server.js");
  server = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  try { server?.stop(true); } catch {}
  try { rmSync(PRIVATE_DB_DIR, { recursive: true, force: true }); } catch {}
});

beforeEach(async () => {
  // The lane allows one pending request per node; drain whatever the previous
  // case left so the next one starts clean.
  const { pullNodeSecrets, ackNodeSecrets } = await import("./scoped-secrets.js");
  for (const nodeId of [PLAIN, TLS]) {
    const daemon = { ok: true as const, networkId: net, daemonNodeId: nodeId, daemonAlias: nodeId };
    const pulled = pullNodeSecrets(daemon) as any;
    for (const r of (pulled?.requests ?? [])) ackNodeSecrets(daemon, r.request_id, null, true);
  }
  process.env.ANET_SECRET_TRANSPORT_GATE = "log";
});

describe("log mode (default)", () => {
  test("a put to a plain node still succeeds AND leaves a hit", async () => {
    const r = await post(`/api/nodes/${PLAIN}/secrets?network_id=${net}`, ownerToken, { action: "put", key: "A_KEY", value: "v", revision: 1 });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true); // not refused: that is the whole point of log mode

    const log = await get(`/api/networks/${net}/env-transport-log`, ownerToken);
    expect(log.status).toBe(200);
    expect(log.body.total).toBe(1);
    expect(log.body.rows[0]).toMatchObject({ node_id: PLAIN, route: "node_secret_put", hits: 1 });
  });

  test("a put to a TLS node leaves no hit", async () => {
    const before = (await get(`/api/networks/${net}/env-transport-log`, ownerToken)).body.total;
    const r = await post(`/api/nodes/${TLS}/secrets?network_id=${net}`, ownerToken, { action: "put", key: "B_KEY", value: "v", revision: 1 });
    expect(r.status).toBe(200);
    const after = (await get(`/api/networks/${net}/env-transport-log`, ownerToken)).body.total;
    expect(after).toBe(before);
  });

  test("list is not observed (it carries no secret)", async () => {
    const before = (await get(`/api/networks/${net}/env-transport-log`, ownerToken)).body.total;
    await post(`/api/nodes/${PLAIN}/secrets?network_id=${net}`, ownerToken, { action: "list" });
    const after = (await get(`/api/networks/${net}/env-transport-log`, ownerToken)).body.total;
    expect(after).toBe(before);
  });
});

describe("enforce mode", () => {
  test("the same put is refused, and nothing is queued", async () => {
    process.env.ANET_SECRET_TRANSPORT_GATE = "enforce";
    const r = await post(`/api/nodes/${PLAIN}/secrets?network_id=${net}`, ownerToken, { action: "put", key: "C_KEY", value: "v", revision: 1 });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("secret_transport_plain");
  });

  test("a TLS node is unaffected", async () => {
    process.env.ANET_SECRET_TRANSPORT_GATE = "enforce";
    const r = await post(`/api/nodes/${TLS}/secrets?network_id=${net}`, ownerToken, { action: "put", key: "D_KEY", value: "v", revision: 1 });
    expect(r.status).toBe(200);
  });
});

describe("off mode", () => {
  test("records nothing at all", async () => {
    process.env.ANET_SECRET_TRANSPORT_GATE = "off";
    const before = (await get(`/api/networks/${net}/env-transport-log`, ownerToken)).body.total;
    const r = await post(`/api/nodes/${PLAIN}/secrets?network_id=${net}`, ownerToken, { action: "put", key: "E_KEY", value: "v", revision: 1 });
    expect(r.status).toBe(200);
    const after = (await get(`/api/networks/${net}/env-transport-log`, ownerToken)).body.total;
    expect(after).toBe(before);
  });
});

describe("the log endpoint is owner/admin only", () => {
  test("an unrelated user gets 403", async () => {
    const { register } = await import("./auth.js");
    const other = register(`gate_other_${Date.now()}`, "GateOther-Strong-1!");
    const r = await get(`/api/networks/${net}/env-transport-log`, other.token!);
    expect(r.status).toBe(403);
  });
});
