// TEST-ONLY: installed Codex + local synthetic Responses endpoints. No accounts,
// external inference, Hub, daemon lifecycle or installed-client claim.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import { resumeAndVerifyCodexThread } from '../../agent-network/src/codex-copresence-recovery';

const root = mkdtempSync(join(tmpdir(), 'provider-native906-'));
const requests: { path: string; auth: string | null; model: string }[] = [];
const children: Rpc[] = [];
const endpoint = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
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
} });
writeFileSync(join(root, 'config.toml'), `model="fixture-old"
model_provider="old"
[model_providers.old]
name="old"
base_url="http://127.0.0.1:${endpoint.port}/old"
env_key="FIXTURE_OLD_KEY"
wire_api="responses"
request_max_retries=0
stream_max_retries=0
[model_providers.selected]
name="selected"
base_url="http://127.0.0.1:${endpoint.port}/selected"
env_key="FIXTURE_NEW_KEY"
wire_api="responses"
request_max_retries=0
stream_max_retries=0
`, { mode: 0o600 });

class Rpc {
  child: ChildProcessWithoutNullStreams;
  next = 1;
  pending = new Map<number, { resolve(v: any): void; reject(e: any): void }>();
  completed: any[] = [];
  constructor() {
    this.child = spawn('codex', ['app-server'], { cwd: root, env: { ...process.env, CODEX_HOME: root,
      FIXTURE_OLD_KEY: 'fixture-old-only', FIXTURE_NEW_KEY: 'fixture-new-only' }, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(this);
    let buffer = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.method === 'turn/completed') this.completed.push(msg.params);
        const pending = this.pending.get(msg.id);
        if (!pending) continue;
        this.pending.delete(msg.id);
        if (msg.error) pending.reject(Object.assign(new Error('RPC failed'), { code: msg.error.code }));
        else pending.resolve(msg.result);
      }
    });
    this.child.stderr.on('data', () => {}); // never surface credential-bearing logs
    this.child.on('exit', () => { for (const p of this.pending.values()) p.reject(new Error('Codex exited')); this.pending.clear(); });
  }
  request(method: string, params: Record<string, unknown>) {
    const id = this.next++;
    return new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timeout`)); }, 15000);
      this.pending.set(id, { resolve: v => { clearTimeout(timeout); resolve(v); }, reject: e => { clearTimeout(timeout); reject(e); } });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async init() {
    await this.request('initialize', { clientInfo: { name: 'anet-provider-test', version: '1' }, capabilities: { experimentalApi: true } });
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }) + '\n');
  }
  async turn(threadId: string) {
    const result = await this.request('turn/start', { threadId, input: [{ type: 'text', text: 'Reply with fixture text; no tools.' }] });
    const until = Date.now() + 15000;
    while (Date.now() < until) {
      const done = this.completed.find(e => e.threadId === threadId && e.turn.id === result.turn.id);
      if (done) { assert.equal(done.turn.status, 'completed'); return; }
      await Bun.sleep(25);
    }
    throw new Error('turn did not complete');
  }
  async stop() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = new Promise<void>(resolve => this.child.once('exit', () => resolve()));
    this.child.kill('SIGTERM');
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 2000);
    await exited; clearTimeout(timer);
  }
}
try {
  const old = new Rpc(); await old.init();
  const created = await old.request('thread/start', { model: 'fixture-old', approvalPolicy: 'never', sandbox: 'read-only' });
  const threadId = created.thread.id;
  await old.turn(threadId); await old.stop();
  const current = new Rpc(); await current.init();
  const verified = await resumeAndVerifyCodexThread(threadId, (m, p) => current.request(m, p), 'fixture-new', 'selected');
  assert.equal(verified.modelProvider, 'selected'); assert.equal(verified.model, 'fixture-new');
  await current.turn(threadId);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], { path: '/old/responses', auth: 'Bearer fixture-old-only', model: 'fixture-old' });
  assert.deepEqual(requests[1], { path: '/selected/responses', auth: 'Bearer fixture-new-only', model: 'fixture-new' });
  // Negative receipt control uses the same real response with one wrong field;
  // no extra inference, no weakened runtime mismatch assertion.
  await assert.rejects(resumeAndVerifyCodexThread(threadId, async (m, p) => {
    const result = await current.request(m, p);
    return m === 'thread/resume' ? { ...result, modelProvider: 'wrong' } : result;
  }, 'fixture-new', 'selected'), /does not match/);
  console.log('PASS installed Codex 0.159.2: existing thread resumes selected provider/model; next synthetic request uses selected endpoint/key/model; wrong-provider receipt rejected. Two synthetic turns, no external inference.');
} finally {
  for (const child of children) await child.stop();
  endpoint.stop(true); rmSync(root, { recursive: true, force: true });
}
