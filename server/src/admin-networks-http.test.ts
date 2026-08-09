import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NETWORK_REST_COLUMNS } from "./rest-projections.js";

const PRIVATE_DB_DIR = mkdtempSync(join(tmpdir(), "anet-admin-networks-"));
process.env.COMMHUB_DB ||= join(PRIVATE_DB_DIR, "hub.db");

let server: ReturnType<typeof Bun.serve>;
let base = "";
let adminToken = "";
let memberToken = "";
let nodeToken = "";
let adminNetworkId = "";
let memberNetworkId = "";

async function listNetworks(token: string): Promise<any[]> {
  const response = await fetch(`${base}/api/networks`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  const body = await response.json() as any;
  expect(body.ok).toBe(true);
  return body.networks;
}

beforeAll(async () => {
  const { db } = await import("./db.js");
  const { createNetworkTokenForNode, register } = await import("./auth.js");

  // The first registered user is the global Hub admin. The second user owns a
  // separate network and is intentionally not a member of the admin's network.
  const admin = register(`admin_networks_${Date.now()}`, "AdminNetworks-Strong-1!", undefined, "admin");
  expect(admin.ok).toBe(true);
  adminToken = admin.token!;
  adminNetworkId = admin.network_id!;

  const member = register(`member_networks_${Date.now()}`, "MemberNetworks-Strong-1!", undefined, "member");
  expect(member.ok).toBe(true);
  memberToken = member.token!;
  memberNetworkId = member.network_id!;

  const memberUserId = db.get<{ user_id: string }>(
    "SELECT user_id FROM users WHERE username LIKE 'member_networks_%' ORDER BY created_at DESC LIMIT 1",
  )!.user_id;
  const minted = createNetworkTokenForNode(memberUserId, memberNetworkId, "admin-networks-node");
  expect(minted.ok).toBe(true);
  nodeToken = minted.token!;

  const mod = await import("./server.js");
  server = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  try { server?.stop(true); } catch {}
  try { rmSync(PRIVATE_DB_DIR, { recursive: true, force: true }); } catch {}
});

describe("GET /api/networks global-admin visibility (#94)", () => {
  test("global admin utok sees every network without losing public shape", async () => {
    const rows = await listNetworks(adminToken);
    expect(new Set(rows.map((row) => row.network_id))).toEqual(new Set([adminNetworkId, memberNetworkId]));

    const own = rows.find((row) => row.network_id === adminNetworkId);
    const foreign = rows.find((row) => row.network_id === memberNetworkId);
    expect(own.member_role).toBe("owner");
    expect(foreign.member_role).toBe("admin");
    expect(Object.keys(foreign).sort()).toEqual([...NETWORK_REST_COLUMNS, "member_role", "name"].sort());
  });

  test("ordinary utok remains limited to member networks", async () => {
    const rows = await listNetworks(memberToken);
    expect(rows.map((row) => row.network_id)).toEqual([memberNetworkId]);
    expect(rows.some((row) => row.network_id === adminNetworkId)).toBe(false);
  });

  test("network token remains limited to its bound network", async () => {
    const rows = await listNetworks(nodeToken);
    expect(rows.map((row) => row.network_id)).toEqual([memberNetworkId]);
    expect(rows.some((row) => row.network_id === adminNetworkId)).toBe(false);
  });
});
