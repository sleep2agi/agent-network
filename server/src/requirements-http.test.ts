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

  test("typed assignments validate network membership, preserve kinds and clear explicitly", async () => {
    const { db } = await import('./db.js');
    const ownerId = db.get<{ owner_id: string }>('SELECT owner_id FROM networks WHERE network_id=?1', ownerNetwork)!.owner_id;
    db.run('INSERT INTO nodes(node_id,node_name,alias,display_name,network_id) VALUES (?1,?2,?2,?3,?4)', [ownerId, 'same-name', '自定义 Agent 名', ownerNetwork]);
    db.run('INSERT INTO nodes(node_id,node_name,network_id) VALUES (?1,?2,?3)', ['foreign-person-node', 'foreign-node', 'other-network']);
    const people = await api(ownerToken, `/api/requirements/people?network_id=${ownerNetwork}`);
    expect(people.status).toBe(200);
    expect(people.body.people.some((p: any) => p.id === ownerId && p.kind === 'user')).toBe(true);
    expect(people.body.people.some((p: any) => p.id === ownerId && p.kind === 'node' && p.name === '自定义 Agent 名')).toBe(true);
    expect(people.body.people.every((p: any) => p.networkId === ownerNetwork)).toBe(true);
    const user = { kind: 'user', id: ownerId };
    const node = { kind: 'node', id: ownerId };
    const created = await api(ownerToken, '/api/requirements', { method: 'POST', body: JSON.stringify({ name: 'typed people', owner: user, participants: [user, node, user] }) });
    expect(created.status).toBe(201);
    expect(created.body.requirement.owner).toEqual(user);
    expect(created.body.requirement.participants).toEqual([user, node]);
    const path = `/api/requirements/${created.body.requirement.id}`;
    const changed = await api(ownerToken, path, { method: 'PATCH', body: JSON.stringify({ owner: node }) });
    expect(changed.status).toBe(200);
    expect(changed.body.requirement.owner).toEqual(node);
    expect(changed.body.requirement.participants).toEqual([user, node]);
    expect(changed.body.requirement.column).toBe('pool');
    for (const token of [viewerToken, nodeToken]) {
      expect((await api(token, path, { method: 'PATCH', body: JSON.stringify({ owner: null, participants: [] }) })).status).toBe(403);
    }
    expect((await api(otherToken, path, { method: 'PATCH', body: JSON.stringify({ owner: null }) })).status).toBe(404);
    for (const invalid of [{ kind: 'node', id: 'foreign-person-node' }, { kind: 'user', id: 'unknown' }, { kind: 'admin', id: ownerId }]) {
      expect((await api(ownerToken, path, { method: 'PATCH', body: JSON.stringify({ participants: [invalid] }) })).status).toBe(400);
    }
    const listed = await api(ownerToken, '/api/requirements');
    expect(listed.body.requirements.find((row: any) => row.id === created.body.requirement.id).owner).toEqual(node);
    const cleared = await api(ownerToken, path, { method: 'PATCH', body: JSON.stringify({ owner: null, participants: [] }) });
    expect(cleared.status).toBe(200);
    expect(cleared.body.requirement.owner).toBeNull();
    expect(cleared.body.requirement.participants).toEqual([]);
  });

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

  test("a card can bind a github issue and a bad link is rejected", async () => {
    const created = await api(ownerToken, "/api/requirements", {
      method: "POST",
      body: JSON.stringify({
        name: "绑 issue",
        issues: [{ url: "https://github.com/sleep2agi/agent-network-app/issues/472", title: "picker" }],
      }),
    });
    expect(created.status).toBe(201);
    expect(created.body.requirement.issues).toEqual([
      { repo: "sleep2agi/agent-network-app", number: 472, title: "picker" },
    ]);
    const moved = await api(ownerToken, `/api/requirements/${created.body.requirement.id}`, {
      method: "PATCH",
      body: JSON.stringify({ column: "doing" }),
    });
    expect(moved.body.requirement.issues[0].number).toBe(472);
    const bad = await api(ownerToken, `/api/requirements/${created.body.requirement.id}`, {
      method: "PATCH",
      body: JSON.stringify({ issues: ["javascript:alert(1)"] }),
    });
    expect(bad.status).toBe(400);
  });

  test("an existing card can change its text without dropping omitted fields", async () => {
    const { db } = await import("./db.js");
    const ownerId = db.get<{ owner_id: string }>("SELECT owner_id FROM networks WHERE network_id=?1", ownerNetwork)!.owner_id;
    const created = await api(ownerToken, "/api/requirements", {
      method: "POST",
      body: JSON.stringify({
        name: "旧标题",
        priority: "low",
        assignee: "node-a",
        due: "2026-10-01",
        column: "doing",
        owner: { kind: "user", id: ownerId },
      }),
    });
    expect(created.status).toBe(201);
    const id = created.body.requirement.id;
    const renamed = await api(ownerToken, `/api/requirements/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "新标题" }),
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.requirement.name).toBe("新标题");
    expect(renamed.body.requirement.priority).toBe("low");
    expect(renamed.body.requirement.assignee).toBe("node-a");
    expect(renamed.body.requirement.due).toBe("2026-10-01");
    expect(renamed.body.requirement.column).toBe("doing");
    expect(renamed.body.requirement.owner).toEqual({ kind: "user", id: ownerId });
    const cleared = await api(ownerToken, `/api/requirements/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ due: "", assignee: "", priority: "high" }),
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.requirement.name).toBe("新标题");
    expect(cleared.body.requirement.due).toBe("");
    expect(cleared.body.requirement.assignee).toBe("");
    expect(cleared.body.requirement.priority).toBe("high");
    expect(cleared.body.requirement.owner).toEqual({ kind: "user", id: ownerId });
    expect((await api(ownerToken, `/api/requirements/${id}`, { method: "PATCH", body: JSON.stringify({ name: "  " }) })).status).toBe(400);
    expect((await api(ownerToken, `/api/requirements/${id}`, { method: "PATCH", body: JSON.stringify({ due: "2026-13-01" }) })).status).toBe(400);
    expect((await api(viewerToken, `/api/requirements/${id}`, { method: "PATCH", body: JSON.stringify({ name: "越权" }) })).status).toBe(403);
    expect((await api(otherToken, `/api/requirements/${id}`, { method: "PATCH", body: JSON.stringify({ name: "别人的" }) })).status).toBe(404);
    const listed = await api(ownerToken, "/api/requirements");
    expect(listed.body.requirements.find((row: { id: string }) => row.id === id).name).toBe("新标题");
  });

  test("empty name and a bad date are rejected", async () => {
    const empty = await api(ownerToken, "/api/requirements", { method: "POST", body: JSON.stringify({ name: "  " }) });
    expect(empty.status).toBe(400);
    const date = await api(ownerToken, "/api/requirements", { method: "POST", body: JSON.stringify({ name: "日期", due: "2026-13-01" }) });
    expect(date.status).toBe(400);
  });
});
