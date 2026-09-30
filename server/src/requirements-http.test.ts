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

  test("name limit is consistent across create, PATCH and both upsert paths", async () => {
    const send = (path: string, method: string, body: unknown) => api(ownerToken, path, { method, body: JSON.stringify(body) });
    const ref = 'github:test/name-limit#1';
    const created = await send('/api/requirements/upsert', 'POST', { name: '字'.repeat(80), external_ref: ref });
    expect(created.status).toBe(201);
    const path = `/api/requirements/${created.body.requirement.id}`;
    for (const name of ['a'.repeat(150), '字'.repeat(81), '   ', null, 12]) {
      for (const [url, method, extra] of [
        ['/api/requirements', 'POST', {}],
        [path, 'PATCH', {}],
        ['/api/requirements/upsert', 'POST', { external_ref: ref }],
        ['/api/requirements/upsert', 'POST', { external_ref: 'github:test/name-limit#2' }],
      ] as const) {
        const result = await send(url, method, { ...extra, name });
        expect(result.status).toBe(400);
        expect(result.body.error).toBe('invalid_name');
      }
    }
    expect((await api(ownerToken, path)).body.requirement.name).toBe('字'.repeat(80));
    const boundary = await send(path, 'PATCH', { name: `  ${'界'.repeat(80)}  ` });
    expect(boundary.status).toBe(200);
    expect(boundary.body.requirement.name).toBe('界'.repeat(80));
    expect((await send(path, 'PATCH', { priority: 'high' })).body.requirement.name).toBe('界'.repeat(80));
    await api(ownerToken, path, { method: 'DELETE' });
  });

  test("archived=true returns only archived tasks and default excludes them", async () => {
    const create = async (token: string, name: string) => api(token, '/api/requirements', { method: 'POST', body: JSON.stringify({ name }) });
    const active = (await create(ownerToken, 'archive-filter-active')).body.requirement.id;
    const archived = (await create(ownerToken, 'archive-filter-archived')).body.requirement.id;
    const foreign = (await create(otherToken, 'archive-filter-foreign')).body.requirement.id;
    for (const [token, taskId] of [[ownerToken, archived], [otherToken, foreign]]) {
      expect((await api(token, `/api/requirements/${taskId}`, { method: 'PATCH', body: JSON.stringify({ archived: true }) })).status).toBe(200);
    }
    const ids = async (query: string) => {
      const result = await api(ownerToken, `/api/requirements${query}${query ? '&' : '?'}network_id=${ownerNetwork}`);
      expect(result.status).toBe(200);
      return result.body.requirements.map((task: any) => task.id);
    };
    expect(await ids('?archived=true')).toEqual([archived]);
    expect(await ids('?archived=true&include_archived=1')).toEqual([archived]);
    const defaults = await ids('');
    expect(defaults).toContain(active);
    expect(defaults).not.toContain(archived);
    expect(defaults).not.toContain(foreign);
    expect(await ids('?archived=false')).toEqual(defaults);
    const all = await ids('?include_archived=1');
    expect(all).toContain(active);
    expect(all).toContain(archived);
    expect(all).not.toContain(foreign);
    for (const [token, taskId] of [[ownerToken, active], [ownerToken, archived], [otherToken, foreign]]) {
      await api(token, `/api/requirements/${taskId}`, { method: 'DELETE' });
    }
  });

  test("tags validate, aggregate within network, and survive old PATCH shapes", async () => {
    const created = await api(ownerToken, '/api/requirements', { method: 'POST', body: JSON.stringify({ name: 'tagged task', tags: [' UI ', 'UI', '交付'] }) });
    expect(created.status).toBe(201);
    expect(created.body.requirement.tags).toEqual(['UI', '交付']);
    const path = `/api/requirements/${created.body.requirement.id}`;
    const old = await api(ownerToken, path, { method: 'PATCH', body: JSON.stringify({ column: 'doing', name: 'old app edit' }) });
    expect(old.status).toBe(200);
    expect(old.body.requirement.tags).toEqual(['UI', '交付']);
    for (const tags of [null, 'UI', [12], [''], ['a'.repeat(21)], Array.from({ length: 11 }, (_, i) => `t${i}`)]) {
      const invalid = await api(ownerToken, path, { method: 'PATCH', body: JSON.stringify({ tags }) });
      expect(invalid.status).toBe(400);
      expect(invalid.body.error).toBe('invalid_tags');
    }
    const own = await api(ownerToken, '/api/requirements/tags');
    expect(own.body.tags).toEqual(['UI', '交付']);
    expect((await api(otherToken, '/api/requirements/tags')).body.tags).toEqual([]);
    expect((await api(nodeToken, '/api/requirements/tags')).body.tags).toEqual(['UI', '交付']);
    expect((await api(viewerToken, `${path}?network_id=${ownerNetwork}`, { method: 'PATCH', body: JSON.stringify({ tags: [] }) })).status).toBe(403);
    const cleared = await api(ownerToken, path, { method: 'PATCH', body: JSON.stringify({ tags: [] }) });
    expect(cleared.body.requirement.tags).toEqual([]);
    expect((await api(ownerToken, '/api/requirements/tags')).body.tags).toEqual([]);
  });

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
    // 新客户端(带了 agent_owner):节点当负责人严格拒绝
    const agentAsOwner = await api(ownerToken, path, { method: 'PATCH', body: JSON.stringify({ owner: node, agent_owner: null }) });
    expect(agentAsOwner.status).toBe(400);
    expect(agentAsOwner.body.error).toBe('owner_must_be_human');
    const changed = await api(ownerToken, path, { method: 'PATCH', body: JSON.stringify({ agent_owner: node }) });
    expect(changed.status).toBe(200);
    expect(changed.body.requirement.owner).toEqual(user);
    expect(changed.body.requirement.agent_owner).toEqual(node);
    expect(changed.body.requirement.participants).toEqual([user, node]);
    expect(changed.body.requirement.column).toBe('pool');
    expect((await api(viewerToken, path, { method: 'PATCH', body: JSON.stringify({ owner: null, participants: [] }) })).status).toBe(403);
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
    const wrongOwner = await api(ownerToken, '/api/requirements', { method: 'POST', body: JSON.stringify({ name: '节点当负责人', owner: agent, agent_owner: null }) });
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
    // Agent(节点令牌)能勾自己网络里的子任务(PR B 放开)
    const agentTick = await api(nodeToken, `${path}/checklist/a`, { method: "PATCH", body: JSON.stringify({ done: true }) });
    expect(agentTick.status).toBe(200);
    expect(agentTick.body.requirement.updated_by.kind).toBe("node");
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
    expect((await api(nodeToken, path, { method: "PATCH", body: JSON.stringify({ description: "Agent 写的描述" }) })).body.requirement.description).toBe("Agent 写的描述");
  });

  test("projects: CRUD per network, project_id on cards, delete nulls references, archive keeps them", async () => {
    const q = `?network_id=${ownerNetwork}`;
    const empty = await api(ownerToken, `/api/requirements/projects${q}`);
    expect(empty.status).toBe(200);
    expect(empty.body.projects).toEqual([]); // 不预置任何项目
    const legion = await api(ownerToken, `/api/requirements/projects${q}`, { method: "POST", body: JSON.stringify({ name: "军团项目" }) });
    expect(legion.status).toBe(201);
    expect(legion.body.project.name).toBe("军团项目");
    expect(legion.body.project.color).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(legion.body.project.archived).toBe(false);
    const tmai = await api(ownerToken, `/api/requirements/projects${q}`, { method: "POST", body: JSON.stringify({ name: "TMAI", color: "#7c3aed" }) });
    expect(tmai.body.project.color).toBe("#7c3aed");
    expect((await api(ownerToken, `/api/requirements/projects${q}`, { method: "POST", body: JSON.stringify({ name: "TMAI" }) })).status).toBe(409);
    for (const bad of [{ name: "  " }, { name: "x".repeat(41) }, { name: "色", color: "red" }, { name: "序", sort: 1.5 }]) {
      expect((await api(ownerToken, `/api/requirements/projects${q}`, { method: "POST", body: JSON.stringify(bad) })).status).toBe(400);
    }
    const listed = await api(ownerToken, `/api/requirements/projects${q}`);
    expect(listed.body.projects.map((p: any) => p.name)).toEqual(["军团项目", "TMAI"]);
    // 权限:viewer 能读不能写;节点令牌一律拒绝;别的网络看不见、改不了
    expect((await api(viewerToken, `/api/requirements/projects${q}`)).body.projects.length).toBe(2);
    expect((await api(viewerToken, `/api/requirements/projects${q}`, { method: "POST", body: JSON.stringify({ name: "越权" }) })).status).toBe(403);
    // Agent 能读项目(挂卡片要用),不能建 / 改 / 删项目
    expect((await api(nodeToken, `/api/requirements/projects${q}`)).body.projects.length).toBe(2);
    expect((await api(nodeToken, `/api/requirements/projects${q}`, { method: "POST", body: JSON.stringify({ name: "Agent 建的" }) })).body.error).toBe("user_token_required");
    expect((await api(otherToken, "/api/requirements/projects")).body.projects).toEqual([]);
    expect((await api(otherToken, `/api/requirements/projects/${tmai.body.project.id}`, { method: "PATCH", body: JSON.stringify({ name: "抢" }) })).status).toBe(404);
    const foreign = await api(otherToken, "/api/requirements/projects", { method: "POST", body: JSON.stringify({ name: "别人的项目" }) });
    expect(foreign.status).toBe(201);

    // 卡片上的 project_id:POST / PATCH / GET;别的网络的项目被拒
    const card = await api(ownerToken, "/api/requirements", { method: "POST", body: JSON.stringify({ name: "有项目的卡", project_id: legion.body.project.id }) });
    expect(card.status).toBe(201);
    expect(card.body.requirement.project_id).toBe(legion.body.project.id);
    const bare = await api(ownerToken, "/api/requirements", { method: "POST", body: JSON.stringify({ name: "没项目的卡" }) });
    expect(bare.body.requirement.project_id).toBeNull();
    expect((await api(ownerToken, "/api/requirements", { method: "POST", body: JSON.stringify({ name: "外网项目", project_id: foreign.body.project.id }) })).body.error).toBe("project_not_in_network");
    const path = `/api/requirements/${card.body.requirement.id}`;
    expect((await api(ownerToken, path, { method: "PATCH", body: JSON.stringify({ project_id: foreign.body.project.id }) })).body.error).toBe("project_not_in_network");
    const moved = await api(ownerToken, path, { method: "PATCH", body: JSON.stringify({ project_id: tmai.body.project.id }) });
    expect(moved.status).toBe(200);
    expect(moved.body.requirement.project_id).toBe(tmai.body.project.id);
    expect(moved.body.requirement.name).toBe("有项目的卡");

    // 改名 / 改色 / 排序
    const renamed = await api(ownerToken, `/api/requirements/projects/${tmai.body.project.id}${q}`, { method: "PATCH", body: JSON.stringify({ name: "TMAI 平台", color: "#0891b2", sort: -1 }) });
    expect(renamed.body.project).toMatchObject({ name: "TMAI 平台", color: "#0891b2", sort: -1 });
    expect((await api(ownerToken, `/api/requirements/projects/${tmai.body.project.id}${q}`, { method: "PATCH", body: JSON.stringify({ name: "军团项目" }) })).status).toBe(409);
    expect((await api(ownerToken, `/api/requirements/projects${q}`)).body.projects[0].name).toBe("TMAI 平台");

    // 归档:引用保留,但不能再被选
    const archived = await api(ownerToken, `/api/requirements/projects/${tmai.body.project.id}${q}`, { method: "PATCH", body: JSON.stringify({ archived: true }) });
    expect(archived.body.project.archived).toBe(true);
    const kept = (await api(ownerToken, "/api/requirements")).body.requirements.find((r: any) => r.id === card.body.requirement.id);
    expect(kept.project_id).toBe(tmai.body.project.id);
    expect((await api(ownerToken, `/api/requirements/${bare.body.requirement.id}`, { method: "PATCH", body: JSON.stringify({ project_id: tmai.body.project.id }) })).body.error).toBe("project_archived");

    // 删除:卡片一张不少,引用置空
    await api(ownerToken, `/api/requirements/${bare.body.requirement.id}`, { method: "PATCH", body: JSON.stringify({ project_id: legion.body.project.id }) });
    const before = (await api(ownerToken, "/api/requirements")).body.requirements.length;
    expect((await api(viewerToken, `/api/requirements/projects/${legion.body.project.id}${q}`, { method: "DELETE" })).status).toBe(403);
    const del = await api(ownerToken, `/api/requirements/projects/${legion.body.project.id}${q}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const after = (await api(ownerToken, "/api/requirements")).body.requirements;
    expect(after.length).toBe(before);
    expect(after.find((r: any) => r.id === bare.body.requirement.id).project_id).toBeNull();
    expect((await api(ownerToken, `/api/requirements/projects${q}`)).body.projects.map((p: any) => p.name)).toEqual(["TMAI 平台"]);
    // 清空卡片项目
    expect((await api(ownerToken, path, { method: "PATCH", body: JSON.stringify({ project_id: null }) })).body.requirement.project_id).toBeNull();
  });

  test("due accepts date-only (all day) and an ISO datetime with offset, stored as UTC to the second", async () => {
    const make = (due: unknown) => api(ownerToken, "/api/requirements", { method: "POST", body: JSON.stringify({ name: "期限", due }) });
    const shanghai = await make("2026-10-01T18:30:45+08:00");
    expect(shanghai.status).toBe(201);
    expect(shanghai.body.requirement.due).toBe("2026-10-01T10:30:45Z");
    expect((await make("2026-10-01T10:30:45Z")).body.requirement.due).toBe("2026-10-01T10:30:45Z");
    expect((await make("2026-10-01T10:30Z")).body.requirement.due).toBe("2026-10-01T10:30:00Z");
    expect((await make("2026-10-01T10:30:45.987-04:00")).body.requirement.due).toBe("2026-10-01T14:30:45Z");
    // 跨日:东八区的 00:30 是 UTC 前一天
    expect((await make("2026-10-01T00:30:00+08:00")).body.requirement.due).toBe("2026-09-30T16:30:00Z");
    // 旧的全天值原样
    const legacy = await make("2026-10-01");
    expect(legacy.body.requirement.due).toBe("2026-10-01");
    for (const bad of ["2026-10-01T18:30:45", "2026-10-01 18:30:45+08:00", "2026-02-30T10:00:00Z", "2026-10-01T24:00:00Z", "2026-10-01T10:60:00Z", "2026-10-01T10:00:61Z", "2026-10-01T10:00:00+15:00", "明天", "2026-10-1"]) {
      const r = await make(bad);
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("invalid_due");
    }
    const path = `/api/requirements/${legacy.body.requirement.id}`;
    const patched = await api(ownerToken, path, { method: "PATCH", body: JSON.stringify({ due: "2026-12-31T23:59:59-08:00" }) });
    expect(patched.body.requirement.due).toBe("2027-01-01T07:59:59Z");
    expect((await api(ownerToken, path, { method: "PATCH", body: JSON.stringify({ due: "2026-12-31" }) })).body.requirement.due).toBe("2026-12-31");
    expect((await api(ownerToken, path, { method: "PATCH", body: JSON.stringify({ due: "T" }) })).status).toBe(400);
    expect((await api(ownerToken, path, { method: "PATCH", body: JSON.stringify({ due: "" }) })).body.requirement.due).toBe("");
    const listed = await api(ownerToken, "/api/requirements");
    expect(listed.body.capabilities).toContain("due_datetime");
    expect(listed.body.capabilities).toEqual(["agent_owner", "description", "checklist", "projects", "due_datetime", "external_ref", "archived", "agent_api", "sub_requirements", "tags", "priority_lowest", "start_date", "requirement_seq"]);
  });

  test("sub-requirements: parent_id in the same network, no cycles, ≤ 5 levels, child counts, filters, delete detaches children", async () => {
    const mk = async (name: string, extra: Record<string, unknown> = {}) => (await api(ownerToken, "/api/requirements", { method: "POST", body: JSON.stringify({ name, network_id: ownerNetwork, ...extra }) })).body.requirement;
    const root = await mk("父需求");
    const a = await mk("子 A", { parent_id: root.id });
    const b = await mk("子 B", { parent_id: root.id, column: "done" });
    expect(a.parent_id).toBe(root.id);
    const parent = (await api(ownerToken, `/api/requirements/${root.id}`)).body.requirement;
    expect(parent.children).toEqual({ total: 2, done: 1 });
    expect(parent.parent_id).toBeNull();
    // 过滤
    const kids = await api(ownerToken, `/api/requirements?network_id=${ownerNetwork}&parent_id=${root.id}`);
    expect(kids.body.requirements.map((r: any) => r.id).sort()).toEqual([a.id, b.id].sort());
    const top = await api(ownerToken, `/api/requirements?network_id=${ownerNetwork}&top_level=1`);
    expect(top.body.requirements.some((r: any) => r.id === root.id)).toBe(true);
    expect(top.body.requirements.some((r: any) => r.id === a.id)).toBe(false);
    // 成环:把父卡挂到自己的子卡下 / 挂到自己
    expect((await api(ownerToken, `/api/requirements/${root.id}`, { method: "PATCH", body: JSON.stringify({ parent_id: a.id }) })).body.error).toBe("parent_cycle");
    expect((await api(ownerToken, `/api/requirements/${a.id}`, { method: "PATCH", body: JSON.stringify({ parent_id: a.id }) })).body.error).toBe("parent_cycle");
    // 深度:第 5 层可以,第 6 层不行;把一棵 2 层的子树挂到第 4 层下面也不行
    let chain = root;
    const levels = [root];
    for (let i = 2; i <= 5; i++) { chain = await mk(`第 ${i} 层`, { parent_id: chain.id }); levels.push(chain); }
    expect(chain.parent_id).toBe(levels[3].id);
    expect((await api(ownerToken, "/api/requirements", { method: "POST", body: JSON.stringify({ name: "第 6 层", network_id: ownerNetwork, parent_id: chain.id }) })).body.error).toBe("parent_too_deep");
    const subtree = await mk("子树根");
    await mk("子树叶", { parent_id: subtree.id });
    expect((await api(ownerToken, `/api/requirements/${subtree.id}`, { method: "PATCH", body: JSON.stringify({ parent_id: levels[3].id }) })).body.error).toBe("parent_too_deep");
    expect((await api(ownerToken, `/api/requirements/${subtree.id}`, { method: "PATCH", body: JSON.stringify({ parent_id: levels[2].id }) })).status).toBe(200);
    // 别的网络的卡当父卡:拒绝;坏 id:拒绝
    const foreign = (await api(otherToken, "/api/requirements", { method: "POST", body: JSON.stringify({ name: "别的网络的" }) })).body.requirement;
    expect((await api(ownerToken, `/api/requirements/${a.id}`, { method: "PATCH", body: JSON.stringify({ parent_id: foreign.id }) })).body.error).toBe("parent_not_found");
    expect((await api(otherToken, `/api/requirements/${foreign.id}`, { method: "PATCH", body: JSON.stringify({ parent_id: root.id }) })).body.error).toBe("parent_not_found");
    expect((await api(ownerToken, `/api/requirements/${a.id}`, { method: "PATCH", body: JSON.stringify({ parent_id: "bad id!" }) })).body.error).toBe("invalid_parent_id");
    // 解挂
    expect((await api(ownerToken, `/api/requirements/${b.id}`, { method: "PATCH", body: JSON.stringify({ parent_id: null }) })).body.requirement.parent_id).toBeNull();
    // 删父卡:子卡保留、变顶层
    const before = (await api(ownerToken, `/api/requirements?network_id=${ownerNetwork}`)).body.requirements.length;
    expect((await api(ownerToken, `/api/requirements/${root.id}`, { method: "DELETE" })).status).toBe(200);
    const after = (await api(ownerToken, `/api/requirements?network_id=${ownerNetwork}`)).body.requirements;
    expect(after.length).toBe(before - 1);
    expect(after.find((r: any) => r.id === a.id).parent_id).toBeNull();
    expect(after.find((r: any) => r.id === levels[1].id).parent_id).toBeNull();
    expect(after.find((r: any) => r.id === levels[2].id).parent_id).toBe(levels[1].id);
  });

  test("old-app compat: owner {kind:'node'} without agent_owner becomes agent_owner (200 + flag); new clients stay strict", async () => {
    const { db } = await import('./db.js');
    const ownerId = db.get<{ owner_id: string }>('SELECT owner_id FROM networks WHERE network_id=?1', ownerNetwork)!.owner_id;
    db.run('INSERT OR IGNORE INTO nodes(node_id,node_name,alias,network_id) VALUES (?1,?2,?2,?3)', ['compat-node', 'compat-node', ownerNetwork]);
    const node = { kind: 'node', id: 'compat-node' };
    const human = { kind: 'user', id: ownerId };
    const card = (await api(ownerToken, '/api/requirements', { method: 'POST', body: JSON.stringify({ name: '旧 App 的卡', owner: human }) })).body.requirement;
    const path = `/api/requirements/${card.id}`;
    // 0.2.142 的详情保存:{name?, owner:{node}} —— 不带 agent_owner
    const old = await api(ownerToken, path, { method: 'PATCH', body: JSON.stringify({ owner: node }) });
    expect(old.status).toBe(200);
    expect(old.body.owner_coerced_to_agent_owner).toBe(true);
    // 回显给旧客户端的 owner 是它设的那个节点(它按这个核对「保存生效」);agent_owner 也在
    expect(old.body.requirement.owner).toEqual(node);
    expect(old.body.requirement.agent_owner).toEqual(node);
    // 实际存储:负责人清空,负责 Agent = 节点;GET 看到的是真实值
    const stored = (await api(ownerToken, path)).body.requirement;
    expect(stored.owner).toBeNull();
    expect(stored.agent_owner).toEqual(node);
    const row = db.get<{ owner_json: string | null; agent_owner_json: string | null }>('SELECT owner_json, agent_owner_json FROM requirements WHERE requirement_id=?1', card.id)!;
    expect(row.owner_json).toBeNull();
    expect(JSON.parse(row.agent_owner_json!)).toEqual(node);
    // 旧 App 新建时选了节点当负责人:同样改写
    const created = await api(ownerToken, '/api/requirements', { method: 'POST', body: JSON.stringify({ name: '旧 App 新建', owner: node, assignee: '' }) });
    expect(created.status).toBe(201);
    expect(created.body.owner_coerced_to_agent_owner).toBe(true);
    expect((await api(ownerToken, `/api/requirements/${created.body.requirement.id}`)).body.requirement.agent_owner).toEqual(node);
    // 旧 App 设人类负责人:照常,不带标志
    const normal = await api(ownerToken, path, { method: 'PATCH', body: JSON.stringify({ owner: human }) });
    expect(normal.body.owner_coerced_to_agent_owner).toBeUndefined();
    expect(normal.body.requirement.owner).toEqual(human);
    expect(normal.body.requirement.agent_owner).toEqual(node);
    // 新客户端带 agent_owner:严格
    expect((await api(ownerToken, path, { method: 'PATCH', body: JSON.stringify({ owner: node, agent_owner: node }) })).body.error).toBe('owner_must_be_human');
    // 节点不在网络里:仍然 400(不因为兼容放宽成员校验)
    expect((await api(ownerToken, path, { method: 'PATCH', body: JSON.stringify({ owner: { kind: 'node', id: 'foreign-person-node' } }) })).status).toBe(400);
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

  test("agent API: a node token reads / creates / patches in its own network only; cannot delete; who did what is recorded", async () => {
    const { db } = await import("./db.js");
    const { createNetworkTokenForNode, register } = await import("./auth.js");
    const ownerId = db.get<{ owner_id: string }>("SELECT owner_id FROM networks WHERE network_id=?1", ownerNetwork)!.owner_id;
    const bound = createNetworkTokenForNode(ownerId, ownerNetwork, "sync-bot", "node_sync_bot");
    expect(bound.ok).toBe(true);
    const bot = bound.token!;
    // 读
    const listed = await api(bot, "/api/requirements");
    expect(listed.status).toBe(200);
    expect(listed.body.requirements.length).toBeGreaterThan(0);
    // 建:记下是哪个节点建的
    const made = await api(bot, "/api/requirements", { method: "POST", body: JSON.stringify({ name: "Agent 建的任务", column: "doing", checklist: [{ id: "x", text: "第一步" }] }) });
    expect(made.status).toBe(201);
    expect(made.body.requirement.created_by).toEqual({ kind: "node", id: "node_sync_bot" });
    expect(made.body.requirement.updated_by).toEqual({ kind: "node", id: "node_sync_bot" });
    const path = `/api/requirements/${made.body.requirement.id}`;
    // 按 id 读、改、勾、归档
    expect((await api(bot, path)).body.requirement.name).toBe("Agent 建的任务");
    expect((await api(bot, path, { method: "PATCH", body: JSON.stringify({ column: "done" }) })).body.requirement.column).toBe("done");
    expect((await api(bot, `${path}/checklist/x`, { method: "PATCH", body: JSON.stringify({ done: true }) })).body.requirement.checklist[0].done).toBe(true);
    // 人改了之后 updated_by 变成人
    const human = await api(ownerToken, path, { method: "PATCH", body: JSON.stringify({ priority: "high" }) });
    expect(human.body.requirement.updated_by).toEqual({ kind: "user", id: ownerId });
    expect(human.body.requirement.created_by).toEqual({ kind: "node", id: "node_sync_bot" });
    // 不能删,只能归档;归档的默认不在列表里
    const del = await api(bot, path, { method: "DELETE" });
    expect(del.status).toBe(403);
    expect(del.body.error).toBe("user_token_required");
    expect((await api(bot, path, { method: "PATCH", body: JSON.stringify({ archived: true }) })).body.requirement.archived).toBe(true);
    expect((await api(ownerToken, "/api/requirements")).body.requirements.some((r: any) => r.id === made.body.requirement.id)).toBe(false);
    expect((await api(ownerToken, "/api/requirements?include_archived=1")).body.requirements.some((r: any) => r.id === made.body.requirement.id)).toBe(true);
    expect((await api(bot, path, { method: "PATCH", body: JSON.stringify({ archived: "yes" }) })).status).toBe(400);
    // 别的网络的节点令牌:看不到、改不了、也不能往别的网络里建
    const outsider = register(`req_outsider_${Date.now()}`, "RequirementsOutsider123!", undefined, "seed");
    const foreignTok = createNetworkTokenForNode(outsider.user!.user_id, outsider.network_id!, "foreign-bot", "node_foreign_bot");
    expect(foreignTok.ok).toBe(true);
    const foreign = foreignTok.token!;
    expect((await api(foreign, `/api/requirements?include_archived=1`)).body.requirements.some((r: any) => r.id === made.body.requirement.id)).toBe(false);
    expect((await api(foreign, path)).status).toBe(404);
    expect((await api(foreign, path, { method: "PATCH", body: JSON.stringify({ name: "越界" }) })).status).toBe(404);
    expect((await api(foreign, `${path}/checklist/x`, { method: "PATCH", body: JSON.stringify({ done: false }) })).status).toBe(404);
    const planted = await api(foreign, "/api/requirements", { method: "POST", body: JSON.stringify({ name: "塞进别的网络", network_id: ownerNetwork }) });
    expect(planted.status).toBe(201);
    // 写进的是它自己的网络(令牌绑定的网络优先于 body 里的 network_id)。owner 在测试库里是管理员,所以按网络查。
    expect((await api(ownerToken, `/api/requirements?network_id=${ownerNetwork}`)).body.requirements.some((r: any) => r.id === planted.body.requirement.id)).toBe(false);
    expect((await api(foreign, `/api/requirements/${planted.body.requirement.id}`)).status).toBe(200);
    // 人照常能删
    const humanDel = await api(ownerToken, path, { method: "DELETE" });
    expect(humanDel.status).toBe(200);
    expect((await api(ownerToken, path)).status).toBe(404);
    expect((await api(viewerToken, `/api/requirements/${planted.body.requirement.id}`, { method: "DELETE" })).status).toBe(404);
  });

  test("external_ref: unique per network, 409 with the existing id, upsert is idempotent, list filters", async () => {
    const { db } = await import("./db.js");
    const { createNetworkTokenForNode } = await import("./auth.js");
    const ownerId = db.get<{ owner_id: string }>("SELECT owner_id FROM networks WHERE network_id=?1", ownerNetwork)!.owner_id;
    const bot = createNetworkTokenForNode(ownerId, ownerNetwork, "gh-sync", "node_gh_sync").token!;
    const ref = "github:acme/widgets#123";
    const first = await api(bot, "/api/requirements/upsert", { method: "POST", body: JSON.stringify({ external_ref: ref, external_url: "https://github.com/acme/widgets/issues/123", name: "Issue 标题", description: "issue 正文" }) });
    expect(first.status).toBe(201);
    expect(first.body.created).toBe(true);
    expect(first.body.requirement.external_ref).toBe(ref);
    expect(first.body.requirement.external_url).toBe("https://github.com/acme/widgets/issues/123");
    // 同一个 issue 再同步:改,不重复建;省略的字段(状态)保留
    await api(ownerToken, `/api/requirements/${first.body.requirement.id}`, { method: "PATCH", body: JSON.stringify({ column: "doing" }) });
    const again = await api(bot, "/api/requirements/upsert", { method: "POST", body: JSON.stringify({ external_ref: ref, name: "Issue 改过的标题" }) });
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(again.body.requirement.id).toBe(first.body.requirement.id);
    expect(again.body.requirement.name).toBe("Issue 改过的标题");
    expect(again.body.requirement.column).toBe("doing");
    const same = await api(bot, "/api/requirements/upsert", { method: "POST", body: JSON.stringify({ external_ref: ref }) });
    expect(same.body.created).toBe(false);
    expect((await api(ownerToken, `/api/requirements?external_ref=${encodeURIComponent(ref)}`)).body.requirements.length).toBe(1);
    // 普通 POST 撞同一个 external_ref:409 + 已有 id
    const dup = await api(ownerToken, "/api/requirements", { method: "POST", body: JSON.stringify({ name: "重复", external_ref: ref }) });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe("external_ref_exists");
    expect(dup.body.existing_id).toBe(first.body.requirement.id);
    // PATCH 改成别人已有的 external_ref 也 409
    const other = await api(ownerToken, "/api/requirements", { method: "POST", body: JSON.stringify({ name: "另一个", external_ref: "github:acme/widgets#124" }) });
    expect((await api(ownerToken, `/api/requirements/${other.body.requirement.id}`, { method: "PATCH", body: JSON.stringify({ external_ref: ref }) })).status).toBe(409);
    // 另一个网络可以有同样的 external_ref(唯一只在网络内)
    const elsewhere = await api(otherToken, "/api/requirements", { method: "POST", body: JSON.stringify({ name: "别的网络同一个 issue", external_ref: ref }) });
    expect(elsewhere.status).toBe(201);
    // 坏值
    for (const bad of [{ external_ref: "has space" }, { external_ref: "" }, { external_url: "javascript:alert(1)" }]) {
      expect((await api(ownerToken, "/api/requirements", { method: "POST", body: JSON.stringify({ name: "坏", ...bad }) })).status).toBe(400);
    }
    expect((await api(bot, "/api/requirements/upsert", { method: "POST", body: JSON.stringify({ name: "没有 ref" }) })).body.error).toBe("external_ref_required");
    // 列表筛选
    const byStatus = await api(ownerToken, "/api/requirements?status=doing");
    expect(byStatus.body.requirements.every((r: any) => r.column === "doing")).toBe(true);
    expect((await api(ownerToken, "/api/requirements?status=nope")).status).toBe(400);
    const since = new Date(Date.now() - 60_000).toISOString();
    expect((await api(ownerToken, `/api/requirements?updated_since=${encodeURIComponent(since)}`)).body.requirements.some((r: any) => r.id === first.body.requirement.id)).toBe(true);
    expect((await api(ownerToken, `/api/requirements?updated_since=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`)).body.requirements.length).toBe(0);
    expect((await api(ownerToken, "/api/requirements?updated_since=nope")).status).toBe(400);
    const human = { kind: "user", id: ownerId };
    await api(ownerToken, `/api/requirements/${other.body.requirement.id}`, { method: "PATCH", body: JSON.stringify({ owner: human }) });
    expect((await api(ownerToken, `/api/requirements?owner=user:${ownerId}`)).body.requirements.map((r: any) => r.id)).toContain(other.body.requirement.id);
    expect((await api(ownerToken, "/api/requirements?owner=bad")).status).toBe(400);
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
