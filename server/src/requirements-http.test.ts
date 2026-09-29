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
    // 负责人只能是人类,负责 Agent 只能是节点(参与人两种都行)。
    const humanAsAgent = await api(ownerToken, path, { method: 'PATCH', body: JSON.stringify({ agent_owner: user }) });
    expect(humanAsAgent.status).toBe(400);
    expect(humanAsAgent.body.error).toBe('agent_owner_must_be_agent');
    const agentAsOwner = await api(ownerToken, path, { method: 'PATCH', body: JSON.stringify({ owner: node }) });
    expect(agentAsOwner.status).toBe(400);
    expect(agentAsOwner.body.error).toBe('owner_must_be_human');
    const changed = await api(ownerToken, path, { method: 'PATCH', body: JSON.stringify({ agent_owner: node }) });
    expect(changed.status).toBe(200);
    expect(changed.body.requirement.owner).toEqual(user);
    expect(changed.body.requirement.agent_owner).toEqual(node);
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
    const row = listed.body.requirements.find((row: any) => row.id === created.body.requirement.id);
    expect(row.owner).toEqual(user);
    expect(row.agent_owner).toEqual(node);
    const cleared = await api(ownerToken, path, { method: 'PATCH', body: JSON.stringify({ owner: null, agent_owner: null, participants: [] }) });
    expect(cleared.status).toBe(200);
    expect(cleared.body.requirement.owner).toBeNull();
    expect(cleared.body.requirement.agent_owner).toBeNull();
    expect(cleared.body.requirement.participants).toEqual([]);
  });

  test("a card is created with a human owner and an agent owner; each role rejects the other kind", async () => {
    const { db } = await import('./db.js');
    const ownerId = db.get<{ owner_id: string }>('SELECT owner_id FROM networks WHERE network_id=?1', ownerNetwork)!.owner_id;
    db.run('INSERT OR IGNORE INTO nodes(node_id,node_name,alias,network_id) VALUES (?1,?2,?2,?3)', ['req-exec-node', 'req-exec-node', ownerNetwork]);
    const human = { kind: 'user', id: ownerId };
    const agent = { kind: 'node', id: 'req-exec-node' };
    const both = await api(ownerToken, '/api/requirements', { method: 'POST', body: JSON.stringify({ name: '两个角色', owner: human, agent_owner: agent }) });
    expect(both.status).toBe(201);
    expect(both.body.requirement.owner).toEqual(human);
    expect(both.body.requirement.agent_owner).toEqual(agent);
    const plain = await api(ownerToken, '/api/requirements', { method: 'POST', body: JSON.stringify({ name: '都不填' }) });
    expect(plain.body.requirement.agent_owner).toBeNull();
    const wrongOwner = await api(ownerToken, '/api/requirements', { method: 'POST', body: JSON.stringify({ name: '节点当负责人', owner: agent }) });
    expect(wrongOwner.status).toBe(400);
    expect(wrongOwner.body.error).toBe('owner_must_be_human');
    const wrongAgent = await api(ownerToken, '/api/requirements', { method: 'POST', body: JSON.stringify({ name: '人当负责 Agent', agent_owner: human }) });
    expect(wrongAgent.status).toBe(400);
    expect(wrongAgent.body.error).toBe('agent_owner_must_be_agent');
    const foreign = await api(ownerToken, '/api/requirements', { method: 'POST', body: JSON.stringify({ name: '外网节点', agent_owner: { kind: 'node', id: 'foreign-person-node' } }) });
    expect(foreign.status).toBe(400);
    // 只改 agent_owner 是一次有效 PATCH(不是 empty_patch),其余字段不动
    const path = `/api/requirements/${both.body.requirement.id}`;
    const onlyAgent = await api(ownerToken, path, { method: 'PATCH', body: JSON.stringify({ agent_owner: null }) });
    expect(onlyAgent.status).toBe(200);
    expect(onlyAgent.body.requirement.agent_owner).toBeNull();
    expect(onlyAgent.body.requirement.owner).toEqual(human);
    expect(onlyAgent.body.requirement.name).toBe('两个角色');
    const viewerWrite = await api(viewerToken, path, { method: 'PATCH', body: JSON.stringify({ agent_owner: agent }) });
    expect(viewerWrite.status).toBe(403);
  });

  test("description (markdown) and checklist: create, replace-all PATCH, per-item done, limits", async () => {
    const created = await api(ownerToken, "/api/requirements", {
      method: "POST",
      body: JSON.stringify({ name: "带描述和子任务", description: "## 目标\r\n- 一\n- 二", checklist: [{ id: "a", text: "写接口" }, { text: "写测试", done: true }] }),
    });
    expect(created.status).toBe(201);
    const card = created.body.requirement;
    expect(card.description).toBe("## 目标\n- 一\n- 二");
    expect(card.checklist.length).toBe(2);
    expect(card.checklist[0]).toEqual({ id: "a", text: "写接口", done: false });
    expect(card.checklist[1].done).toBe(true);
    expect(card.checklist[1].id).toMatch(/^ck_[0-9a-f]{16}$/);
    const plain = await api(ownerToken, "/api/requirements", { method: "POST", body: JSON.stringify({ name: "什么都没有" }) });
    expect(plain.body.requirement.description).toBe("");
    expect(plain.body.requirement.checklist).toEqual([]);

    const path = `/api/requirements/${card.id}`;
    const b = card.checklist[1].id;
    // 单项勾选:只动那一项,显式 done,重复请求结果一样
    const done = await api(ownerToken, `${path}/checklist/a`, { method: "PATCH", body: JSON.stringify({ done: true }) });
    expect(done.status).toBe(200);
    expect(done.body.requirement.checklist.map((i: any) => i.done)).toEqual([true, true]);
    const again = await api(ownerToken, `${path}/checklist/a`, { method: "PATCH", body: JSON.stringify({ done: true }) });
    expect(again.body.requirement.checklist.map((i: any) => i.done)).toEqual([true, true]);
    expect(again.body.requirement.name).toBe("带描述和子任务");
    expect((await api(ownerToken, `${path}/checklist/${b}`, { method: "PATCH", body: JSON.stringify({ done: false }) })).body.requirement.checklist[1].done).toBe(false);
    expect((await api(ownerToken, `${path}/checklist/missing`, { method: "PATCH", body: JSON.stringify({ done: true }) })).body.error).toBe("checklist_item_not_found");
    expect((await api(ownerToken, `${path}/checklist/a`, { method: "PATCH", body: JSON.stringify({ done: "yes" }) })).status).toBe(400);
    expect((await api(ownerToken, `${path}/checklist/a`, { method: "POST", body: JSON.stringify({ done: true }) })).status).toBe(404);
    expect((await api(viewerToken, `${path}/checklist/a`, { method: "PATCH", body: JSON.stringify({ done: false }) })).status).toBe(403);
    expect((await api(nodeToken, `${path}/checklist/a`, { method: "PATCH", body: JSON.stringify({ done: false }) })).body.error).toBe("user_token_required");
    expect((await api(otherToken, `${path}/checklist/a`, { method: "PATCH", body: JSON.stringify({ done: false }) })).status).toBe(404);

    // 整个替换:排序 / 增删;只改描述时清单不动;只改清单是有效 PATCH
    const reordered = await api(ownerToken, path, { method: "PATCH", body: JSON.stringify({ checklist: [{ id: b, text: "写测试", done: false }, { id: "a", text: "写接口", done: true }, { id: "c", text: "发版" }] }) });
    expect(reordered.status).toBe(200);
    expect(reordered.body.requirement.checklist.map((i: any) => i.id)).toEqual([b, "a", "c"]);
    const described = await api(ownerToken, path, { method: "PATCH", body: JSON.stringify({ description: "改过的描述" }) });
    expect(described.body.requirement.description).toBe("改过的描述");
    expect(described.body.requirement.checklist.length).toBe(3);
    const cleared = await api(ownerToken, path, { method: "PATCH", body: JSON.stringify({ description: "", checklist: [] }) });
    expect(cleared.body.requirement.description).toBe("");
    expect(cleared.body.requirement.checklist).toEqual([]);

    // 上限与坏输入整体拒绝,原值不变
    const tooLong = await api(ownerToken, path, { method: "PATCH", body: JSON.stringify({ description: "x".repeat(20_001) }) });
    expect(tooLong.body.error).toBe("invalid_description");
    expect((await api(ownerToken, path, { method: "PATCH", body: JSON.stringify({ description: "x".repeat(20_000) }) })).status).toBe(200);
    const many = Array.from({ length: 101 }, (_, i) => ({ id: `i${i}`, text: `第 ${i} 项` }));
    expect((await api(ownerToken, path, { method: "PATCH", body: JSON.stringify({ checklist: many }) })).body.error).toBe("invalid_checklist");
    expect((await api(ownerToken, path, { method: "PATCH", body: JSON.stringify({ checklist: many.slice(0, 100) }) })).status).toBe(200);
    for (const bad of [[{ id: "a", text: "x" }, { id: "a", text: "y" }], [{ text: "  " }], [{ id: "有空格 的id", text: "x" }], [{ text: "x", done: 1 }], ["字符串"]]) {
      expect((await api(ownerToken, path, { method: "PATCH", body: JSON.stringify({ checklist: bad }) })).body.error).toBe("invalid_checklist");
    }
    const listed = await api(ownerToken, "/api/requirements");
    const row = listed.body.requirements.find((r: any) => r.id === card.id);
    expect(row.checklist.length).toBe(100);
    expect(row.description.length).toBe(20_000);
    expect((await api(viewerToken, path, { method: "PATCH", body: JSON.stringify({ description: "越权" }) })).status).toBe(403);
    expect((await api(nodeToken, path, { method: "PATCH", body: JSON.stringify({ description: "Agent 暂不能写" }) })).body.error).toBe("user_token_required");
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
