import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "./db.js";
import { register } from "./auth.js";
import { registerTools } from "./tools.js";
import { hostSupervisorIdentityRows } from "./host-supervisor-identity.js";

if (!process.env.COMMHUB_DB && !process.env.COMMHUB_TEST_PG_URL) throw Error("explicit fixture DB required");
let net: string, foreign: string, user: string, token: string, hub: any, base: string;
let sequence = 0;
const next = () => `n_lhs1109_${++sequence}`;
beforeAll(async () => {
  const auth = register(`lhs1109_${Date.now()}`, "FixturePassword1109!", undefined, "fixture");
  if (!auth.ok || !auth.token || !auth.user || !auth.network_id) throw Error("fixture registration failed");
  user = auth.user.user_id; token = auth.token; net = auth.network_id;
  foreign = `net_foreign_lhs1109_${Date.now()}`;
  db.run("INSERT INTO networks(network_id,network_name,owner_id) VALUES(?1,'foreign',?2)", [foreign, user]);
  process.env.HOST = "127.0.0.1";
  const { bootServer } = await import("./server.js");
  hub = await bootServer({ port: 0 }); base = `http://127.0.0.1:${hub.port}`;
}, 30_000);
beforeEach(() => {
  db.run("DELETE FROM api_tokens WHERE name LIKE 'node:lhs1109_%'");
  db.run("DELETE FROM sessions WHERE alias LIKE 'lhs1109_%'");
  db.run("DELETE FROM nodes WHERE alias LIKE 'lhs1109_%'");
});
afterAll(() => hub?.stop(true));

function node(alias: string, network = net, owner: string | null = user) {
  const id = next();
  db.run(`INSERT INTO nodes(node_id,node_name,alias,network_id,owner_user_id,config_snapshot)
    VALUES(?1,?2,?2,?3,?4,'{"role":"host_supervisor"}')`, [id, `lhs1109_${alias}`, network, owner]);
  return id;
}
function credential(id: string, opts: { bound?: string | null; name?: string; issuer?: string; epoch?: number; network?: string; scope?: string; expired?: boolean; revoked?: boolean } = {}) {
  const n = db.get<any>("SELECT alias, network_id FROM nodes WHERE node_id=?1", id)!;
  const tid = `tok_lhs1109_${++sequence}`;
  db.run(`INSERT INTO api_tokens(token_id,token_hash,user_id,network_id,scope,name,bound_node_id,node_identity_epoch,expires_at,revoked_at)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`, [tid, `hash_${tid}`, opts.issuer ?? user,
    opts.network ?? n.network_id, opts.scope ?? "network", `node:${opts.name ?? n.alias}`,
    opts.bound === undefined ? id : opts.bound, opts.epoch ?? 2,
    opts.expired ? "2000-01-01 00:00:00" : null, opts.revoked ? "2000-01-01 00:00:00" : null]);
  return tid;
}
function heartbeat(id: string, opts: { bound?: string | null; network?: string | null; alias?: string; age?: number } = {}) {
  const n = db.get<any>("SELECT alias,network_id FROM nodes WHERE node_id=?1", id)!;
  db.run(`INSERT INTO sessions(resume_id,alias,network_id,node_id,last_seen_at,status,cpu_cores,mem_total_gb,ip)
    VALUES(?1,?2,?3,?4,?5,'idle',8,16,'10.1.1.1')`, [`s_lhs1109_${++sequence}`, opts.alias ?? n.alias,
    opts.network === undefined ? n.network_id : opts.network, opts.bound === undefined ? id : opts.bound,
    new Date(Date.now() - (opts.age ?? 0)).toISOString()]);
}
async function list(entry: "MCP" | "REST") {
  if (entry === "REST") {
    const r = await fetch(`${base}/api/host-supervisors?network_id=${net}`, { headers: { Authorization: `Bearer ${token}` } });
    expect(r.status).toBe(200); return (await r.json() as any).daemons as any[];
  }
  const server = new McpServer({ name: "fixture", version: "0" }) as any;
  let handler: any;
  const original = server.tool.bind(server);
  server.tool = (name: string, desc: string, schema: any, fn: any) => {
    if (name === "list_host_supervisors") handler = fn;
    return original(name, desc, schema, fn);
  };
  registerTools(server, undefined, null, user, null, false, null);
  const result = await handler({ network_id: net });
  const parsed = JSON.parse(result.content[0].text); expect(parsed.ok).toBe(true); return parsed.daemons as any[];
}
for (const entry of ["MCP", "REST"] as const) {
  test(`${entry}: bound credentials survive stale token names and rotations dedupe`, async () => {
    const id = node("renamed"); credential(id, { name: "lhs1109_oldname" }); credential(id); heartbeat(id);
    const rows = await list(entry); expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ daemon_node_id: id, online: true });
    expect(JSON.stringify(rows)).not.toContain("hash_");
  });
  test(`${entry}: same-name foreign binding and missing bound node cannot authenticate daemon`, async () => {
    const id = node("victim"), other = node("victim", foreign);
    credential(id, { bound: other }); credential(id, { bound: "n_lhs1109_missing" }); heartbeat(id);
    expect(await list(entry)).toEqual([]);
  });
  test(`${entry}: legacy owner and epoch-zero ownerless keep compatibility; squatter and new ownerless rejected`, async () => {
    const good = node("owned"), old = node("old", net, null), squatter = node("squatter"), recent = node("recent", net, null);
    credential(good, { bound: null }); credential(old, { bound: null, epoch: 0 });
    credential(squatter, { bound: null, issuer: "u_foreign_fixture" }); credential(recent, { bound: null, epoch: 1 });
    const ids = (await list(entry)).map(r => r.daemon_node_id).sort(); expect(ids).toEqual([good, old].sort());
  });
  test(`${entry}: same-alias sibling heartbeat cannot make stopped daemon online`, async () => {
    const stopped = node("duplicate"), live = node("duplicate"); credential(stopped); credential(live); heartbeat(live);
    const rows = await list(entry);
    expect(rows.find(r => r.daemon_node_id === stopped)).toMatchObject({ online: false, last_seen_at: null });
    expect(rows.find(r => r.daemon_node_id === live)).toMatchObject({ online: true });
  });
  test(`${entry}: null-ID heartbeat requires unique alias in its network`, async () => {
    const unique = node("unique"), a = node("ambiguous"), b = node("ambiguous");
    for (const id of [unique,a,b]) credential(id);
    heartbeat(unique, { bound: null }); heartbeat(a, { bound: null });
    const rows = await list(entry);
    expect(rows.find(r => r.daemon_node_id === unique).online).toBe(true);
    expect(rows.filter(r => r.daemon_node_id !== unique).map(r => r.online)).toEqual([false,false]);
  });
  test(`${entry}: null-network legacy heartbeat is accepted only for globally unique aliases`, async () => {
    const unique = node("globalunique"), shared = node("globalshared"); node("globalshared", foreign);
    credential(unique); credential(shared);
    // Fresh sessions is NOT NULL. Exercise the historical nullable shape in
    // an actual temporary SQL table, without changing the production schema
    // or mocking returned rows. Only the heartbeat read uses this table;
    // the production node/token/scoped SQL and both HTTP/MCP paths stay real.
    db.exec("CREATE TEMP TABLE lhs1109_legacy_sessions AS SELECT * FROM sessions WHERE 0=1");
    for (const id of [unique, shared]) {
      const n = db.get<any>("SELECT alias FROM nodes WHERE node_id=?1", id)!;
      db.run(`INSERT INTO lhs1109_legacy_sessions(resume_id,alias,network_id,node_id,last_seen_at,updated_at,status)
        VALUES(?1,?2,NULL,NULL,?3,?3,'idle')`, [`s_lhs1109_${++sequence}`, n.alias, new Date().toISOString()]);
    }
    const original = db.all.bind(db);
    db.all = ((sql: string, ...params: any[]) => original(sql.replace("FROM sessions s", "FROM lhs1109_legacy_sessions s"), ...params)) as any;
    try {
      const rows = await list(entry);
      expect(rows.find(r => r.daemon_node_id === unique).online).toBe(true);
      expect(rows.find(r => r.daemon_node_id === shared).online).toBe(false);
    } finally {
      db.all = original;
      db.exec("DROP TABLE lhs1109_legacy_sessions");
    }
  });
  test(`${entry}: bound heartbeat ignores stale alias but refuses wrong network and stale timestamps`, async () => {
    const renamed = node("newalias"), wrong = node("wrongnet"), stale = node("stale");
    for (const id of [renamed,wrong,stale]) credential(id);
    heartbeat(renamed, { alias: "lhs1109_stalealias" }); heartbeat(wrong, { network: foreign }); heartbeat(stale, { age: 360_000 });
    const rows = await list(entry);
    expect(rows.find(r => r.daemon_node_id === renamed).online).toBe(true);
    expect(rows.filter(r => r.daemon_node_id !== renamed).map(r => r.online)).toEqual([false,false]);
  });
  test(`${entry}: unbound duplicate-owner disambiguation uses authoritative recent session`, async () => {
    const a = node("unboundduplicate"), b = node("unboundduplicate"); credential(a, { bound: null }); heartbeat(b);
    const rows = await list(entry); expect(rows.length).toBe(1); expect(rows[0]).toMatchObject({ daemon_node_id: b, online: true });
  });
  test(`${entry}: deleted, revoked, expired and wrong-scope credentials excluded`, async () => {
    for (const [label,opts] of [["expired",{ expired:true }],["revoked",{ revoked:true }],["scope",{ scope:"full" }],["deleted",{}]] as const) {
      const id = node(label), tid = credential(id, opts); heartbeat(id);
      if (label === "deleted") db.run("DELETE FROM api_tokens WHERE token_id=?1", [tid]);
    }
    expect(await list(entry)).toEqual([]);
  });
}
test("batched list performs three reads for many daemons and multiple scoped networks", () => {
  for (let i=0;i<30;i++) { const id=node(`fleet${i}`, i%2 ? net : foreign); credential(id); heartbeat(id); }
  const original = db.all.bind(db); let reads=0;
  db.all = ((sql: string, ...params: any[]) => { reads++; return original(sql, ...params); }) as any;
  try {
    const rows = hostSupervisorIdentityRows("SELECT * FROM nodes WHERE network_id=?1 OR network_id=?2", [net,foreign]);
    expect(rows.length).toBe(30); expect(reads).toBe(3);
  } finally { db.all = original; }
});
