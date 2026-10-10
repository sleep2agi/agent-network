import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "adoption-candidates-"));
process.env.COMMHUB_DB ||= join(dir, "hub.db");
process.env.COMMHUB_AUTH_TOKEN ||= "adoption-candidates-master-fixture";
const WORKDIR = "/home/example/adoption-candidate-workdir-654";
const SECRET = "ntok_should_not_surface";
let hub: { stop: (closeActiveConnections?: boolean) => void; port: number }, base: string;
let db: any, owner: any, member: any, nodeOwner: any, other: any, daemonToken: string;
const ids = { daemon: "n_cand_daemon", hand: "n_cand_hand", foreign: "n_cand_foreign" };

const get = async (path: string, token = owner.token) => {
  const res = await fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.json() as any, text: "" };
};
const raw = async (path: string, token = owner.token) => {
  const res = await fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) };
};

function snapshot(candidates: unknown, adopt = true) {
  return JSON.stringify({
    role: "host_supervisor",
    daemon_capabilities: { adopt_capable: adopt, adoption_candidates: candidates },
  });
}

beforeAll(async () => {
  ({ db } = await import("./db.js"));
  const { register } = await import("./auth.js");
  const suffix = Date.now();
  owner = register(`cand_owner_${suffix}`, "CandFixture-Strong1!");
  member = register(`cand_member_${suffix}`, "CandFixture-Strong1!");
  nodeOwner = register(`cand_node_owner_${suffix}`, "CandFixture-Strong1!");
  other = register(`cand_other_${suffix}`, "CandFixture-Strong1!");
  expect(owner.ok && member.ok && nodeOwner.ok && other.ok).toBe(true);
  for (const user of [owner, member, nodeOwner, other]) db.run("UPDATE users SET role='user' WHERE user_id=?1", [user.user.user_id]);
  db.run("INSERT INTO network_members(network_id,user_id,role) VALUES(?1,?2,'member')", [owner.network_id, member.user.user_id]);
  db.run("INSERT INTO network_members(network_id,user_id,role) VALUES(?1,?2,'member')", [owner.network_id, nodeOwner.user.user_id]);
  const candidate = { node_id: ids.hand, alias: "hand-node", workdir: WORKDIR, runtime: "claude-agent-sdk", launch_hint: "tmux", token: SECRET, env: { API_KEY: SECRET } };
  db.run("INSERT INTO nodes(node_id,node_name,alias,network_id,owner_user_id,hostname,config_snapshot) VALUES(?1,?2,?2,?3,?4,'fixture-host',?5)",
    [ids.daemon, "cand-daemon", owner.network_id, owner.user.user_id, snapshot([candidate, { node_id: "n_missing", alias: "nope", workdir: "/tmp/nope", launch_hint: "bare" }])]);
  db.run("INSERT INTO nodes(node_id,node_name,alias,network_id,owner_user_id,hostname,config_snapshot) VALUES(?1,?2,?2,?3,?4,'fixture-host','{}')",
    [ids.hand, "hand-node", owner.network_id, nodeOwner.user.user_id]);
  db.run("INSERT INTO nodes(node_id,node_name,alias,network_id,owner_user_id,hostname) VALUES(?1,?2,?2,?3,?4,'other-host')",
    [ids.foreign, "foreign-node", other.network_id, other.user.user_id]);
  db.run("INSERT INTO sessions(resume_id,alias,node_id,network_id,status,last_seen_at) VALUES('cand-daemon-session','cand-daemon',?1,?2,'idle',datetime('now'))",
    [ids.daemon, owner.network_id]);
  const { generateNetworkToken, hashToken } = await import("./db.js");
  daemonToken = generateNetworkToken();
  db.run("INSERT INTO api_tokens(token_id,user_id,network_id,scope,name,token_hash) VALUES('cand-daemon-token',?1,?2,'network','node:cand-daemon',?3)",
    [owner.user.user_id, owner.network_id, hashToken(daemonToken)]);
  const { bootServer } = await import("./server.js");
  hub = bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${hub.port}`;
}, 30_000);
afterAll(() => hub?.stop(true));

test("owner and node owner see the candidate; the report token stays out", async () => {
  for (const token of [owner.token, nodeOwner.token]) {
    const r = await raw(`/api/adoption-candidates?network_id=${owner.network_id}`, token);
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(1);
    expect(r.body.candidates).toEqual([{
      node_id: ids.hand, alias: "hand-node", daemon_node_id: ids.daemon, daemon_alias: "cand-daemon",
      hostname: "fixture-host", workdir: WORKDIR, runtime: "claude-agent-sdk", launch_hint: "tmux",
    }]);
    expect(r.text).not.toContain(SECRET);
    expect(r.text).toContain(WORKDIR);
  }
  const supervisors = await raw(`/api/host-supervisors?network_id=${owner.network_id}`);
  expect(supervisors.body.daemons.find((d: any) => d.daemon_node_id === ids.daemon).adoption_discovery).toBe(true);
  expect(supervisors.text).not.toContain(WORKDIR);
  expect(supervisors.text).not.toContain(SECRET);
  const nodes = await raw(`/api/nodes?network_id=${owner.network_id}`);
  expect(nodes.text).not.toContain("adoption_candidate");
  expect(nodes.text).not.toContain(WORKDIR);
});

test("member, other network, daemon token, and query token do not receive the workdir", async () => {
  const memberRes = await raw(`/api/adoption-candidates?network_id=${owner.network_id}`, member.token);
  expect(memberRes.status).toBe(200);
  expect(memberRes.body.candidates).toEqual([]);
  expect(memberRes.text).not.toContain(WORKDIR);
  const otherRes = await raw(`/api/adoption-candidates?network_id=${owner.network_id}`, other.token);
  expect(otherRes.status).toBe(403);
  expect(otherRes.text).not.toContain(WORKDIR);
  expect((await get("/api/adoption-candidates", daemonToken)).status).toBe(403);
  expect((await get("/api/adoption-candidates", process.env.COMMHUB_AUTH_TOKEN!)).status).toBe(403);
  const queryOnly = await fetch(base + `/api/adoption-candidates?network_id=${owner.network_id}&token=${encodeURIComponent(owner.token)}`);
  expect([401, 403]).toContain(queryOnly.status);
});

test("offline, hostname, alias, binding, and created-node filters drop the hint", async () => {
  const path = `/api/adoption-candidates?network_id=${owner.network_id}`;
  db.run("UPDATE sessions SET last_seen_at='2000-01-01 00:00:00' WHERE alias='cand-daemon'");
  expect((await get(path)).body.candidates).toEqual([]);
  db.run("UPDATE sessions SET last_seen_at=datetime('now') WHERE alias='cand-daemon'");
  expect((await get(path)).body.count).toBe(1);

  db.run("UPDATE nodes SET hostname='elsewhere' WHERE node_id=?1", [ids.hand]);
  expect((await get(path)).body.candidates).toEqual([]);
  db.run("UPDATE nodes SET hostname='fixture-host' WHERE node_id=?1", [ids.hand]);

  db.run("UPDATE nodes SET config_snapshot=?1 WHERE node_id=?2", [snapshot([{ node_id: ids.hand, alias: "other-name", workdir: WORKDIR, launch_hint: "stopped" }]), ids.daemon]);
  expect((await get(path)).body.candidates).toEqual([]);
  db.run("UPDATE nodes SET config_snapshot=?1 WHERE node_id=?2", [snapshot([{ node_id: ids.hand, alias: "hand-node", workdir: WORKDIR, runtime: "claude-agent-sdk", launch_hint: "tmux", token: SECRET }]), ids.daemon]);
  expect((await get(path)).body.count).toBe(1);

  db.run(`INSERT INTO node_daemon_bindings(request_id,network_id,node_id,daemon_node_id,workdir,requested_by,status,created_at,updated_at)
    VALUES('adopt_cand_pending',?1,?2,?3,?4,?5,'pending',1,1)`, [owner.network_id, ids.hand, ids.daemon, WORKDIR, owner.user.user_id]);
  expect((await get(path)).body.candidates).toEqual([]);
  db.run("UPDATE node_daemon_bindings SET status='revoked' WHERE request_id='adopt_cand_pending'");
  expect((await get(path)).body.count).toBe(1);

  db.run(`INSERT INTO node_create_requests(request_id,daemon_node_id,child_node_id,child_name,network_id,runtime,flags_json,env_keys,status,created_at,created_by_token)
    VALUES('cr_cand_hand',?1,?2,'hand-node',?3,'claude-agent-sdk','{}','[]','succeeded',1,'private')`, [ids.daemon, ids.hand, owner.network_id]);
  expect((await get(path)).body.candidates).toEqual([]);
  db.run("DELETE FROM node_create_requests WHERE request_id='cr_cand_hand'");
  expect((await get(path)).body.count).toBe(1);
});

test("discovery flag is absent unless the daemon actually reported a list", async () => {
  const path = `/api/host-supervisors?network_id=${owner.network_id}`;
  db.run("UPDATE nodes SET config_snapshot=?1 WHERE node_id=?2", [JSON.stringify({ role: "host_supervisor", daemon_capabilities: { adopt_capable: true } }), ids.daemon]);
  expect((await get(path)).body.daemons[0].adoption_discovery).toBeUndefined();
  expect((await get(path)).body.daemons[0].adopt_capable).toBe(true);
  db.run("UPDATE nodes SET config_snapshot=?1 WHERE node_id=?2", [snapshot([], true), ids.daemon]);
  expect((await get(path)).body.daemons[0].adoption_discovery).toBe(true);
  expect((await get(`/api/adoption-candidates?network_id=${owner.network_id}`)).body.candidates).toEqual([]);
  const limited = await get(path, member.token);
  expect(limited.body.daemons.find((d: any) => d.daemon_node_id === ids.daemon).adoption_discovery).toBe(true);
});
