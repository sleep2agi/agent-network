import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createNetworkTokenForNode, register } from "./auth.js";
import { db } from "./db.js";

const PRIVATE_DB_DIR = mkdtempSync(join(tmpdir(), "anet-network-name-http-"));
let server: any;
let base = "";
let userToken = "";
let nodeToken = "";
let networkId = "";
let username = "";

beforeAll(async () => {
  process.env.COMMHUB_DB = process.env.COMMHUB_DB || join(PRIVATE_DB_DIR, "hub.db");
  username = `network_name_${Date.now()}_${process.pid}`;
  const registered = register(username, "NetworkName123!", undefined, "seed");
  expect(registered.ok).toBe(true);
  userToken = registered.token!;
  networkId = registered.network_id!;
  const userId = db.get<{ user_id: string }>(
    "SELECT user_id FROM users WHERE username = ?1",
    [username],
  )!.user_id;
  const minted = createNetworkTokenForNode(userId, networkId, "network-name-node");
  expect(minted.ok).toBe(true);
  nodeToken = minted.token!;
  const mod: any = await import("./server.js");
  server = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  try { server?.stop?.(true); } catch {}
  try { rmSync(PRIVATE_DB_DIR, { recursive: true, force: true }); } catch {}
});

async function networks(token: string): Promise<any[]> {
  const response = await fetch(`${base}/api/networks`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  const body = await response.json() as any;
  expect(body.ok).toBe(true);
  return body.networks;
}

describe("GET /api/networks name compatibility (#449)", () => {
  test("utok rows expose equal non-null name and network_name", async () => {
    const rows = await networks(userToken);
    expect(rows).toHaveLength(1);
    expect(rows[0].network_id).toBe(networkId);
    // #449 is about `name` and `network_name` agreeing and being non-null.
    // Pin them to the registered username rather than the literal "default":
    // the auto-created network is named after its owner, so hardcoding the
    // old literal would test the naming scheme instead of the compat shim.
    expect(rows[0].network_name).toBe(username);
    expect(rows[0].name).toBe(username);
  });

  test("network-bound ntok rows expose the same alias", async () => {
    const rows = await networks(nodeToken);
    expect(rows).toHaveLength(1);
    expect(rows[0].network_id).toBe(networkId);
    expect(rows[0].network_name).toBe(username);
    expect(rows[0].name).toBe(rows[0].network_name);
    expect(rows[0].name).not.toBeNull();
  });
});
