// TEST-ONLY: real Hub HTTP, Node daemon handler, CLI lifecycle and native Codex.
// Model responses/credentials are synthetic; no external account or inference.
import { strict as assert } from 'node:assert';
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { db } from '../../server/src/db';
import { register, createNetworkTokenForNode } from '../../server/src/auth';
import { bootServer } from '../../server/src/server';
import { providerNodeRevision } from '../../agent-network/src/daemon-provider-application';
import { DaemonProviderStore } from '../../agent-network/src/daemon-provider-store';
import { nativeAccountFixture } from './native-account-fixture';
import { startNativeRoutingFixture } from './native-routing-fixture';

const root = mkdtempSync(join(tmpdir(), 'native906-'));
const work = join(root, 'project'), userHome = join(root, 'home');
for (const dir of [work, userHome]) mkdirSync(dir, { mode: 0o700 });
process.env.COMMHUB_UPLOADS_DIR = join(root, 'uploads');
process.env.ANET_HUB_SECRET_VAULT_KEY = '42'.repeat(32);
const hub = bootServer({ port: 0, hostname: '127.0.0.1' });
const routing = startNativeRoutingFixture();
const url = `http://127.0.0.1:${hub.port}`;
const requests: { path: string; auth: string | null; model: string }[] = [];
const endpoint = Bun.serve({ hostname: '127.0.0.1', port: 0,
  tls: { key: readFileSync('/tmp/fixture-key.pem'), cert: readFileSync('/usr/local/share/ca-certificates/provider906.crt') },
  async fetch(req) {
    if (!req.url.endsWith('/responses')) return new Response('{}', { status: 404 });
    const body = await req.json() as any;
    requests.push({ path: new URL(req.url).pathname, auth: req.headers.get('authorization'), model: body.model });
    const id = `resp_${requests.length}`;
    const events = [
      { type: 'response.created', response: { id } },
      { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `msg_${id}`, content: [{ type: 'output_text', text: 'fixture reply' }] } },
      { type: 'response.completed', response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ];
    return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  },
});
const cli = '/work/agent-network/dist/bin/anet.cjs';
const env = { ...process.env, HOME: userHome, LANG: 'C.UTF-8', TERM: 'xterm-256color' };
delete env.TMUX; delete env.TMUX_PANE; delete env.CODEX_HOME;
const secrets: string[] = ['fixture-old-only', 'fixture-new-only'];
function scrub(value: string) { for (const secret of secrets) value = value.split(secret).join('[redacted]'); return value; }
const run = (binary: string, args: string[], input = '', timeout = 240_000, runEnv = env) => new Promise<string>((resolve, reject) => {
  const child = execFile(binary, args, { cwd: work, env: runEnv, timeout, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (error, out, err) => {
    if (error) reject(Error(`fixture command failed (${error.code}): ${scrub((out + err).slice(-6000))}`)); else resolve(out);
  });
  child.stdin?.on('error', () => {}); child.stdin?.end(input);
});
const rpc = (credential: string) => async (name: string, args: any) => {
  const response = await fetch(url + '/mcp', { method: 'POST', headers: { Authorization: `Bearer ${credential}`,
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  assert.equal(response.status, 200);
  const raw = await response.text(), line = raw.split('\n').filter(x => x.startsWith('data:')).at(-1);
  const message = JSON.parse(line ? line.slice(5) : raw); assert.equal(message.error, undefined);
  return JSON.parse(message.result.content[0].text);
};
class NativeRpc {
  child?: ReturnType<typeof spawn>; ws?: WebSocket; next = 1;
  pending = new Map<number, { ok(v: any): void; bad(e: Error): void }>(); completed: any[] = [];
  ready: Promise<void>;
  constructor(home: string, address?: string) {
    if (address) {
      this.ws = new WebSocket(address);
      this.ready = new Promise((ok, bad) => { this.ws!.onopen = () => ok(); this.ws!.onerror = () => bad(Error('WS unavailable')); });
      this.ws.onmessage = e => this.message(JSON.parse(String(e.data)));
    } else {
      this.child = spawn('codex', ['app-server'], { cwd: work, env: { ...env, CODEX_HOME: home, FIXTURE_OLD_KEY: 'fixture-old-only' }, stdio: ['pipe', 'pipe', 'pipe'] });
      let buffer = '';
      this.child.stdout!.on('data', bytes => { buffer += bytes; let at: number;
        while ((at = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (line.trim()) this.message(JSON.parse(line)); }
      });
      this.child.stderr!.on('data', () => {});
      this.ready = Promise.resolve();
    }
  }
  message(msg: any) {
    if (msg.method === 'turn/completed') this.completed.push(msg.params);
    const p = this.pending.get(msg.id); if (!p) return; this.pending.delete(msg.id);
    if (msg.error) p.bad(Error('native RPC error')); else p.ok(msg.result);
  }
  send(value: unknown) { const line = JSON.stringify(value); if (this.ws) this.ws.send(line); else this.child!.stdin!.write(line + '\n'); }
  async request(method: string, params: any) {
    await this.ready; const id = this.next++;
    return new Promise<any>((ok, bad) => {
      const timer = setTimeout(() => { this.pending.delete(id); bad(Error(method + ' timeout')); }, 20_000);
      this.pending.set(id, { ok: v => { clearTimeout(timer); ok(v); }, bad: e => { clearTimeout(timer); bad(e); } });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }
  async init() {
    await this.request('initialize', { clientInfo: { name: 'provider906-native', version: '1' }, capabilities: { experimentalApi: true } });
    this.send({ jsonrpc: '2.0', method: 'initialized', params: {} });
  }
  async turn(threadId: string) {
    const result = await this.request('turn/start', { threadId, input: [{ type: 'text', text: 'Reply with fixture text. No tools.' }] });
    const end = Date.now() + 25_000;
    while (Date.now() < end) {
      const done = this.completed.find(e => e.threadId === threadId && e.turn.id === result.turn.id);
      if (done) { assert.equal(done.turn.status, 'completed'); return; }
      await Bun.sleep(50);
    }
    throw Error('native turn timeout');
  }
  async stop() {
    this.ws?.close();
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      const exit = new Promise<void>(ok => this.child!.once('exit', () => ok()));
      this.child.kill('SIGTERM'); const force = setTimeout(() => this.child!.kill('SIGKILL'), 2000);
      await exit; clearTimeout(force);
    }
  }
}
const peers: NativeRpc[] = [];
let started = false, passed = false;
const alias = 'native906-child', daemonAlias = 'native906-daemon';
try {
  const owner = register('native906-owner', 'TestOnly-Provider906-Password!1'); assert.equal(owner.ok, true);
  const net = owner.network_id!, daemonId = 'n_native906daemon', childId = 'n_native906child';
  const daemon = createNetworkTokenForNode(owner.user!.user_id, net, daemonAlias, daemonId);
  const child = createNetworkTokenForNode(owner.user!.user_id, net, alias, childId);
  assert.equal(daemon.ok, true); assert.equal(child.ok, true);
  secrets.push(owner.token!, daemon.token!, child.token!);
  db.run('UPDATE nodes SET config_snapshot=?1 WHERE node_id=?2', [JSON.stringify({ role: 'host_supervisor' }), daemonId]);
  db.run("UPDATE nodes SET runtime='codex-app-server' WHERE node_id=?1", [childId]);
  db.run("INSERT INTO node_daemon_bindings (request_id,network_id,node_id,daemon_node_id,workdir,requested_by,status,created_at,updated_at) VALUES ('native906binding',?1,?2,?3,?4,?5,'active',1,1)", [net, childId, daemonId, work, owner.user!.user_id]);
  const daemonDir = join(work, '.anet/nodes', daemonAlias), nodeDir = join(work, '.anet/nodes', alias), home = join(nodeDir, 'codex-home');
  for (const dir of [daemonDir, home]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const write = (path: string, value: any) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  write(join(daemonDir, 'config.json'), { role: 'host_supervisor', node_id: daemonId, alias: daemonAlias, network_id: net, hub: url, token: daemon.token });
  writeFileSync(join(home, 'config.toml'), `model="fixture-old"\nmodel_provider="old"\n[projects.${JSON.stringify(work)}]\ntrust_level="trusted"\n[model_providers.old]\nname="old"\nbase_url="https://127.0.0.1:${endpoint.port}/old"\nenv_key="FIXTURE_OLD_KEY"\nwire_api="responses"\nrequest_max_retries=0\nstream_max_retries=0\n`, { mode: 0o600 });
  console.log('STAGE native existing session');
  const seed = new NativeRpc(home); peers.push(seed); await seed.init();
  const initial = await seed.request('thread/start', { model: 'fixture-old', approvalPolicy: 'never', sandbox: 'read-only' });
  const threadId = initial.thread.id; await seed.turn(threadId); await seed.stop();
  write(join(nodeDir, 'config.json'), { name: alias, alias, node_id: childId, network_id: net, runtime: 'codex-app-server',
    hub: url, token: child.token, codexCopresence: true, codexProjectDir: work, codexThreadId: threadId,
    model: 'fixture-old', codexModelProvider: 'old', codexBin: '/usr/local/bin/codex', codexVersion: '0.159.2', env: { FIXTURE_OLD_KEY: 'fixture-old-only' } });
  started = true;
  console.log('STAGE real CLI start original node');
  await run('node', [cli, 'node', 'start', childId, '--copresence', '--tui-first', '--no-inherit-codex-home']);
  console.log('STAGE prerequisite lifecycle with daemon minimal environment');
  const minimal = { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: userHome, LANG: 'C.UTF-8' } as typeof env;
  await run('node', [cli, 'node', 'stop', childId], '', 60_000, minimal);
  await run('node', [cli, 'node', 'start', childId, '--copresence', '--tui-first', '--no-inherit-codex-home'], '', 240_000, minimal);
  const human = rpc(owner.token!);
  const deps = { workDir: work, alias: daemonAlias, networkId: net, daemonId, serverUrl: url, token: daemon.token };
  const reconcile = () => run('node', ['/work/native-reconcile.mjs'], JSON.stringify(deps), 570_000);
  console.log('STAGE HTTP save provider through Node daemon handler');
  const saved = await human('daemon_provider_snapshot', { action: 'put', network_id: net, id: daemonId, revision: 0,
    provider: { id: 'custom', label: 'Fixture new', enabled: true, runtimes: [{ runtime: 'codex-tui', auth: [
      { id: 'work', kind: 'api_key', models: ['fixture-new'], baseUrl: `https://127.0.0.1:${endpoint.port}/selected`, key: 'fixture-new-only' },
    ] }] } });
  assert.equal(saved.ok, true); await reconcile();
  assert.equal((await human('daemon_provider_snapshot', { action: 'read', network_id: net, id: saved.request_id })).status, 'succeeded');
  const untilIdle = Date.now() + 30_000;
  while (Date.now() < untilIdle) {
    const status = await rpc(daemon.token!)('get_session_status', { alias });
    if (status.session?.status === 'idle' && status.inbox_pending === 0) break;
    await Bun.sleep(500);
  }
  console.log('STAGE HTTP apply exact selection through real CLI lifecycle');
  const application = await human('daemon_provider_snapshot', { action: 'apply', network_id: net, id: daemonId, revision: 1,
    provider: { node_id: childId, node_revision: providerNodeRevision(nodeDir), provider_id: 'custom', auth_id: 'work', model: 'fixture-new', confirm_restart: true } });
  assert.equal(application.ok, true); await reconcile();
  const result = await human('daemon_provider_snapshot', { action: 'read', network_id: net, id: application.request_id });
  assert.equal(result.status, 'succeeded', `application status=${result.status} error=${result.error}`);
  assert.equal(result.application.model, 'fixture-new'); assert.equal(existsSync(join(home, 'auth.json')), false);
  const current = JSON.parse(readFileSync(join(nodeDir, 'config.json'), 'utf8'));
  assert.equal(current.codexThreadId, threadId); assert.equal(current.codexRecoveryVerification.modelProvider, result.application.runtime_provider);
  const live = new NativeRpc(home, current.codexAppServerUrl); peers.push(live); await live.init();
  // A new WebSocket client must subscribe to the thread's notifications. No
  // provider/model override here: use the node's already-applied selection.
  const resumed = await live.request('thread/resume', { threadId });
  assert.equal(resumed.model, 'fixture-new');
  assert.equal(resumed.modelProvider, result.application.runtime_provider);
  await live.turn(threadId); // no model override: actual resumed runtime must route it
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], { path: '/old/responses', auth: 'Bearer fixture-old-only', model: 'fixture-old' });
  assert.deepEqual(requests[1], { path: '/selected/responses', auth: 'Bearer fixture-new-only', model: 'fixture-new' });
  assert.equal(existsSync(join(nodeDir, 'provider-application.json')), false);
  await live.stop();

  // Same real node/session: API key -> managed login A -> managed login B -> key.
  // The signed-in shape is an unsigned fixture; no official model turn is sent.
  const store = new DaemonProviderStore(daemonDir);
  const accountIds = ['aaaaaaaa-1111-4111-8111-111111111111', 'bbbbbbbb-1111-4111-8111-111111111111'];
  const accountHomes = accountIds.map((id, i) => {
    const savedHome = join(store.prepareLoginDirectory().root, `login-native${i}`);
    mkdirSync(savedHome, { mode: 0o700 });
    const auth = nativeAccountFixture(id, `fixture-${i}@example.invalid`);
    secrets.push(auth.tokens.access_token, auth.tokens.refresh_token);
    write(join(savedHome, 'auth.json'), auth);
    write(join(savedHome, 'anet-account.json'), { version: 1, network_id: net, daemon_node_id: daemonId,
      account_id: id, label: `Fixture ${i}`, created_at: Date.now() });
    return savedHome;
  });
  const official = await human('daemon_provider_snapshot', { action: 'put', network_id: net, id: daemonId, revision: 1,
    provider: { id: 'openai', label: 'OpenAI', enabled: true, runtimes: [{ runtime: 'codex-tui', auth: accountIds.map(id => ({
      id, kind: 'chatgpt', account_id: id, models: ['gpt-6.1-sol'],
    })) }] } });
  assert.equal(official.ok, true); await reconcile();
  assert.equal((await human('daemon_provider_snapshot', { action: 'read', network_id: net, id: official.request_id })).status, 'succeeded');
  const waitIdle = async () => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const status = await rpc(daemon.token!)('get_session_status', { alias });
      if (status.session?.status === 'idle' && status.inbox_pending === 0) return;
      await Bun.sleep(500);
    }
    throw Error('native node did not become idle');
  };
  for (let i = 0; i < accountIds.length; i++) {
    console.log(`STAGE real CLI managed account ${i + 1}`);
    await waitIdle();
    const selected = await human('daemon_provider_snapshot', { action: 'apply', network_id: net, id: daemonId, revision: 2,
      provider: { node_id: childId, node_revision: providerNodeRevision(nodeDir), provider_id: 'openai', auth_id: accountIds[i],
        account_id: accountIds[i], model: 'gpt-6.1-sol', confirm_restart: true } });
    assert.equal(selected.ok, true); await reconcile();
    const receipt = await human('daemon_provider_snapshot', { action: 'read', network_id: net, id: selected.request_id });
    assert.equal(receipt.status, 'succeeded', `official application status=${receipt.status} error=${receipt.error}`);
    assert.equal(receipt.application.account_id, accountIds[i]); assert.equal(receipt.application.runtime_provider, 'openai');
    const configured = JSON.parse(readFileSync(join(nodeDir, 'config.json'), 'utf8'));
    assert.equal(configured.codexThreadId, threadId);
    const accountPeer = new NativeRpc(home, configured.codexAppServerUrl); peers.push(accountPeer); await accountPeer.init();
    const account = await accountPeer.request('account/read', { refreshToken: false });
    assert.equal(account.account.type, 'chatgpt'); assert.equal(account.account.email, `fixture-${i}@example.invalid`);
    const resumedOfficial = await accountPeer.request('thread/resume', { threadId });
    assert.equal(resumedOfficial.modelProvider, 'openai'); assert.equal(resumedOfficial.model, 'gpt-6.1-sol');
    await accountPeer.stop();
    assert.equal(JSON.parse(readFileSync(join(accountHomes[i], 'anet-account.json'), 'utf8')).active, true);
    if (i) assert.equal(JSON.parse(readFileSync(join(accountHomes[i - 1], 'anet-account.json'), 'utf8')).active, false);
  }
  console.log('STAGE real CLI managed account back to API key');
  await waitIdle();
  const back = await human('daemon_provider_snapshot', { action: 'apply', network_id: net, id: daemonId, revision: 2,
    provider: { node_id: childId, node_revision: providerNodeRevision(nodeDir), provider_id: 'custom', auth_id: 'work', model: 'fixture-new', confirm_restart: true } });
  assert.equal(back.ok, true); await reconcile();
  assert.equal((await human('daemon_provider_snapshot', { action: 'read', network_id: net, id: back.request_id })).status, 'succeeded');
  assert.equal(JSON.parse(readFileSync(join(accountHomes[1], 'anet-account.json'), 'utf8')).active, false);
  assert.equal(requests.length, 2, 'no official model request was made');
  passed = true;
  console.log('PASS real Hub → daemon → CLI → native Codex same-thread API key / managed account A / B / API key; local account identity/model readback; two synthetic API-key turns, unsigned account fixtures, no real OAuth or external inference');
} catch (error) {
  console.error(scrub(String(error)));
  console.error('MODEL_REQUESTS', JSON.stringify(requests.map(r => ({ path: r.path, model: r.model,
    selectedKey: r.auth === 'Bearer fixture-new-only' }))));
  const nodeDir = join(work, '.anet/nodes', alias);
  try {
    for (const file of readdirSync(join(nodeDir, 'receipts')).filter(f => f.endsWith('.json'))) {
      const receipt = JSON.parse(readFileSync(join(nodeDir, 'receipts', file), 'utf8'));
      console.error('LIFECYCLE_RECEIPT', scrub(JSON.stringify({ verb: receipt.verb, verdict: receipt.verdict,
        blocking: receipt.blocking, checks: receipt.checks?.filter((c: any) => c.status !== 'pass') })));
    }
  } catch { /* no lifecycle receipt yet */ }
  try {
    const cfg = JSON.parse(readFileSync(join(nodeDir, 'config.json'), 'utf8'));
    console.error('DIAGNOSTIC', JSON.stringify({ model: cfg.model, provider: cfg.codexModelProvider,
      verification: cfg.codexRecoveryVerification, journal: existsSync(join(nodeDir, 'provider-application.json')) }));
    if (existsSync(join(nodeDir, 'provider-application.json'))) {
      const journal = JSON.parse(readFileSync(join(nodeDir, 'provider-application.json'), 'utf8'));
      const prior = JSON.parse(journal.before['config.json']);
      console.error('CHANGED_CONFIG_KEYS', Object.keys({ ...prior, ...cfg }).filter(k => JSON.stringify(prior[k]) !== JSON.stringify(cfg[k])).join(','));
    }
  } catch { /* early setup failure */ }
  for (const file of ['codex-bridge.log', 'codex-app-server.log']) {
    try { console.error(file, scrub(readFileSync(join(nodeDir, file), 'utf8').slice(-2000))); } catch { /* absent */ }
  }
}
finally {
  for (const peer of peers) await peer.stop();
  if (started) { try { await run('node', [cli, 'node', 'stop', alias], '', 60_000); } catch (error) { passed = false; console.error(scrub(String(error))); } }
  routing.stop(); endpoint.stop(true); hub.stop(true); rmSync(root, { recursive: true, force: true });
  process.exit(passed ? 0 : 1);
}
