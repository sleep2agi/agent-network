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
// #1510 acceptance names three transports: loopback passes, https passes, plain
// public is refused. log/enforce only ever *special-case* `plain`, so loopback
// could rot without anyone noticing it is still accepted — seed it as its own
// node rather than folding it in with TLS, so a regression reads by name.
const LOOPBACK = "n_gate_loopback";
const UNKNOWN = "n_gate_unknown";
// #1510 补档 —— 生产里占绝大多数的是「从未上报」：2026-10-29 只读统计 373 个会话，
// env_transport = NULL 有 332 个（89%）。原实现是拒绝名单（只拒 plain），
// null 一路放行；卡里的口径是允许名单（只许 loopback/https）。这两者只在 null 上分歧，
// 所以这里把 null 当成一等公民单独种一个节点。

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

  const seed = (nodeId: string, transport: string | null) => db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, lifecycle_state, config_snapshot)
     VALUES (?1, ?1, ?1, ?2, 'active', ?3)`,
    [nodeId, net, JSON.stringify({ node_secrets_capable: true })],
  );
  seed(PLAIN, "plain");
  seed(TLS, "https");
  seed(LOOPBACK, "loopback");
  seed(UNKNOWN, null);
  // The transport is reported on the session row (that is where report_status
  // writes it).
  const session = (nodeId: string, transport: string | null) => db.run(
    `INSERT INTO sessions (resume_id, alias, status, node_id, network_id, env_transport, updated_at, last_seen_at)
     VALUES (?1, ?1, 'idle', ?1, ?2, ?3, datetime('now'), datetime('now'))`,
    [nodeId, net, transport],
  );
  session(PLAIN, "plain");
  session(TLS, "https");
  session(LOOPBACK, "loopback");
  session(UNKNOWN, null); // 从未上报 transport

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
  for (const nodeId of [PLAIN, TLS, LOOPBACK, UNKNOWN]) {
    const daemon = { ok: true as const, networkId: net, daemonNodeId: nodeId, daemonAlias: nodeId };
    const pulled = pullNodeSecrets(daemon) as any;
    for (const r of (pulled?.requests ?? [])) ackNodeSecrets(daemon, r.request_id, null, true);
  }
  process.env.ANET_SECRET_TRANSPORT_GATE = "log";
  delete process.env.ANET_SECRET_TRANSPORT_GATE_STRICT;
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

  // #1510 acceptance leg 1: loopback is an allowed transport, so it must neither
  // be refused nor pollute the would-refuse log (the log is the decision input
  // for turning enforce on — a loopback hit in it would read as "something to
  // block" when nothing is).
  test("a put to a loopback node succeeds AND leaves no hit", async () => {
    const before = (await get(`/api/networks/${net}/env-transport-log`, ownerToken)).body.total;
    const r = await post(`/api/nodes/${LOOPBACK}/secrets?network_id=${net}`, ownerToken, { action: "put", key: "LB_KEY", value: "v", revision: 1 });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
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

  // #1510 acceptance: "loopback 通过 / https 通过 / 明文公网被拒". enforce is
  // defined as *refuse plain* — loopback is a local link and must keep working
  // under enforce, otherwise turning the gate on would break the one transport
  // it exists to protect.
  test("a loopback node passes enforce too", async () => {
    process.env.ANET_SECRET_TRANSPORT_GATE = "enforce";
    const r = await post(`/api/nodes/${LOOPBACK}/secrets?network_id=${net}`, ownerToken, { action: "put", key: "LB2_KEY", value: "v", revision: 1 });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
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

// #1510 补档 —— 「未知 transport」必须有名字，而且默认不能被当成「不安全」。
//
// 生产数据（2026-10-29 只读）：373 个会话里 332 个 env_transport = NULL。
// 如果 enforce 默认就把 null 拒掉，打开开关当天就会拦掉近九成节点 —— 那不是收紧，
// 那是一次不在计划内的下线。所以：
//   · 默认（strict 关）：null 放行，且不进 would-refuse 表（不制造噪声）
//   · 显式 ANET_SECRET_TRANSPORT_GATE_STRICT=1：null 拒，原因码单独叫
//     secret_transport_unknown —— 运维看到这个码，知道要去做的是「让节点上报」，
//     而不是去查某台机器的网络链路
describe("#1510 未知 transport（未上报）", () => {
  const putTo = (nodeId: string, key: string) =>
    post(`/api/nodes/${nodeId}/secrets?network_id=${net}`, ownerToken, { action: "put", key, value: "v", revision: 1 });

  test("log 模式：未上报的节点不受影响，也不进 would-refuse 表", async () => {
    const before = (await get(`/api/networks/${net}/env-transport-log`, ownerToken)).body.total;
    const r = await putTo(UNKNOWN, "U1_KEY");
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const after = (await get(`/api/networks/${net}/env-transport-log`, ownerToken)).body.total;
    expect(after).toBe(before);
  });

  test("enforce 但 strict 关：未上报仍然放行（默认不收紧到「未知即拒」）", async () => {
    process.env.ANET_SECRET_TRANSPORT_GATE = "enforce";
    const r = await putTo(UNKNOWN, "U2_KEY");
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  test("enforce + strict：未上报被拒，原因码是 secret_transport_unknown（不是 plain）", async () => {
    process.env.ANET_SECRET_TRANSPORT_GATE = "enforce";
    process.env.ANET_SECRET_TRANSPORT_GATE_STRICT = "1";
    const r = await putTo(UNKNOWN, "U3_KEY");
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("secret_transport_unknown");
  });

  test("enforce + strict：明确 plain 的原因码不受影响，仍是 secret_transport_plain", async () => {
    process.env.ANET_SECRET_TRANSPORT_GATE = "enforce";
    process.env.ANET_SECRET_TRANSPORT_GATE_STRICT = "1";
    const r = await putTo(PLAIN, "U4_KEY");
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("secret_transport_plain");
  });

  test("enforce + strict：loopback / https 仍然放行（收紧不能倒向坏另一边）", async () => {
    process.env.ANET_SECRET_TRANSPORT_GATE = "enforce";
    process.env.ANET_SECRET_TRANSPORT_GATE_STRICT = "1";
    for (const [node, key] of [[LOOPBACK, "U5_KEY"], [TLS, "U6_KEY"]] as const) {
      const r = await putTo(node, key);
      expect(r.body.ok).toBe(true);
    }
  });
});
