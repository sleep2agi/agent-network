import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readScopedNodeEnv } from './scoped-secret-env';

test('inactive source marker preserves legacy startup; present store keeps strict parent checks', () => {
  const root = mkdtempSync(join(tmpdir(), 'inactive-secrets-'));
  try {
    const daemon = join(root, 'daemon'), node = join(root, 'child');
    mkdirSync(daemon); mkdirSync(node);
    writeFileSync(join(node, 'config.json'), JSON.stringify({ node_id: 'node_child', network_id: 'net_test' }), {mode:0o600});
    writeFileSync(join(node, 'secrets-source.json'), JSON.stringify({ schema:1, daemon_dir:daemon,
      daemon_node_id:'node_daemon', node_id:'node_child', network_id:'net_test' }), {mode:0o600});
    const config = join(daemon, 'config.json');
    writeFileSync(config, JSON.stringify({ role:'host_supervisor', node_id:'node_daemon' }), {mode:0o644});
    expect(readScopedNodeEnv(node)).toEqual({});
    writeFileSync(join(daemon, 'scoped-secrets.json'), JSON.stringify({ schema:1, daemon_node_id:'node_daemon',
      network_id:'net_test', revision:1, defaults:{ TEST_KEY:'synthetic-only' }, nodes:{} }), {mode:0o600});
    expect(() => readScopedNodeEnv(node)).toThrow('unsafe_secret_file');
    chmodSync(config, 0o600);
    expect(() => readScopedNodeEnv(node)).toThrow('secret_scope_mismatch');
    writeFileSync(config, JSON.stringify({ role:'host_supervisor', node_id:'node_daemon', network_id:'net_test' }));
    expect(readScopedNodeEnv(node)).toEqual({TEST_KEY:'synthetic-only'});
  } finally { rmSync(root, { recursive:true, force:true }); }
});
