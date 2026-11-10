import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readScopedNodeEnv } from './scoped-secret-env';

test('inactive source marker preserves legacy startup; present store keeps strict parent checks', () => {
  const root = mkdtempSync(join(tmpdir(), 'inactive-secrets-'));
  try {
    const daemon = join(root, 'daemon'), node = join(root, 'child');
    // 2026-10-31 —— **显式 mode**：不写就吃 umask。
    // 实测本机 umask=0002 ⇒ mkdirSync 建出 0o775（组可写）⇒ 目录检查先于文件检查触发，
    // 报的是 `unsafe_secret_directory` 而断言要的是 `unsafe_secret_file`。
    // 也就是说：这条用例的结果取决于**跑它的人的 umask**，而不是被测代码。
    // 现在两条分支各自被钉住（下面新增一条目录用例），顺序不再能遮蔽。
    mkdirSync(daemon, { mode: 0o700 }); mkdirSync(node, { mode: 0o700 });
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
    // 目录可被组写 ⇒ 必须先报目录，而不是等到文件检查再说一句别的。
    // （这条与上面那条合起来，才说明「两个检查都在、且各自有名字」。）
    chmodSync(daemon, 0o770);
    expect(() => readScopedNodeEnv(node)).toThrow('unsafe_secret_directory');
    chmodSync(daemon, 0o700);
    expect(() => readScopedNodeEnv(node)).toThrow('secret_scope_mismatch');
    writeFileSync(config, JSON.stringify({ role:'host_supervisor', node_id:'node_daemon', network_id:'net_test' }));
    expect(readScopedNodeEnv(node)).toEqual({TEST_KEY:'synthetic-only'});
  } finally { rmSync(root, { recursive:true, force:true }); }
});
