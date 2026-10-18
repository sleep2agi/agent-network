// #1491 E1 — the node-secret lane over REST.
//
// The lane itself is old (tools.ts `node_secret_*` → scoped-secrets.ts → node
// doorbell → agent-node `reconcileNodeSecrets`). What was missing is **any way
// for the client to drive it**: MCP-only, request/ack shaped. These two routes
// are deliberately thin — enqueue, then poll — and the authorization stays in
// the lane (owner/admin), not duplicated here.
//
// Load-bearing assertions:
//   * a plain member of the network is refused (403), an owner gets through;
//   * a node that does not advertise `node_secrets_capable` is a 409, not a
//     silent queue entry that expires 120s later;
//   * `put`/`delete` without a revision is a 400 (inventing 0 would clobber a
//     file the operator edited in between);
//   * the poll returns the node's snapshot once it acks — key NAMES and a
//     revision only, never a value.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PRIVATE_DB_DIR = mkdtempSync(join(tmpdir(), "anet-nodesecret-rest-"));
process.env.COMMHUB_DB ||= join(PRIVATE_DB_DIR, "hub.db");

let server: ReturnType<typeof Bun.serve>;
let base = "";
let ownerToken = "", memberToken = "";
let net = "", ownerId = "", memberId = "";
const CAPABLE = "n_capable";
const PLAIN = "n_plain";

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
  const { register, addNetworkMember } = await import("./auth.js");
  const stamp = Date.now();

  const owner = register(`ns_owner_${stamp}`, "NsOwner-Strong-1!");
  const member = register(`ns_member_${stamp}`, "NsMember-Strong-1!");
  expect(owner.ok && member.ok).toBe(true);
  ownerToken = owner.token!;
  memberToken = member.token!;
  net = owner.network_id!;
  ownerId = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", `ns_owner_${stamp}`)!.user_id;
  memberId = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", `ns_member_${stamp}`)!.user_id;
  // A plain member of the same network: must still be refused by the lane.
  expect(addNetworkMember(net, memberId, "member").ok).toBe(true);

  const seedNode = (nodeId: string, capable: boolean) => db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, lifecycle_state, config_snapshot)
     VALUES (?1, ?1, ?1, ?2, 'active', ?3)`,
    [nodeId, net, JSON.stringify(capable ? { node_secrets_capable: true } : {})],
  );
  seedNode(CAPABLE, true);
  seedNode(PLAIN, false);

  const mod = await import("./server.js");
  server = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  try { server?.stop(true); } catch {}
  try { rmSync(PRIVATE_DB_DIR, { recursive: true, force: true }); } catch {}
});

/** The lane allows ONE pending request per node. Every test starts from a clean
 *  queue, otherwise ordering decides the outcome (the first version of this file
 *  went red exactly that way: a `list` from an earlier test left the node busy). */
async function drainPending() {
  const { pullNodeSecrets, ackNodeSecrets } = await import("./scoped-secrets.js");
  const daemon = { ok: true as const, networkId: net, daemonNodeId: CAPABLE, daemonAlias: CAPABLE };
  const pulled = pullNodeSecrets(daemon);
  const list = pulled && Array.isArray((pulled as any).requests) ? (pulled as any).requests : [];
  for (const r of list) ackNodeSecrets(daemon, r.request_id, null, true);
}

beforeEach(async () => { await drainPending(); });

describe("POST /api/nodes/:id/secrets", () => {
  test("owner can enqueue a list request", async () => {
    const r = await post(`/api/nodes/${CAPABLE}/secrets?network_id=${net}`, ownerToken, { action: "list" });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(String(r.body.request_id)).toStartWith("nsk_");
  });

  test("a plain member of the same network is refused (403)", async () => {
    const r = await post(`/api/nodes/${CAPABLE}/secrets?network_id=${net}`, memberToken, { action: "list" });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("secret_admin_required");
  });

  test("a node without node_secrets_capable is a 409, not a queued request", async () => {
    const r = await post(`/api/nodes/${PLAIN}/secrets?network_id=${net}`, ownerToken, { action: "list" });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("node_secrets_upgrade_required");
  });

  test("put without a revision is a 400", async () => {
    const r = await post(`/api/nodes/${CAPABLE}/secrets?network_id=${net}`, ownerToken, { action: "put", key: "A_KEY", value: "v" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("revision_required");
  });

  test("an unknown action is a 400", async () => {
    const r = await post(`/api/nodes/${CAPABLE}/secrets?network_id=${net}`, ownerToken, { action: "wipe" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_action");
  });

  test("a second pending request on the same node is a 409 (secret_store_busy)", async () => {
    // The previous test cases left requests pending; the lane allows one at a
    // time per node. Drain by acking through the lane's own API.
    const { ackNodeSecrets } = await import("./scoped-secrets.js");
    const { db } = await import("./db.js");
    const pending = db.all<any>("SELECT 1"); // no-op, keeps the import honest
    expect(Array.isArray(pending)).toBe(true);
    const first = await post(`/api/nodes/${CAPABLE}/secrets?network_id=${net}`, ownerToken, { action: "list" });
    if (first.status === 200) {
      const second = await post(`/api/nodes/${CAPABLE}/secrets?network_id=${net}`, ownerToken, { action: "list" });
      expect(second.status).toBe(409);
      expect(second.body.error).toBe("secret_store_busy");
      // Clean up so the poll test below starts from a known state.
      ackNodeSecrets(
        { ok: true, networkId: net, daemonNodeId: CAPABLE, daemonAlias: CAPABLE },
        first.body.request_id, { network_id: net, daemon_node_id: null, node_id: CAPABLE, revision: 1, activation: "next_start", keys: [] }, true,
      );
    } else {
      expect(first.status).toBe(409);
    }
  });
});

describe("GET /api/nodes/:id/secrets/:request_id", () => {
  test("poll returns the node's ack snapshot (names + revision)", async () => {
    const { ackNodeSecrets } = await import("./scoped-secrets.js");
    const created = await post(`/api/nodes/${CAPABLE}/secrets?network_id=${net}`, ownerToken, { action: "list" });
    expect(created.status).toBe(200);
    const rid = created.body.request_id as string;

    // Before the node answers, the poll says pending.
    const pending = await get(`/api/nodes/${CAPABLE}/secrets/${rid}?network_id=${net}`, ownerToken);
    expect(pending.status).toBe(200);
    expect(pending.body.status).toBe("pending");

    // The node answers through its own lane call (same code path as the doorbell).
    const acked = ackNodeSecrets(
      { ok: true, networkId: net, daemonNodeId: CAPABLE, daemonAlias: CAPABLE },
      rid,
      { network_id: net, daemon_node_id: null, node_id: CAPABLE, revision: 2, activation: "next_start", keys: [{ key: "ALPHA_KEY", source: "node" }] },
    );
    expect(acked.ok).toBe(true);

    const done = await get(`/api/nodes/${CAPABLE}/secrets/${rid}?network_id=${net}`, ownerToken);
    expect(done.status).toBe(200);
    expect(done.body.status).toBe("succeeded");
    expect(done.body.snapshot.keys).toEqual([{ key: "ALPHA_KEY", source: "node" }]);
    // Names only — no value field anywhere in the payload.
    expect(JSON.stringify(done.body)).not.toContain("value");
  });

  test("a plain member cannot poll (403)", async () => {
    const created = await post(`/api/nodes/${CAPABLE}/secrets?network_id=${net}`, ownerToken, { action: "list" });
    const rid = created.status === 200 ? created.body.request_id : "nsk_missing";
    if (created.status === 200) {
      const { ackNodeSecrets } = await import("./scoped-secrets.js");
      ackNodeSecrets({ ok: true, networkId: net, daemonNodeId: CAPABLE, daemonAlias: CAPABLE }, rid, null, true);
    }
    const r = await get(`/api/nodes/${CAPABLE}/secrets/${rid}?network_id=${net}`, memberToken);
    expect(r.status).toBe(403);
  });

  test("an unknown request id is a 404", async () => {
    const r = await get(`/api/nodes/${CAPABLE}/secrets/nsk_does_not_exist?network_id=${net}`, ownerToken);
    expect(r.status).toBe(404);
  });
});
