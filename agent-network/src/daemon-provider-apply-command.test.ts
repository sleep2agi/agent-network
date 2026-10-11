import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonProviderStore } from './daemon-provider-store';
import { providerNodeRevision } from './daemon-provider-application';
import { runDaemonProviderApply } from './daemon-provider-apply-command';
import { REQUIRED_CHECKS } from './codex-lifecycle-receipt';

// Actual CLI application dispatcher/filesystem, injected lifecycle subprocesses.
// This is NOT a native Codex process acceptance test.
test('apply command core: exact launch readback, lost ACK replay, busy refusal and failed-model rollback', async () => {
  for (const mode of ['ok', 'busy', 'wrong-model', 'official', 'wrong-account'] as const) {
    const root = mkdtempSync(join(tmpdir(), 'provider-command906-'));
    let hub: ReturnType<typeof Bun.serve> | undefined;
    let runtime: ReturnType<typeof Bun.serve> | undefined;
    try {
      const nodes = join(root, '.anet/nodes'), daemon = join(nodes, 'supervisor'), node = join(nodes, 'child');
      mkdirSync(daemon, { recursive: true, mode: 0o700 }); mkdirSync(join(node, 'codex-home'), { recursive: true, mode: 0o700 });
      const write = (path: string, value: any) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
      write(join(daemon, 'config.json'), { node_id: 'daemon_a', network_id: 'net_a', role: 'host_supervisor' });
      const before = { node_id: 'node_a', alias: 'child', network_id: 'net_a', runtime: 'codex-app-server', codexCopresence: true, codexThreadId: 'fixture-thread', model: 'old' };
      write(join(node, 'config.json'), before);
      writeFileSync(join(node, 'codex-home/config.toml'), 'model="old"\n', { mode: 0o600 });
      new DaemonProviderStore(daemon).upsert({ id: 'custom', label: 'Fixture', enabled: true, runtimes: [{ runtime: 'codex-tui', auth: [
        { id: 'work', kind: 'api_key', models: ['new'], baseUrl: 'https://example.test/v1', key: 'TEST-ONLY-secret' },
      ] }] }, 0);
      const request = { request_id: 'dpa_11111111-1111-4111-8111-111111111111', expected_revision: 1, alias: 'child', network_id: 'net_a', daemon_node_id: 'daemon_a',
        selection: { node_id: 'node_a', node_revision: providerNodeRevision(node), provider_id: 'custom', auth_id: 'work', model: 'new', confirm_restart: true } as Record<string, any> };
      let accountReads = 0;
      if (mode === 'official' || mode === 'wrong-account') {
        const store = new DaemonProviderStore(daemon), accountId = 'aaaaaaaa-1111-4111-8111-111111111111';
        const home = join(store.prepareLoginDirectory().root, 'login-fixture'); mkdirSync(home, { mode: 0o700 });
        write(join(home, 'anet-account.json'), { version: 1, account_id: accountId, network_id: 'net_a', daemon_node_id: 'daemon_a' });
        write(join(home, 'auth.json'), { auth_mode: 'chatgpt', tokens: { account_id: accountId, access_token: 'TEST-ONLY-access', refresh_token: 'TEST-ONLY-refresh' } });
        store.upsert({ id: 'openai', label: 'OpenAI', enabled: true, runtimes: [{ runtime: 'codex-tui', auth: [
          { id: 'login', kind: 'chatgpt', account_id: accountId, models: ['new'] },
        ] }] }, 1);
        request.expected_revision = 2;
        request.selection = { ...request.selection, provider_id: 'openai', auth_id: 'login', account_id: accountId };
        runtime = Bun.serve({ hostname: '127.0.0.1', port: 0,
          fetch(req, server) { return server.upgrade(req) ? undefined : new Response('bad'); },
          websocket: { message(ws, raw) {
            const m = JSON.parse(String(raw));
            if (m.method === 'initialize') ws.send(JSON.stringify({ id: m.id, result: {} }));
            if (m.method === 'account/read') { accountReads++;
              ws.send(JSON.stringify({ id: m.id, result: { requiresOpenaiAuth: true, account: { type: mode === 'official' ? 'chatgpt' : 'apiKey' } } })); }
          } },
        });
      }
      const calls: string[][] = [], output: string[] = [];
      hub = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async incoming => {
        expect(incoming.headers.get('Authorization')).toBe('Bearer TEST-ONLY-hub-token');
        const rpc = await incoming.json() as any;
        const value = rpc.params.name === 'pull_daemon_provider_snapshots'
          ? { ok: true, requests: [{ ...request, operation: 'apply', expires_at: Date.now() + 600_000 }] }
          : { ok: true, session: { node_id: 'node_a', network_id: 'net_a', status: mode === 'busy' ? 'working' : 'idle', updated_at: new Date().toISOString() }, inbox_pending: 0 };
        return Response.json({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(value) }] } });
      } });
      write(join(daemon, 'config.json'), { node_id: 'daemon_a', network_id: 'net_a', role: 'host_supervisor', hub: `http://127.0.0.1:${hub.port}`, token: 'TEST-ONLY-hub-token' });
      let launched = 0;
      const deps = { nodesDir: nodes, readInput: () => JSON.stringify(request), print: (v: string) => { output.push(v); },
        run: async (argv: string[], cwd: string) => {
          expect(cwd).toBe(root); calls.push(argv);
          if (argv[1] === 'start') {
            expect(argv).toContain('--no-inherit-codex-home');
            launched++;
            const config = JSON.parse(readFileSync(join(node, 'config.json'), 'utf8'));
            write(join(node, 'config.json'), { ...config, ...(runtime ? { codexAppServerPort: runtime.port } : {}), codexRecoveryVerification: { method: 'thread/resume', threadId: 'fixture-thread', verifiedAt: new Date().toISOString(),
              model: mode === 'wrong-model' && launched === 1 ? 'wrong' : config.model,
              modelProvider: argv.includes('--codex-model-provider') ? argv[argv.indexOf('--codex-model-provider') + 1] : config.codexModelProvider } });
          }
          if (argv[2] === 'verify') return JSON.stringify({ format: 'anet-codex-lifecycle-receipt/1', verb: 'verify', alias: 'child', nodeId: 'node_a',
            verdict: 'PASS', startedAt: new Date().toISOString(), checks: REQUIRED_CHECKS.verify.map(key => ({ key, status: 'pass' })) });
          return '';
        } };
      const result = await runDaemonProviderApply(['apply', 'supervisor'], deps);
      expect(output.join('')).not.toContain('TEST-ONLY');
      if (mode === 'ok' || mode === 'official') {
        expect(result).toBe(0); expect(JSON.parse(output[0]).application).toMatchObject({ status: 'applied', model: 'new', node_id: 'node_a' });
        expect(calls.map(a => a.slice(0, 3).join(' '))).toEqual(['node stop node_a', 'node start node_a', 'node codex verify']);
        expect(await runDaemonProviderApply(['apply', 'supervisor'], deps)).toBe(0); expect(calls).toHaveLength(3);
        if (mode === 'official') { expect(accountReads).toBe(1); expect(JSON.parse(output[0]).application.account_id).toBe(request.selection.account_id); }
      } else {
        expect(result).toBe(1);
        const config = JSON.parse(readFileSync(join(node, 'config.json'), 'utf8'));
        expect(config.model).toBe('old'); expect(existsSync(join(node, 'provider-application.json'))).toBe(false);
        if (mode === 'busy') expect(calls).toHaveLength(0);
        else { expect(launched).toBe(2); expect(JSON.parse(output[0]).error).toBe('application_failed_rolled_back'); }
      }
    } finally { runtime?.stop(true); hub?.stop(true); rmSync(root, { recursive: true, force: true }); }
  }
});
