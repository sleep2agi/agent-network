import "./require-explicit-test-db";
import { afterAll, beforeEach, expect, test } from "bun:test";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { CodexManagedLogin } from '../../agent-node/src/runtime/codex-managed-login';
import { DaemonCodexLogins } from '../../agent-node/src/runtime/daemon-codex-logins';
import { executeProviderLogin, closeProviderLogins } from '../../agent-node/src/runtime/daemon-provider-login';
import { db } from "./db";
import { registerTools } from "./tools";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { reconcileProviderSnapshots, readLocalProviderSnapshot } from "../../agent-node/src/runtime/daemon-provider-snapshot";
import { DaemonProviderStore } from "../../agent-network/src/daemon-provider-store";
import { register, createNetworkTokenForNode } from "./auth";

const net = "net_dps906", user = "u_dps906", node = "node_dps906", token = "token_dps906", alias = "daemon906";
const root = mkdtempSync(join(tmpdir(), "dps906-"));
function cleanup() {
  db.run('DELETE FROM daemon_provider_logins WHERE request_id IN (SELECT request_id FROM daemon_provider_snapshots WHERE network_id=?1)', [net]);
  db.run('DELETE FROM daemon_provider_applications WHERE request_id IN (SELECT request_id FROM daemon_provider_snapshots WHERE network_id=?1)', [net]);
  db.run('DELETE FROM daemon_provider_writes WHERE request_id IN (SELECT request_id FROM daemon_provider_snapshots WHERE network_id=?1)', [net]);
  db.run('DELETE FROM node_daemon_bindings WHERE network_id=?1', [net]);
  for (const t of ["daemon_provider_snapshots", "nodes", "api_tokens", "network_members"]) db.run(`DELETE FROM ${t} WHERE network_id=?1`, [net]);
  db.run("DELETE FROM networks WHERE network_id=?1", [net]);
  db.run("DELETE FROM users WHERE user_id=?1", [user]);
}
beforeEach(() => {
  cleanup();
  db.run("INSERT INTO users (user_id,username,password_hash,role) VALUES (?1,?1,'x','user')", [user]);
  db.run("INSERT INTO networks (network_id,network_name,owner_id) VALUES (?1,?1,?2)", [net, user]);
  db.run("INSERT INTO network_members (user_id,network_id,role) VALUES (?1,?2,'owner')", [user, net]);
  db.run("INSERT INTO nodes (node_id,node_name,alias,network_id,config_snapshot) VALUES (?1,?2,?2,?3,?4)", [node, alias, net, JSON.stringify({ role: "host_supervisor" })]);
  db.run("INSERT INTO api_tokens (token_id,user_id,network_id,scope,name,token_hash) VALUES (?1,?2,?3,'network',?4,?5)", [token, user, net, `node:${alias}`, `hash_${token}`]);
});
afterAll(() => { cleanup(); rmSync(root, { recursive: true, force: true }); });
function client(kind = "human", network = net) {
  const handlers: Record<string, any> = {};
  // Capture the actual registerTools handlers, including production guards.
  const server = new McpServer({ name: "test906", version: "0" }) as any;
  const tool = server.tool.bind(server), register = server.registerTool.bind(server);
  server.tool = (name: string, description: any, schema: any, handler: any) => { handlers[name] = handler; return tool(name, description, schema, handler); };
  server.registerTool = (name: string, config: any, handler: any) => { handlers[name] = handler; return register(name, config, handler); };
  registerTools(server, undefined, kind === "daemon" ? network : null, kind === "anonymous" ? null : user,
    alias, kind === "daemon", kind === "daemon" ? token : null);
  return async (name: string, args: any = {}) => JSON.parse((await handlers[name](args)).content[0].text);
}
const snapshot = () => ({ network_id: net, daemon_node_id: node, revision: 0, source: "daemon", providers: [] });
const request = () => client()("daemon_provider_snapshot", { action: "refresh", network_id: net, id: node });

test('managed login: admin intent → capable target daemon → session manager → bounded public receipt', async () => {
  const work = mkdtempSync(join(root, 'login-'));
  const dir = join(work, '.anet/nodes', alias); mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ role: 'host_supervisor', network_id: net, node_id: node }), { mode: 0o600 });
  const prepared = new DaemonProviderStore(dir).prepareLoginDirectory();
  const session = 'b86c3ca5-5022-434d-bc9f-aa1c82ecf419';
  class Rpc extends EventEmitter {
    account: unknown = null;
    async request<R>(method: string): Promise<R> {
      return (method === 'account/read' ? { account: this.account } : { type: 'chatgptDeviceCode', loginId: session,
        verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'TEST-ONLY' }) as R;
    }
    async close() {}
  }
  const rpc = new Rpc(); let home = '';
  const logins = new DaemonCodexLogins(prepared.root, { network_id: net, daemon_node_id: node }, async () => {
    home = mkdtempSync(join(prepared.root, 'login-'));
    const login = new CodexManagedLogin(rpc);
    return { home, login, discard: async () => { await login.close(); rmSync(home, { recursive: true, force: true }); } };
  });
  const human = client(), daemon = client('daemon');
  const deps = { workDir: work, alias, networkId: net, daemonId: node, serverUrl: 'https://hub.example.test', warn: () => {},
    callCommHub: daemon, login: (intent: any) => executeProviderLogin(logins, intent) };
  const command = (intent: any) => human('daemon_provider_snapshot', { action: 'login', id: node, network_id: net, provider: intent });
  const read = (id: string) => human('daemon_provider_snapshot', { action: 'read', id, network_id: net });
  try {
    expect((await daemon('daemon_provider_snapshot', { action: 'login', id: node, provider: { action: 'start', session_id: session } })).ok).toBe(false);
    expect((await command({ action: 'start', session_id: session, token: 'TEST-ONLY' })).ok).toBe(false);
    const start = await command({ action: 'start', session_id: session });
    expect(start.ok).toBe(true);
    expect((await daemon('pull_daemon_provider_snapshots', { accept_writes: true, accept_applications: true })).requests).toEqual([]);
    expect((await client('daemon', 'other')('pull_daemon_provider_snapshots', { accept_logins: true })).ok).toBe(false);
    expect((await daemon('ack_daemon_provider_snapshot', { request_id: start.request_id, login: { request_id: session, status: 'authenticated', token: 'TEST-ONLY' } })).ok).toBe(false);
    await reconcileProviderSnapshots(deps);
    const challenge = await read(start.request_id);
    expect(challenge.status).toBe('succeeded');
    expect(challenge.login.status).toBe('awaiting_user');
    expect(challenge.snapshot).toBeNull();
    writeFileSync(join(home, 'auth.json'), '{"TEST_ONLY":"SECRET"}', { mode: 0o600 });
    rpc.account = { type: 'chatgpt', email: 'PRIVATE', token: 'SECRET' };
    rpc.emit('account/login/completed', { loginId: session, success: true });
    await Promise.resolve();
    const save = await command({ action: 'save', session_id: session, label: 'Work' });
    await reconcileProviderSnapshots(deps);
    expect((await read(save.request_id)).login.account_id).toBeString();
    const list = await command({ action: 'accounts' });
    // Listing uses the actual daemon handler and compiled pinned CLI bootstrap,
    // not the injected OAuth fixture. It does not start a login or run inference.
    await reconcileProviderSnapshots({ ...deps, login: undefined });
    const result = await read(list.request_id);
    expect(result.login.accounts).toHaveLength(1);
    expect(result.login.accounts[0].auth_state).toBe('not_checked');
    expect(JSON.stringify(result)).not.toMatch(/SECRET|PRIVATE|auth.json/);
    db.run('UPDATE daemon_provider_snapshots SET expires_at=?1 WHERE request_id=?2', [Date.now() - 1, start.request_id]);
    expect((await read(start.request_id)).login).toBeNull();
    expect(db.get<any>('SELECT snapshot_json FROM daemon_provider_snapshots WHERE request_id=?1', start.request_id).snapshot_json).toBeNull();
  } finally { await logins.close(); await closeProviderLogins(); }
});

test('application transport: scoped intent, capability gate, exact public receipt and changed binding refusal', async () => {
  const human = client(), daemon = client('daemon');
  const child = 'node_apply906';
  db.run("INSERT INTO nodes (node_id,node_name,alias,network_id,runtime) VALUES (?1,'child906','child906',?2,'codex-app-server')", [child, net]);
  db.run("INSERT INTO node_daemon_bindings (request_id,network_id,node_id,daemon_node_id,workdir,requested_by,status,created_at,updated_at) VALUES ('binding_apply906',?1,?2,?3,?4,?5,'active',1,1)", [net, child, node, root, user]);
  const selection = { node_id: child, node_revision: 'a'.repeat(64), provider_id: 'custom', auth_id: 'work', model: 'model-a', confirm_restart: true };
  const args = { action: 'apply', id: node, network_id: net, revision: 1, provider: selection };
  expect((await human('daemon_provider_snapshot', { ...args, provider: { ...selection, key: 'TEST-ONLY-key' } })).error).toBe('invalid_application');
  expect((await human('daemon_provider_snapshot', { ...args, provider: { ...selection, node_id: node } })).error).toBe('application_target_not_bound');
  expect((await daemon('daemon_provider_snapshot', args)).ok).toBe(false);
  const r = await human('daemon_provider_snapshot', args);
  expect(r.ok).toBe(true); expect(r.request_id).toMatch(/^dpa_/);
  expect((await daemon('pull_daemon_provider_snapshots', { accept_writes: true })).requests).toEqual([]);
  const dispatch = await daemon('pull_daemon_provider_snapshots', { accept_applications: true });
  expect(dispatch.requests[0]).toMatchObject({ request_id: r.request_id, operation: 'apply', alias: 'child906', expected_revision: 1, selection });
  const receipt = { status: 'applied', request_id: r.request_id, node_id: child, provider_id: 'custom', auth_id: 'work', model: 'model-a',
    runtime_provider: 'anet_' + createHash('sha256').update(JSON.stringify(['custom', 'work'])).digest('hex').slice(0, 20), node_revision: 'c'.repeat(64), provider_revision: 1, verification: 'runtime_confirmed', applied_at: Date.now() };
  // This is a protocol fixture, NOT evidence a runtime has switched.
  for (const bad of [{ ...receipt, model: 'wrong' }, { ...receipt, key: 'TEST-ONLY-key' }, { ...receipt, provider_revision: 2 }, { ...receipt, runtime_provider: 'anet_' + 'b'.repeat(20) }]) {
    expect((await daemon('ack_daemon_provider_snapshot', { request_id: r.request_id, application: bad })).error).toBe('invalid_application_receipt');
  }
  expect((await daemon('ack_daemon_provider_snapshot', { request_id: r.request_id, snapshot: snapshot() })).ok).toBe(false);
  expect((await daemon('ack_daemon_provider_snapshot', { request_id: r.request_id, application: receipt })).status).toBe('succeeded');
  await daemon('ack_daemon_provider_snapshot', { request_id: r.request_id, failed: true });
  const read = await human('daemon_provider_snapshot', { action: 'read', id: r.request_id, network_id: net });
  expect(read.status).toBe('succeeded'); expect(read.application).toEqual(receipt); expect(read.snapshot).toBeNull();
  expect(db.get('SELECT * FROM daemon_provider_applications WHERE request_id=?1', r.request_id)).toBeNull();
  const stale = await human('daemon_provider_snapshot', args);
  db.run("UPDATE node_daemon_bindings SET daemon_node_id='other' WHERE request_id='binding_apply906'");
  expect((await daemon('pull_daemon_provider_snapshots', { accept_applications: true })).requests).toEqual([]);
  expect((await human('daemon_provider_snapshot', { action: 'read', id: stale.request_id, network_id: net })).error).toBe('application_target_not_bound');
});

test('write core chain: encrypted Hub request → target daemon CLI → durable replay → public readback', async () => {
  process.env.ANET_HUB_SECRET_VAULT_KEY = '42'.repeat(32); // isolated fixture only
  const work = mkdtempSync(join(root, 'write-'));
  const dir = join(work, '.anet/nodes', alias); mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ role: 'host_supervisor', network_id: net, node_id: node }), { mode: 0o600 });
  const key = 'TEST-ONLY-private-write-key';
  const provider = { id: 'deepseek', label: 'DeepSeek', enabled: true, runtimes: [{ runtime: 'codex-tui', auth: [
    { id: 'work', kind: 'api_key', models: ['model-a'], baseUrl: 'https://api.example.test/v1', key },
  ] }] };
  const human = client(), daemon = client('daemon');
  const r = await human('daemon_provider_snapshot', { action: 'put', id: node, network_id: net, revision: 0, provider });
  expect(r.ok).toBe(true); expect(JSON.stringify(r)).not.toContain(key);
  const encrypted = db.get<any>('SELECT * FROM daemon_provider_writes WHERE request_id=?1', r.request_id);
  expect(Buffer.from(encrypted.ciphertext).toString()).not.toContain(key);
  expect((await daemon('pull_daemon_provider_snapshots')).requests).toEqual([]); // old/insecure readers receive no key
  expect((await client('daemon', 'other')('pull_daemon_provider_snapshots', { accept_writes: true })).ok).toBe(false);
  let drop = true;
  const deps = { workDir: work, alias, networkId: net, daemonId: node, serverUrl: 'https://hub.example.test', warn: () => {},
    callCommHub: async (name: string, args: any) => {
      if (name === 'ack_daemon_provider_snapshot' && drop) { drop = false; throw Error('lost acknowledgement'); }
      return daemon(name, args);
    } };
  await reconcileProviderSnapshots(deps);
  expect(new DaemonProviderStore(dir).list().revision).toBe(1);
  await reconcileProviderSnapshots(deps); // same request must not write revision 2 or lose success
  const read = await human('daemon_provider_snapshot', { action: 'read', id: r.request_id, network_id: net });
  expect(read.status).toBe('succeeded'); expect(read.snapshot.revision).toBe(1);
  expect(read.snapshot.providers[0].runtimes[0].auth[0].models).toEqual(['model-a']);
  expect(JSON.stringify(read)).not.toContain(key);
  expect(db.get('SELECT * FROM daemon_provider_writes WHERE request_id=?1', r.request_id)).toBeNull();
  const conflict = await human('daemon_provider_snapshot', { action: 'put', id: node, network_id: net, revision: 0, provider: { ...provider, label: 'must not overwrite' } });
  await reconcileProviderSnapshots(deps);
  expect((await human('daemon_provider_snapshot', { action: 'read', id: conflict.request_id, network_id: net })).status).toBe('failed');
  expect(new DaemonProviderStore(dir).list().providers[0].label).toBe('DeepSeek');
  db.run("UPDATE network_members SET role='member' WHERE user_id=?1 AND network_id=?2", [user, net]);
  expect((await human('daemon_provider_snapshot', { action: 'put', id: node, network_id: net, revision: 1, provider })).error).toBe('provider_admin_required');
});

test("human authorization precedes dispatch; unknown, nodes and non-admins cannot request", async () => {
  expect((await client("anonymous")("daemon_provider_snapshot", { action: "refresh", network_id: net, id: node })).error).toBe("user_token_required");
  expect((await client("daemon")("daemon_provider_snapshot", { action: "refresh", network_id: net, id: node })).ok).toBe(false);
  db.run("UPDATE network_members SET role='member' WHERE user_id=?1 AND network_id=?2", [user, net]);
  expect((await request()).error).toBe("provider_admin_required");
  expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM daemon_provider_snapshots WHERE network_id=?1", net)?.n).toBe(0);
});
test("normal nodes cannot impersonate a daemon; revoked token cannot pull or ack", async () => {
  const r = await request(); expect(r.ok).toBe(true);
  db.run("UPDATE nodes SET config_snapshot='{}' WHERE node_id=?1", [node]);
  expect((await client("daemon")("pull_daemon_provider_snapshots")).error).toBe("caller_not_a_daemon");
  db.run("UPDATE nodes SET config_snapshot=?1 WHERE node_id=?2", [JSON.stringify({ role: "host_supervisor" }), node]);
  db.run("UPDATE api_tokens SET revoked_at=datetime('now') WHERE token_id=?1", [token]);
  expect((await client("daemon")("pull_daemon_provider_snapshots")).ok).toBe(false);
  expect((await client("daemon")("ack_daemon_provider_snapshot", { request_id: r.request_id, snapshot: snapshot() })).ok).toBe(false);
});
test("request/pull/ack/read lifecycle; duplicate click and ack cannot rewrite receipt", async () => {
  const r = await request(); expect((await request()).request_id).toBe(r.request_id);
  const human = client(), daemon = client("daemon");
  expect((await human("daemon_provider_snapshot", { action: "read", id: r.request_id, network_id: net })).snapshot).toBeNull();
  expect((await daemon("pull_daemon_provider_snapshots")).requests[0].request_id).toBe(r.request_id);
  expect((await daemon("ack_daemon_provider_snapshot", { request_id: r.request_id, snapshot: snapshot() })).status).toBe("succeeded");
  await daemon("ack_daemon_provider_snapshot", { request_id: r.request_id, failed: true });
  const read = await human("daemon_provider_snapshot", { action: "read", id: r.request_id, network_id: net });
  expect(read.status).toBe("succeeded"); expect(read.snapshot).toEqual(snapshot()); expect(read.observed_at).toBeGreaterThan(0);
  expect((await daemon("pull_daemon_provider_snapshots")).requests).toEqual([]);
});
test("network and daemon mismatch cannot read or acknowledge another scope", async () => {
  const r = await request();
  expect((await client()("daemon_provider_snapshot", { action: "read", id: r.request_id, network_id: "foreign" })).ok).toBe(false);
  expect((await client("daemon", "foreign")("pull_daemon_provider_snapshots")).ok).toBe(false);
  const d = client("daemon");
  expect((await d("ack_daemon_provider_snapshot", { request_id: r.request_id, snapshot: { ...snapshot(), daemon_node_id: "other" } })).error).toBe("invalid_provider_snapshot");
  db.run("UPDATE daemon_provider_snapshots SET daemon_node_id='other' WHERE request_id=?1", [r.request_id]);
  expect((await d("ack_daemon_provider_snapshot", { request_id: r.request_id, snapshot: snapshot() })).error).toBe("request_not_found");
});
test("timeout is explicit; late daemon reply cannot overwrite it", async () => {
  const r = await request();
  db.run("UPDATE daemon_provider_snapshots SET expires_at=?1 WHERE request_id=?2", [Date.now() - 1, r.request_id]);
  expect((await client("daemon")("ack_daemon_provider_snapshot", { request_id: r.request_id, snapshot: snapshot() })).status).toBe("expired");
  expect((await client()("daemon_provider_snapshot", { action: "read", id: r.request_id, network_id: net })).snapshot).toBeNull();
});
test("secret fields / misleading verification are rejected, never saved in Hub DB", async () => {
  const r = await request(); const secret = "TEST-ONLY-key-never-in-hub";
  const auth = { id: "work", kind: "api_key", models: ["model-a"], baseUrl: "https://api.example.test/v1", credential_present: true, verification: "not_checked", application: "not_applied" };
  const nested = (change: object) => ({ ...snapshot(), providers: [{ id: "deepseek", label: "DeepSeek", enabled: true, runtimes: [{ runtime: "codex-tui", auth: [{ ...auth, ...change }] }] }] });
  for (const bad of [{ ...snapshot(), key: secret }, { ...snapshot(), source: "hub" }, { ...snapshot(), revision: -1 },
    nested({ key: secret }), nested({ verification: "verified" }), nested({ application: "applied" }), nested({ baseUrl: `https://user:${secret}@api.example.test/v1` })]) {
    const reply = await client("daemon")("ack_daemon_provider_snapshot", { request_id: r.request_id, snapshot: bad });
    expect(reply.error).toBe("invalid_provider_snapshot"); expect(JSON.stringify(reply)).not.toContain(secret);
  }
  expect(db.get<{ snapshot_json: string | null }>("SELECT snapshot_json FROM daemon_provider_snapshots WHERE request_id=?1", r.request_id)?.snapshot_json).toBeNull();
});
test("mirrored contract cannot drift", () => {
  expect(readFileSync(new URL("./shared/daemon-provider-snapshot.ts", import.meta.url), "utf8"))
    .toBe(readFileSync(new URL("../../agent-node/src/shared/daemon-provider-snapshot.ts", import.meta.url), "utf8"));
});
test("daemon reconnection executes actual pinned CLI against private store and acks redacted data", async () => {
  const dir = join(root, ".anet/nodes", alias); mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ role: "host_supervisor", network_id: net, node_id: node }), { mode: 0o600 });
  const key = "TEST-ONLY-private-906";
  new DaemonProviderStore(dir).upsert({ id: "deepseek", label: "DeepSeek", enabled: true, runtimes: [{ runtime: "codex-tui", auth: [{ id: "work", kind: "api_key", models: ["model-a"], baseUrl: "https://api.example.test/v1", key }] }] }, 0);
  const deps = { workDir: root, alias, networkId: net, daemonId: node, callCommHub: client("daemon"), warn: () => { throw Error("unexpected_warning"); } };
  // Atomic local read must pass before the Hub/daemon round trip.
  expect((await readLocalProviderSnapshot(deps) as any).revision).toBe(1);
  const r = await request();
  await Promise.all([reconcileProviderSnapshots(deps), reconcileProviderSnapshots(deps)]);
  const read = await client()("daemon_provider_snapshot", { action: "read", id: r.request_id, network_id: net });
  expect(read.status).toBe("succeeded"); expect(read.snapshot.providers[0].runtimes[0].auth[0].credential_present).toBe(true);
  expect(JSON.stringify(read)).not.toContain(key); expect(read.snapshot.providers[0].runtimes[0].auth[0].verification).toBe("not_checked");
});
test("daemon raw errors are replaced with fixed failure receipt", async () => {
  const r = await request();
  await reconcileProviderSnapshots({ workDir: root, alias, networkId: net, daemonId: node, callCommHub: client("daemon"), warn: () => {},
    readSnapshot: async () => { throw Error("TEST-ONLY-sensitive-error"); } });
  const read = await client()("daemon_provider_snapshot", { action: "read", id: r.request_id, network_id: net });
  expect(read.status).toBe("failed"); expect(read.error).toBe("provider_snapshot_unavailable"); expect(JSON.stringify(read)).not.toContain("TEST-ONLY-sensitive-error");
});
test("lost acknowledgement retries on reconnect, without swallowing a new doorbell", async () => {
  const r = await request(); const real = client("daemon"); let loseAck = true, reads = 0;
  const deps = { workDir: root, alias, networkId: net, daemonId: node, warn: () => {},
    readSnapshot: async () => { reads++; return snapshot(); },
    callCommHub: async (name: string, args: any) => {
      if (name === "ack_daemon_provider_snapshot" && loseAck) { loseAck = false; throw Error("TEST-ONLY-transport-down"); }
      return real(name, args);
    } };
  await reconcileProviderSnapshots(deps);
  expect((await client()("daemon_provider_snapshot", { action: "read", id: r.request_id, network_id: net })).status).toBe("pending");
  await reconcileProviderSnapshots(deps);
  expect((await client()("daemon_provider_snapshot", { action: "read", id: r.request_id, network_id: net })).status).toBe("succeeded");
  expect(reads).toBe(2);
});
test("real HTTP authentication -> daemon handler -> pinned CLI -> scoped public receipt", async () => {
  process.env.COMMHUB_UPLOADS_DIR = join(root, "uploads");
  const owner = register("provider906_http", "TestOnly-Provider906-Password!1");
  expect(owner.ok).toBe(true);
  const netId = owner.network_id!, nodeId = "node_dps_http", daemonAlias = "daemon-http";
  const issued = createNetworkTokenForNode(owner.user!.user_id, netId, daemonAlias, nodeId);
  expect(issued.ok).toBe(true);
  db.run("UPDATE nodes SET config_snapshot=?1 WHERE node_id=?2", [JSON.stringify({ role: "host_supervisor" }), nodeId]);
  const dir = join(root, ".anet/nodes", daemonAlias); mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ role: "host_supervisor", network_id: netId, node_id: nodeId }), { mode: 0o600 });
  for (const child of ['bound', 'neighbour']) {
    const childId = `n_scan_${child}`;
    db.run('INSERT INTO nodes (node_id,node_name,alias,network_id,runtime) VALUES (?1,?2,?2,?3,\'codex-app-server\')', [childId, child, netId]);
    db.run('INSERT INTO node_daemon_bindings (request_id,network_id,node_id,daemon_node_id,workdir,requested_by,status,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,\'active\',1,1)',
      [`binding_scan_${child}`, netId, childId, child === 'bound' ? nodeId : 'another-daemon', root, owner.user!.user_id]);
    const home = join(root, '.anet/nodes', child, 'codex-home'); mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(join(home, '../config.json'), JSON.stringify({ node_id: childId, alias: child, runtime: 'codex-app-server', network_id: netId }), { mode: 0o600 });
    writeFileSync(join(home, 'config.toml'), 'model_provider = "deepseek"\nmodel = "fixture-model"\n[model_providers.deepseek]\nenv_key = "TEST_API_KEY"\n', { mode: 0o600 });
  }
  const hub = (await import("./server")).bootServer({ port: 0, hostname: "127.0.0.1" });
  const url = `http://127.0.0.1:${hub.port}/mcp`;
  const rpc = (credential: string) => async (name: string, args: any) => {
    const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    expect(response.status).toBe(200);
    const raw = await response.text(); const line = raw.split("\n").filter(x => x.startsWith("data:")).at(-1);
    const message = JSON.parse(line ? line.slice(5) : raw);
    expect(message.error).toBeUndefined();
    return JSON.parse(message.result.content[0].text);
  };
  try {
    const human = rpc(owner.token!), daemon = rpc(issued.token!);
    const refresh = await human("daemon_provider_snapshot", { action: "refresh", id: nodeId, network_id: netId });
    expect(refresh.status).toBe("pending");
    expect((await human("pull_daemon_provider_snapshots", {})).ok).toBe(false);
    expect((await daemon("daemon_provider_snapshot", { action: "refresh", id: nodeId, network_id: netId })).ok).toBe(false);
    await reconcileProviderSnapshots({ workDir: root, alias: daemonAlias, networkId: netId, daemonId: nodeId, callCommHub: daemon,
      warn: () => { throw Error("unexpected_HTTP_readback_failure"); } });
    const read = await human("daemon_provider_snapshot", { action: "read", id: refresh.request_id, network_id: netId });
    expect(read.status).toBe("succeeded"); expect(read.snapshot).toMatchObject({ network_id: netId, daemon_node_id: nodeId, revision: 0, source: "daemon", providers: [], codex_inventory: { scope: 'hub_bound_nodes' } });
    expect(read.snapshot.codex_inventory.rows).toHaveLength(1);
    expect(read.snapshot.codex_inventory.rows[0]).toMatchObject({ node_id: 'n_scan_bound', configured_provider: 'deepseek', configured_model: 'fixture-model', credential_status: 'unknown' });
    const foreign = await human('daemon_provider_snapshot', { action: 'refresh', id: nodeId, network_id: netId });
    const bad = structuredClone(read.snapshot); bad.codex_inventory.rows[0].node_id = 'n_scan_neighbour';
    expect((await daemon('ack_daemon_provider_snapshot', { request_id: foreign.request_id, snapshot: bad })).ok).toBe(false);
  } finally { hub.stop(true); }
});
