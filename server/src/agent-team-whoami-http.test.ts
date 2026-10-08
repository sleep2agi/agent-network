import { beforeAll, afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";

process.env.COMMHUB_DB ||= `${mkdtempSync('/tmp/team-whoami-')}/hub.db`;
let db: any, hub: any, base: string, owner: any, outside: any;
let selfToken: string, otherToken: string, outsideToken: string, unboundToken: string;
const SELF = 'node_team_whoami_self', OTHER = 'node_team_whoami_other', FOREIGN = 'node_team_whoami_foreign';
const TEAM = 'team_whoami_child', ROOT = 'team_whoami_root';

async function rpc(token: string, method = 'tools/call', params: unknown = { name: 'org_whoami', arguments: {} }) {
  const response = await fetch(`${base}/mcp`, { method: 'POST', headers: {
    Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26',
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  expect(response.status).toBe(200);
  const text = await response.text();
  const line = text.split('\n').filter(x => x.startsWith('data:')).at(-1);
  const body = JSON.parse(line ? line.slice(5) : text);
  expect(body.error).toBeUndefined();
  return body.result;
}
async function who(token = selfToken, args: Record<string, unknown> = {}) {
  const result = await rpc(token, 'tools/call', { name: 'org_whoami', arguments: args });
  return JSON.parse(result.content[0].text);
}

beforeAll(async () => {
  ({ db } = await import('./db.js'));
  const { register, createNetworkTokenForNode } = await import('./auth.js');
  owner = register('team_whoami_owner', 'Fixture-Passw0rd!xyz');
  outside = register('team_whoami_outside', 'Fixture-Passw0rd!xyz');
  db.run("UPDATE users SET display_name = 'Team owner' WHERE user_id = ?1", [owner.user.user_id]);
  const mint = (u: any, alias: string, node?: string) => {
    const r = createNetworkTokenForNode(u.user.user_id, u.network_id, alias, node);
    expect(r.error ?? null).toBe(null); return r.token!;
  };
  selfToken = mint(owner, 'team-self', SELF);
  otherToken = mint(owner, 'team-other', OTHER);
  outsideToken = mint(outside, 'team-self', FOREIGN); // Same alias in a different network.
  unboundToken = mint(owner, 'team-unregistered');
  const { bootServer } = await import('./server.js');
  hub = bootServer({ port: 0, hostname: '127.0.0.1' });
  base = `http://127.0.0.1:${hub.port}`;
  for (const [net, id, name, parent] of [
    [owner.network_id, ROOT, 'Parent', null], [owner.network_id, TEAM, 'My team', ROOT],
    [outside.network_id, TEAM, 'Foreign team', null],
  ]) db.run('INSERT INTO network_agent_teams(network_id,team_id,name,parent_id) VALUES(?1,?2,?3,?4)', [net,id,name,parent]);
  db.run('UPDATE network_agent_teams SET lead_node_id=?1,owner_user_id=?2 WHERE network_id=?3 AND team_id=?4', [SELF,owner.user.user_id,owner.network_id,TEAM]);
  for (const [net, node] of [[owner.network_id, SELF], [outside.network_id, FOREIGN]]) {
    db.run('INSERT INTO network_agent_team_members(network_id,node_id,team_id) VALUES(?1,?2,?3)', [net,node,TEAM]);
  }
  // Even a stale/corrupt membership must not project a node from another network.
  db.run('INSERT INTO network_agent_team_members(network_id,node_id,team_id) VALUES(?1,?2,?3)', [owner.network_id,FOREIGN,TEAM]);
}, 60_000);
afterAll(() => hub?.stop(true));

test('exact node team, nearest-first ancestors, Agent lead and private human display name', async () => {
  const r = await who();
  expect(r.ok).toBe(true); expect(r.source).toBe('node'); expect(r.node_id).toBe(SELF);
  expect(r.team).toEqual({ id: TEAM, name: 'My team' });
  expect(r.ancestors).toEqual([{ id: ROOT, name: 'Parent' }]);
  expect(r.lead.node_id).toBe(SELF);
  expect(r.owner).toEqual({ user_id: owner.user.user_id, display_name: 'Team owner' });
  expect(r.agents.map((n: any) => n.node_id)).toEqual([SELF]);
  expect(r.truncated).toBe(false);
  expect(JSON.stringify(r)).not.toContain('team_whoami_owner');
});
test('same-id foreign team and foreign node cannot cross network; supplied identity is ignored', async () => {
  const r = await who(selfToken, { network_id: outside.network_id, node_id: FOREIGN, alias: 'team-other' });
  expect(r.node_id).toBe(SELF); expect(r.team.name).toBe('My team');
  expect(JSON.stringify(r)).not.toContain(FOREIGN);
  const b = await who(outsideToken);
  expect(b.team.name).toBe('Foreign team'); expect(b.node_id).toBe(FOREIGN);
  expect(b.ancestors).toEqual([]); expect(JSON.stringify(b)).not.toContain(SELF);
});
test('unassigned node does not inherit its owner or another node team', async () => {
  expect(await who(otherToken)).toEqual({ ok: true, source: 'none', node_id: OTHER, team: null,
    ancestors: [], lead: null, owner: null, agents: [], truncated: false });
  expect((await who(unboundToken)).error).toBe('node_identity_unbound');
});
test('user credentials cannot list or call; node credentials can list', async () => {
  expect((await rpc(owner.token, 'tools/list', {})).tools.some((t: any) => t.name === 'org_whoami')).toBe(false);
  expect((await who(owner.token)).error).toBe('network_token_required');
  expect((await rpc(selfToken, 'tools/list', {})).tools.some((t: any) => t.name === 'org_whoami')).toBe(true);
});
test('foreign lead and human owner references are not returned', async () => {
  db.run('UPDATE network_agent_teams SET lead_node_id=?1,owner_user_id=?2 WHERE network_id=?3 AND team_id=?4', [FOREIGN,outside.user.user_id,owner.network_id,TEAM]);
  try { const r = await who(); expect(r.lead).toBe(null); expect(r.owner).toBe(null); }
  finally { db.run('UPDATE network_agent_teams SET lead_node_id=?1,owner_user_id=?2 WHERE network_id=?3 AND team_id=?4', [SELF,owner.user.user_id,owner.network_id,TEAM]); }
});
test('large teams are bounded to 50 and explicitly truncated', async () => {
  for (let i = 0; i < 51; i++) {
    const id = `node_team_whoami_cap_${i}`;
    db.run('INSERT INTO nodes(node_id,node_name,alias,network_id) VALUES(?1,?1,?1,?2)', [id,owner.network_id]);
    db.run('INSERT INTO network_agent_team_members(network_id,node_id,team_id) VALUES(?1,?2,?3)', [owner.network_id,id,TEAM]);
  }
  const r = await who(); expect(r.agents.length).toBe(50); expect(r.truncated).toBe(true);
});
