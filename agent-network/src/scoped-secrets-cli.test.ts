// #1509 — friendly `anet daemon secret list/set/unset` over the same scoped lane.
// Values never come from argv; every write must name a scope.
import { test, expect } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicWritePrivateJson } from './private-state';
import { runDaemonSecretCli } from './scoped-secrets';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'scoped-secret-cli-'));
  const nodes = join(root, '.anet', 'nodes');
  mkdirSync(nodes, { recursive: true });
  // 真实 ~/.anet 是 0700；scoped lane 的目录保护要求祖先树不可被他人遍历。
  chmodSync(join(root, '.anet'), 0o700); chmodSync(nodes, 0o700);
  const daemon = join(nodes, 'daemon-dev');
  mkdirSync(daemon, { mode: 0o700 });
  atomicWritePrivateJson(join(daemon, 'config.json'), {
    role: 'host_supervisor', network_id: 'net-fixture', node_id: 'daemon-fixture', alias: 'daemon-dev',
  });
  for (const [dir, id, alias] of [['child-a', 'node-a', '指挥室'], ['child-b', 'node-b', '通信欧']]) {
    mkdirSync(join(nodes, dir), { mode: 0o700 });
    atomicWritePrivateJson(join(nodes, dir, 'config.json'), {
      alias, runtime: 'codex-app-server', network_id: 'net-fixture', node_id: id,
    });
  }
  return { root, nodes, store: join(daemon, 'scoped-secrets.json') };
}

function run(nodes: string, argv: string[], opts: { env?: NodeJS.ProcessEnv; stdin?: string } = {}) {
  const out: string[] = [];
  const code = runDaemonSecretCli(argv, {
    nodesDir: nodes,
    readInput: () => { if (opts.stdin === undefined) throw Error('private stdin required'); return opts.stdin; },
    print: (s) => out.push(s),
    env: opts.env ?? {},
  });
  return { code, out: out.join('\n') };
}

test('set --all writes the default and never echoes the value', () => {
  const f = fixture();
  try {
    const r = run(f.nodes, ['set', 'daemon-dev', 'DEEPSEEK_API_KEY', '--from-env', 'SRC', '--all'],
      { env: { SRC: 'synthetic-value' } });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('synthetic-value');
    expect(r.out).toContain('DEEPSEEK_API_KEY');
    expect(statSync(f.store).mode & 0o777).toBe(0o600);

    const listed = run(f.nodes, ['list', 'daemon-dev', '--json']);
    expect(JSON.parse(listed.out).keys).toEqual([{ key: 'DEEPSEEK_API_KEY', source: 'daemon' }]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('set --node writes that child only; unset --node clears it back to the default', () => {
  const f = fixture();
  try {
    expect(run(f.nodes, ['set', 'daemon-dev', 'DEEPSEEK_API_KEY', '--from-env', 'SRC', '--all'],
      { env: { SRC: 'daemon-wide' } }).code).toBe(0);
    const node = run(f.nodes, ['set', 'daemon-dev', 'DEEPSEEK_API_KEY', '--from-env', 'SRC', '--node', '指挥室'],
      { env: { SRC: 'child-only' } });
    expect(node.code).toBe(0);
    const childView = JSON.parse(run(f.nodes, ['list', 'daemon-dev', '--node', '指挥室', '--json']).out);
    expect(childView.keys).toEqual([{ key: 'DEEPSEEK_API_KEY', source: 'node' }]);
    const otherView = JSON.parse(run(f.nodes, ['list', 'daemon-dev', '--node', '通信欧', '--json']).out);
    expect(otherView.keys).toEqual([{ key: 'DEEPSEEK_API_KEY', source: 'daemon' }]);

    expect(run(f.nodes, ['unset', 'daemon-dev', 'DEEPSEEK_API_KEY', '--node', '指挥室']).code).toBe(0);
    const after = JSON.parse(run(f.nodes, ['list', 'daemon-dev', '--node', '指挥室', '--json']).out);
    expect(after.keys).toEqual([{ key: 'DEEPSEEK_API_KEY', source: 'daemon' }]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('an unbounded write is refused and nothing is stored', () => {
  const f = fixture();
  try {
    const r = run(f.nodes, ['set', 'daemon-dev', 'DEEPSEEK_API_KEY', '--from-env', 'SRC'], { env: { SRC: 'x' } });
    expect(r.code).toBe(2);
    expect(r.out).toContain('--all');
    expect(existsSync(f.store)).toBe(false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('a value on argv is not accepted (argv may leak into ps and shell history)', () => {
  const f = fixture();
  try {
    const r = run(f.nodes, ['set', 'daemon-dev', 'DEEPSEEK_API_KEY', 'secret-on-argv', '--all']);
    expect(r.code).toBe(2);
    expect(existsSync(f.store)).toBe(false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('stdin is the other value source; --all with both scopes is refused; bad keys fail', () => {
  const f = fixture();
  try {
    expect(run(f.nodes, ['set', 'daemon-dev', 'DEEPSEEK_API_KEY', '--all'], { stdin: 'from-stdin' }).code).toBe(0);
    const listed = JSON.parse(run(f.nodes, ['list', 'daemon-dev', '--json']).out);
    expect(listed.keys).toEqual([{ key: 'DEEPSEEK_API_KEY', source: 'daemon' }]);

    expect(run(f.nodes, ['set', 'daemon-dev', 'DEEPSEEK_API_KEY', '--from-env', 'SRC', '--all', '--node', '通信欧'],
      { env: { SRC: 'x' } }).code).toBe(2);
    expect(run(f.nodes, ['set', 'daemon-dev', 'deepseek_key', '--from-env', 'SRC', '--all'],
      { env: { SRC: 'x' } }).code).toBe(1);
    expect(run(f.nodes, ['set', 'daemon-dev', 'DEEPSEEK_API_KEY', '--from-env', 'MISSING', '--all']).code).toBe(1);
    expect(run(f.nodes, ['set', 'daemon-dev', 'DEEPSEEK_API_KEY', '--from-env', 'SRC', '--node', 'nope'],
      { env: { SRC: 'x' } }).code).toBe(1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('list on a daemon with no secrets file is a normal empty state', () => {
  const f = fixture();
  try {
    const r = run(f.nodes, ['list', 'daemon-dev']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('(no secrets)');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
