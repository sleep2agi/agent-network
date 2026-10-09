// Docker-only real Hub / daemon / CLI / OpenCode V2. No vendor credentials.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { Database } from 'bun:sqlite';
const root = '/home/node/test883';
const project = `${root}/project`;
// The real client uses the daemon-advertised HOME plus the node folder.
const childProject = process.env.TEST829_CLIENT_DRIVER ? `${root}/home/oc829` : project;
const artifact = '/artifacts';
mkdirSync(project, { recursive: true });
mkdirSync(artifact, { recursive: true });
const hub = 'http://127.0.0.1:9287';
const env = { ...process.env, HOME: `${root}/home`, TERM: 'xterm-256color', ANET_BIN_ABS: '/workspace/agent-network/dist/bin/anet.cjs', ANET_DAEMON_ALLOW_ENV_BIN: '1' };
mkdirSync(env.HOME, { recursive: true, mode: 0o700 });
const redact = (s: string) => s.replace(/\b(?:atok|ntok|utok)_[A-Za-z0-9_-]+/g, '[test-token]');
const pause = (ms = 200) => new Promise(r => setTimeout(r, ms));
function check(name: string, ok: unknown) { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`); if (!ok) throw new Error(name); }
async function until(fn: () => Promise<boolean> | boolean, ms = 30000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await pause(); } return false; }
async function cli(args: string[]) {
  const c = Bun.spawn([env.ANET_BIN_ABS, ...args], { cwd: project, env, stdin: new Blob(['\n']), stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(c.stdout).text(), new Response(c.stderr).text(), c.exited]);
  console.log(redact(`CLI ${args.join(' ')} exit=${code}\n${out}${err}`));
  check(`CLI ${args.slice(0, 3).join(' ')}`, code === 0);
}
let token = '', networkId = '', daemonId = '';
async function api(path: string, body?: unknown) {
  const r = await fetch(hub + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${redact(await r.text())}`);
  return r.json() as Promise<any>;
}
async function mcp(name: string, args: object) {
  const r = await fetch(hub + '/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const text = await r.text();
  const data = text.split('\n').find(l => l.startsWith('data: '))?.slice(6) ?? text;
  const result = JSON.parse(data);
  if (result.error) return { error: result.error };
  return JSON.parse(result.result.content[0].text);
}
const logs: Record<string, string> = {};
function start(name: string, bin: string, args: string[], opts: object) {
  const p = spawn(bin, args, { ...opts, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); logs[name] = '';
  p.stdout!.on('data', b => logs[name] += b); p.stderr!.on('data', b => logs[name] += b); return p;
}
const server = start('hub', 'bun', ['src/index.ts'], { cwd: '/workspace/server', env: { ...env, PORT: '9287', COMMHUB_DB: `${root}/hub.db`, COMMHUB_AUTH_TOKEN: 'test829-bootstrap' } });
const stub = start('model', 'python3', ['/test827/stub-model.py', '18827', `${artifact}/stub.log`, 'ANSWER829_'], { env });
let daemon: ReturnType<typeof start> | undefined;
const tmuxSocket = process.env.TEST829_TMUX_SOCKET || '/run/test827-tmux.sock';
const tmux = (...args: string[]) => spawnSync('tmux', ['-S', tmuxSocket, ...args], { env, encoding: 'utf8' });
try {
  console.log('L0 environment');
  if (process.getuid?.() !== 0) {
    const safeBase = `/run/user/${process.getuid!()}`;
    const st = existsSync(safeBase) ? statSync(safeBase) : null;
    check('user-owned mode-0700 safe runtime base', st?.isDirectory() && st.uid === process.getuid!() && (st.mode & 0o777) === 0o700);
  }
  check('exact real OpenCode V2', spawnSync('opencode', ['--version'], { encoding: 'utf8' }).stdout.trim() === 'opencode v2.0.22');
  check('Hub health', await until(() => fetch(hub + '/health').then(r => r.ok, () => false)));
  check('model health', await until(() => fetch('http://127.0.0.1:18827/v1/models').then(r => r.ok, () => false)));
  console.log('L1 authentication and real daemon registration');
  check('unauthenticated dispatch refused', (await fetch(hub + '/api/task', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status === 401);
  await cli(['init', '--hub', hub]);
  await cli(['register', '--username', 't829', '--password', 'fixture-only-password']);
  await cli(['login', '--username', 't829', '--password', 'fixture-only-password']);
  const global = JSON.parse(readFileSync(`${env.HOME}/.anet/config.json`, 'utf8'));
  token = global.token; networkId = global.network_id;
  await cli(['daemon', 'init', 'daemon829']);
  daemon = start('daemon', env.ANET_BIN_ABS, ['daemon', 'start', 'daemon829'], { cwd: project, env });
  check('daemon registered as host supervisor', await until(async () => { const r = await api(`/api/host-supervisors?network_id=${networkId}`); daemonId = r.daemons?.find((d: any) => d.alias === 'daemon829')?.daemon_node_id; return Boolean(daemonId); }, 45000));
  const db = new Database(`${root}/hub.db`, { readonly: true });
  const count = () => (db.query('SELECT COUNT(*) AS n FROM node_create_requests').get() as any).n;
  console.log('L2 actual MCP validation before create side effects');
  const before = count();
  const denied = await mcp('create_node', { daemon_node_id: daemonId, network_id: networkId, node_spec: { name: 'refused829', runtime: 'opencode-cli', flags: { opencodeGeneration: 'v2' } } });
  check('V2 without explicit unsafe opt-in refused', !denied.request_id && JSON.stringify(denied).includes('opencodeUnsafeTools'));
  check('no create request or node config on refusal', count() === before && !existsSync(`${project}/.anet/nodes/refused829/config.json`));
  console.log('L3 real daemon remote create -> native V2 startup');
  // Only provider fixture is preseeded; node identity/config must come from daemon.
  const provider = `${childProject}/.anet/nodes/oc829/.config/opencode`;
  mkdirSync(provider, { recursive: true, mode: 0o700 });
  writeFileSync(`${provider}/opencode.json`, JSON.stringify({ model: 'stub/stub-model', provider: { stub: { npm: '@ai-sdk/openai-compatible', name: 'Stub', options: { baseURL: 'http://127.0.0.1:18827/v1', apiKey: 'test-only' }, models: { 'stub-model': { name: 'Stub' } } } } }), { mode: 0o600 });
  let created: any;
  if (process.env.TEST829_CLIENT_DRIVER) {
    console.log('L3 browser client -> real authenticated Hub -> real daemon');
    const child = Bun.spawn(['node', process.env.TEST829_CLIENT_DRIVER], {
      env, stdin: new Blob([JSON.stringify({ hub, token, networkId, daemonId })]), stdout: 'pipe', stderr: 'pipe',
    });
    const deadline = setTimeout(() => child.kill(), 100000);
    let out = '', err = '', code = -1;
    try { [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); }
    finally { clearTimeout(deadline); }
    console.log(redact(out + err));
    check('rendered client created and confirmed actual V2 node', code === 0);
    created = JSON.parse(out.split('\n').find(l => l.startsWith('CLIENT_RESULT '))!.slice(14));
  } else {
    created = await mcp('create_node', { daemon_node_id: daemonId, network_id: networkId, node_spec: { name: 'oc829', runtime: 'opencode-cli', model: 'stub/stub-model', flags: { opencodeGeneration: 'v2', opencodeUnsafeTools: true } } });
  }
  console.log('create result:', redact(JSON.stringify(created)));
  check('actual MCP create accepted with request id', created.ok && created.request_id);
  let row: any;
  check('daemon settles create request', await until(() => { row = db.query('SELECT status, error, child_node_id FROM node_create_requests WHERE request_id=?').get(created.request_id); return ['succeeded', 'failed', 'rejected', 'runtime_capability_check_failed', 'started'].includes(row?.status); }, 60000));
  console.log('create status:', JSON.stringify(row));
  if (!['started', 'succeeded'].includes(row.status)) {
    // Diagnostic replay of the exact plain start in the daemon's minimal env.
    // This does not change the failed request or permit later test layers.
    const replay = spawnSync(env.ANET_BIN_ABS, ['node', 'start', 'oc829'], { cwd: project, env: { HOME: env.HOME, PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' }, encoding: 'utf8', timeout: 15000 });
    console.log('failed-stage startup replay:', replay.status, redact(`${replay.stdout}${replay.stderr}`));
  }
  const cfg = JSON.parse(readFileSync(`${childProject}/.anet/nodes/oc829/config.json`, 'utf8'));
  check('daemon persisted V2 generation and explicit opt-in', cfg.opencodeGeneration === 'v2' && cfg.opencodeMode === 'copresence' && cfg.flags.opencodeUnsafeTools === true);
  check('create status reports started, not capability failure', ['started', 'succeeded'].includes(row.status));
  check('native TUI rendered', await until(() => /ctrl\+p/.test(tmux('capture-pane', '-p', '-t', '=oc829:', '-S', '-200').stdout)));
  if (process.env.TEST829_STOP_TUI_BEFORE_VERDICT === '1') {
    console.log('NEGATIVE CONTROL: stop exact owned TUI before daemon verdict');
    check('negative control precedes capability verdict',
      !/\[create-node\].*(?:\+5000ms|runtime_capability_check_failed)/.test(logs.daemon ?? ''));
    check('negative control TUI stop', tmux('kill-session', '-t', '=oc829').status === 0);
  }
  // Registration can finalize the Hub request before the daemon's 5-second
  // launcher check. Do not advance on that transient succeeded state: a late
  // failed ack may revoke the token while the TUI and request still look green.
  check('daemon post-start verdict observed', await until(() =>
    /\[create-node\].*(?:\+5000ms|runtime_capability_check_failed)/.test(logs.daemon ?? ''), 15000));
  const settled = db.query(`SELECT r.status, t.revoked_at FROM node_create_requests r
    LEFT JOIN api_tokens t ON t.token_id=r.child_token_id WHERE r.request_id=?`).get(created.request_id) as any;
  console.log('post-start identity:', JSON.stringify({ status: settled?.status, tokenRevoked: Boolean(settled?.revoked_at) }));
  check('daemon did not reject the runtime after registration',
    !(logs.daemon ?? '').includes('runtime_capability_check_failed'));
  check('child token remains active after daemon verdict', settled?.status === 'succeeded' && settled.revoked_at === null);
  let completion: any;
  check('client REST receives explicit daemon launch proof and exact child identity', await until(async () => {
    completion = await api(`/api/node-create-requests?request_id=${created.request_id}&network_id=${networkId}`);
    return completion.request?.status === 'succeeded'
      && completion.request?.child_node_id === row.child_node_id
      && typeof completion.request?.launch_verified_at === 'number'
      && completion.request.launch_verified_at > 0;
  }, 5000));
  console.log('client launch confirmation:', JSON.stringify(completion.request));
  console.log('L4 task receipt from remotely created runtime');
  const sent = await api('/api/task', { alias: 'oc829', task: 'Reply with exactly REMOTE829', network_id: networkId });
  check('task accepted', sent.ok && sent.message_id);
  let task: any;
  check('task terminal receipt', await until(async () => { const r = await api(`/api/tasks?task_id=${sent.message_id}&network_id=${networkId}`); task = r.tasks?.find((t: any) => (t.task_id ?? t.id) === sent.message_id); return ['replied', 'failed', 'cancelled'].includes(task?.status); }, 60000));
  check('exact answer from model, not prompt echo', task.status === 'replied' && task.result === '[oc829] ANSWER829_REMOTE829');
  check('answer visible in same TUI', await until(() => tmux('capture-pane', '-p', '-t', '=oc829:', '-S', '-200').stdout.includes('ANSWER829_REMOTE829')));

  console.log('L5 MODEL PROBE: actual config update -> restart -> task');
  const nodeDir = `${childProject}/.anet/nodes/oc829`;
  const beforeConfig = await api(`/api/nodes/${row.child_node_id}/config`);
  check('model update capability advertised', beforeConfig.config_update_capable === true);
  const oldHealth = JSON.parse(readFileSync(`${nodeDir}/opencode-launch-health.json`, 'utf8'));
  const providerFile = `${provider}/opencode.json`;
  const providerConfig = JSON.parse(readFileSync(providerFile, 'utf8'));
  providerConfig.provider.stub.models['stub-model-next'] = { name: 'Stub Next' };
  writeFileSync(providerFile, JSON.stringify(providerConfig), { mode: 0o600 });
  if (process.env.TEST829_MODEL_DRIVER) {
    const child = Bun.spawn(['node', process.env.TEST829_MODEL_DRIVER], {
      env, stdin: new Blob([JSON.stringify({ hub, token, networkId, nodeId: row.child_node_id, baseRevision: beforeConfig.config_revision })]),
      stdout: 'pipe', stderr: 'pipe',
    });
    const deadline = setTimeout(() => child.kill(), 115000);
    try {
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      console.log(redact(out + err));
      check('rendered client model change and revision confirmation', code === 0 && out.includes('MODEL_CLIENT_RESULT {"ok":true}'));
    } finally { clearTimeout(deadline); }
  } else {
  const changed = await mcp('update_node_config', {
    node_id: row.child_node_id, network_id: networkId,
    base_revision: beforeConfig.config_revision, patch: { model: 'stub/stub-model-next' },
  });
  console.log('model update result:', redact(JSON.stringify(changed)));
  check('model update accepted', changed.ok === true);
  }
  let modelView: any;
  check('new revision and requested model read back', await until(async () => {
    modelView = await api(`/api/nodes/${row.child_node_id}/config`);
    return modelView.config_revision > beforeConfig.config_revision && modelView.model === 'stub/stub-model-next';
  }, 90000));
  console.log('model readback:', JSON.stringify(modelView));
  check('new native process generation observed', await until(() => {
    try {
      const health = JSON.parse(readFileSync(`${nodeDir}/opencode-launch-health.json`, 'utf8'));
      return health.bridge.pid !== oldHealth.bridge.pid || health.bridge.ticks !== oldHealth.bridge.ticks;
    } catch { return false; }
  }, 15000));
  check('model restart TUI rendered', await until(() => /ctrl\+p/.test(tmux('capture-pane', '-p', '-t', '=oc829:', '-S', '-200').stdout)));
  const modelSent = await api('/api/task', { alias: 'oc829', task: 'Reply with exactly MODEL829', network_id: networkId });
  check('post-model task accepted', modelSent.ok && modelSent.message_id);
  check('post-model task replied exactly', await until(async () => {
    const r = await api(`/api/tasks?task_id=${modelSent.message_id}&network_id=${networkId}`);
    const t = r.tasks?.find((t: any) => (t.task_id ?? t.id) === modelSent.message_id);
    return t?.status === 'replied' && t.result === '[oc829] ANSWER829_MODEL829';
  }, 45000));
  check('post-model answer visible in TUI', await until(() => tmux('capture-pane', '-p', '-t', '=oc829:', '-S', '-200').stdout.includes('ANSWER829_MODEL829')));
  const providerRequests = readFileSync(`${artifact}/stub.log`, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  check('initial task reached original provider model', providerRequests.some(r => r.user.includes('Reply with exactly REMOTE829') && r.model === 'stub-model'));
  const afterModel = providerRequests.filter(r => r.user.includes('Reply with exactly MODEL829'));
  const expectedModel = process.env.TEST829_WRONG_PROVIDER_EXPECTATION === '1' ? 'deliberately-wrong-model' : 'stub-model-next';
  check('post-change task reached new provider model only', afterModel.length > 0 && afterModel.every(r => r.model === expectedModel));
  console.log(`PASS real V2 model probe; rendered UI=${Boolean(process.env.TEST829_MODEL_DRIVER)}; provider model verified`);

  if (process.env.TEST829_LIFECYCLE === '1') {
    console.log('L5 actual daemon stop/start lifecycle');
    const nodeDir = `${childProject}/.anet/nodes/oc829`;
    const health = JSON.parse(readFileSync(`${nodeDir}/opencode-launch-health.json`, 'utf8'));
    const attach = JSON.parse(readFileSync(`${nodeDir}/opencode-attach.json`, 'utf8'));
    const identities = [health.bridge, health.serve, { pid: attach.pid, ticks: String(attach.startTicks) }];
    const gone = (p: { pid: number; ticks: string }) => {
      try {
        const stat = readFileSync(`/proc/${p.pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
        // PID reuse is not the old generation. Zombies do not prove reaping.
        return fields[19] !== p.ticks;
      } catch { return true; }
    };
    const clientLifecycle = async (action: 'stop' | 'start') => {
      const child = Bun.spawn(['node', process.env.TEST829_MODEL_DRIVER!], {
        env, stdin: new Blob([JSON.stringify({ hub, token, networkId, nodeId: row.child_node_id, daemonId, action })]), stdout: 'pipe', stderr: 'pipe',
      });
      const deadline = setTimeout(() => child.kill(), 90000);
      try {
        const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        console.log(redact(out + err));
        check(`rendered client ${action} action`, code === 0);
        return JSON.parse(out.split('\n').find(l => l.startsWith('LIFECYCLE_CLIENT_RESULT '))!.slice(24));
      } finally { clearTimeout(deadline); }
    };
    const stop = process.env.TEST829_MODEL_DRIVER ? await clientLifecycle('stop')
      : await mcp('stop_node', { child_node_id: row.child_node_id, daemon_node_id: daemonId, network_id: networkId });
    console.log('stop result:', redact(JSON.stringify(stop)));
    check('actual stop dispatched', stop.ok && stop.request_id);
    let stopRow: any;
    check('stop request completed', await until(() => {
      stopRow = db.query('SELECT status,error FROM node_stop_requests WHERE request_id=?').get(stop.request_id);
      return stopRow?.status === 'stopped';
    }, 30000));
    console.log('stop status:', JSON.stringify(stopRow));
    check('old bridge serve TUI identities reaped', await until(() => identities.every(gone), 15000));
    check('old TUI and bridge sessions absent', tmux('has-session', '-t', '=oc829').status !== 0 && tmux('has-session', '-t', '=oc829-桥').status !== 0);
    check('config preserved after stop', existsSync(`${nodeDir}/config.json`));
    const denyRestart = process.env.TEST829_DENY_RESTART === '1';
    if (denyRestart) {
      const stoppedConfig = JSON.parse(readFileSync(`${nodeDir}/config.json`, 'utf8'));
      stoppedConfig.flags.opencodeUnsafeTools = false;
      writeFileSync(`${nodeDir}/config.json`, JSON.stringify(stoppedConfig), { mode: 0o600 });
      console.log('NEGATIVE CONTROL: remove explicit V2 unsafe opt-in from owned stopped test node');
    }
    const startResult = process.env.TEST829_MODEL_DRIVER ? await clientLifecycle('start')
      : await mcp('start_node', { child_node_id: row.child_node_id, daemon_node_id: daemonId, network_id: networkId });
    console.log('start result:', redact(JSON.stringify(startResult)));
    check('actual start dispatched', startResult.ok && startResult.request_id);
    if (denyRestart) {
      let failedStart: any;
      check('denied start reaches terminal verdict', await until(() => {
        failedStart = db.query('SELECT status,error FROM node_start_requests WHERE request_id=?').get(startResult.request_id);
        return ['started', 'start_failed'].includes(failedStart?.status);
      }, 45000));
      console.log('denied start status:', JSON.stringify(failedStart));
      check('denied V2 start reports start_failed, never started', failedStart.status === 'start_failed');
      check('denied start has no TUI or bridge session', tmux('has-session', '-t', '=oc829').status !== 0 && tmux('has-session', '-t', '=oc829-桥').status !== 0);
      console.log('PASS denied-start negative; no post-start task layer executed');
    } else {
    check('new launch evidence produced', await until(() => {
      try { const h = JSON.parse(readFileSync(`${nodeDir}/opencode-launch-health.json`, 'utf8')); return h.bridge.ticks !== health.bridge.ticks || h.bridge.pid !== health.bridge.pid; } catch { return false; }
    }, 45000));
    check('restarted native TUI rendered', await until(() => /ctrl\+p/.test(tmux('capture-pane', '-p', '-t', '=oc829:', '-S', '-200').stdout)));
    const again = await api('/api/task', { alias: 'oc829', task: 'Reply with exactly RESTART829', network_id: networkId });
    check('post-start task accepted', again.ok && again.message_id);
    let reply: any;
    check('post-start task replied exactly', await until(async () => {
      const r = await api(`/api/tasks?task_id=${again.message_id}&network_id=${networkId}`);
      reply = r.tasks?.find((t: any) => (t.task_id ?? t.id) === again.message_id);
      return reply?.status === 'replied' && reply.result === '[oc829] ANSWER829_RESTART829';
    }, 60000));
    check('post-start answer visible in TUI', await until(() => tmux('capture-pane', '-p', '-t', '=oc829:', '-S', '-200').stdout.includes('ANSWER829_RESTART829')));
    const startRow = db.query('SELECT status,error FROM node_start_requests WHERE request_id=?').get(startResult.request_id) as any;
    console.log('start status:', JSON.stringify(startRow));
    check('start request completed', startRow?.status === 'started');
    console.log('PASS actual daemon stop/start task chain; rendered lifecycle UI=' + Boolean(process.env.TEST829_MODEL_DRIVER));
    }
  }
  console.log('PASS test829 real daemon create/model/task; native desktop/mobile package validation remains separate');
} finally {
  writeFileSync(`${artifact}/tui.txt`, tmux('capture-pane', '-p', '-t', '=oc829:', '-S', '-200').stdout || '');
  const bridge = `${childProject}/.anet/nodes/oc829/logs/copresence-bridge.log`;
  if (existsSync(bridge)) writeFileSync(`${artifact}/bridge.log`, redact(readFileSync(bridge, 'utf8')));
  for (const name of ['oc829', 'oc829-桥']) tmux('kill-session', '-t', `=${name}`);
  // The daemon wrapper may leave a grandchild holding our stdout pipe open.
  // These groups were created by this Docker-only harness, never discovered
  // by pattern. Bound cleanup, then close our pipe handles explicitly.
  const owned = [daemon, server, stub].filter(Boolean) as ReturnType<typeof start>[];
  for (const p of owned) { try { process.kill(-p.pid!, 'SIGTERM'); } catch {} }
  const stopped = await until(() => owned.every(p => p.exitCode !== null || p.signalCode !== null), 5000);
  for (const p of owned) { p.stdout?.destroy(); p.stderr?.destroy(); }
  for (const [name, log] of Object.entries(logs)) writeFileSync(`${artifact}/${name}.log`, redact(log));
  check('owned harness processes exited', stopped);
}
