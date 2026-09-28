import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "anet-requirements-"));
process.env.COMMHUB_DB = join(dir, "hub.db");

let server: { port: number; stop?: (force?: boolean) => void };
let base = "";
let ownerToken = "";
let viewerToken = "";
let otherToken = "";
let nodeToken = "";
let ownerNetwork = "";

async function api(token: string, path: string, init?: RequestInit) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  return { status: res.status, body: await res.json() as any };
}

beforeAll(async () => {
  const { db } = await import("./db.js");
  const { addNetworkMember, createNetworkTokenForNode, register } = await import("./auth.js");
  const owner = register(`req_owner_${Date.now()}`, "RequirementsOwner123!", undefined, "seed");
  expect(owner.ok).toBe(true);
  ownerToken = owner.token!;
  ownerNetwork = owner.network_id!;
  const networkId = owner.network_id!;
  const ownerId = db.get<{ owner_id: string }>("SELECT owner_id FROM networks WHERE network_id = ?1", networkId)!.owner_id;
  const viewer = register(`req_viewer_${Date.now()}`, "RequirementsViewer123!", undefined, "seed");
  expect(viewer.ok).toBe(true);
  viewerToken = viewer.token!;
  const viewerId = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", viewer.user!.username)!.user_id;
  addNetworkMember(networkId, viewerId, "viewer", ownerId);
  const ntok = createNetworkTokenForNode(ownerId, networkId, "req-node");
  expect(ntok.ok).toBe(true);
  nodeToken = ntok.token!;
  const other = register(`req_other_${Date.now()}`, "RequirementsOther123!", undefined, "seed");
  expect(other.ok).toBe(true);
  otherToken = other.token!;
  const mod: any = await import("./server.js");
  server = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
}, 30_000);

afterAll(() => {
  try { server?.stop?.(true); } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe("requirements stay on the hub", () => {
  let id = "";

  test("owner creates a card in the pool", async () => {
    const created = await api(ownerToken, "/api/requirements", {
      method: "POST",
      body: JSON.stringify({ name: "多端同步", priority: "high", assignee: "node-a", due: "2026-10-01" }),
    });
    expect(created.status).toBe(201);
    expect(created.body.requirement.column).toBe("pool");
    expect(created.body.requirement.name).toBe("多端同步");
    expect(created.body.requirement.assignee).toBe("node-a");
    expect(created.body.requirement.due).toBe("2026-10-01");
    id = created.body.requirement.id;
  });

  test("the same account reads it back", async () => {
    const listed = await api(ownerToken, "/api/requirements");
    expect(listed.status).toBe(200);
    expect(listed.body.requirements.some((row: { id: string }) => row.id === id)).toBe(true);
  });

  test("moving a card is stored on the hub", async () => {
    const moved = await api(ownerToken, `/api/requirements/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ column: "doing" }),
    });
    expect(moved.status).toBe(200);
    expect(moved.body.requirement.column).toBe("doing");
  });

  test("another network cannot see it", async () => {
    const listed = await api(otherToken, "/api/requirements");
    expect(listed.status).toBe(200);
    expect(listed.body.requirements.some((row: { id: string }) => row.id === id)).toBe(false);
  });

  test("a viewer cannot add or move", async () => {
    const denied = await api(viewerToken, "/api/requirements", {
      method: "POST",
      body: JSON.stringify({ name: "不行", network_id: ownerNetwork }),
    });
    expect(denied.status).toBe(403);
    const move = await api(viewerToken, `/api/requirements/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ column: "done" }),
    });
    expect(move.status).toBe(403);
  });

  test("a node token cannot use the board", async () => {
    const denied = await api(nodeToken, "/api/requirements");
    expect(denied.status).toBe(403);
  });

  test("the same client_id does not create a second card", async () => {
    const first = await api(ownerToken, "/api/requirements", {
      method: "POST",
      body: JSON.stringify({ name: "迁移甲", client_id: "local_card_1", column: "doing" }),
    });
    expect(first.status).toBe(201);
    expect(first.body.requirement.column).toBe("doing");
    const again = await api(ownerToken, "/api/requirements", {
      method: "POST",
      body: JSON.stringify({ name: "迁移甲", client_id: "local_card_1", column: "done" }),
    });
    expect(again.status).toBe(200);
    expect(again.body.requirement.id).toBe(first.body.requirement.id);
    expect(again.body.requirement.column).toBe("doing");
    const listed = await api(ownerToken, "/api/requirements");
    const matches = listed.body.requirements.filter((row: { id: string }) => row.id === first.body.requirement.id);
    expect(matches.length).toBe(1);
  });

  test("empty name and a bad date are rejected", async () => {
    const empty = await api(ownerToken, "/api/requirements", { method: "POST", body: JSON.stringify({ name: "  " }) });
    expect(empty.status).toBe(400);
    const date = await api(ownerToken, "/api/requirements", { method: "POST", body: JSON.stringify({ name: "日期", due: "2026-13-01" }) });
    expect(date.status).toBe(400);
  });
});
