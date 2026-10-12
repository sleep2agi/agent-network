import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, chmodSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { atomicWritePrivateJson } from './private-state';
import { operateScopedSecrets, runDaemonSecret } from './scoped-secrets';
import { readScopedNodeEnv } from './shared/scoped-secret-env';
test('saved default and node override reach a real child; names-only receipts, CAS and explicit deletion', () => {
  const root = mkdtempSync(join(tmpdir(),'scoped-secret-')), nodes = join(root,'.anet','nodes');
  mkdirSync(nodes,{recursive:true}); chmodSync(nodes,0o700);
  const daemon = join(nodes,'daemon'), node = join(nodes,'child');
  mkdirSync(daemon,{mode:0o700}); mkdirSync(node,{mode:0o700});
  atomicWritePrivateJson(join(daemon,'config.json'), { role:'host_supervisor',network_id:'net-fixture',node_id:'daemon-fixture' });
  atomicWritePrivateJson(join(node,'config.json'), { alias:'child',runtime:'codex-app-server',network_id:'net-fixture',node_id:'node-fixture' });
  const input = (action: string, revision?: number, value?: string, node_id: string|null=null) => ({ action,revision,value,node_id,
    key:'TEST_VENDOR_KEY',network_id:'net-fixture',daemon_node_id:'daemon-fixture',request_id:`dsk_${randomUUID()}`,targets:[{node_id:'node-fixture',alias:'child'}] });
  try {
    const save = input('put',0,'synthetic-daemon-only');
    let out = '';
    expect(runDaemonSecret(['daemon'],{nodesDir:nodes,readInput:()=>JSON.stringify(save),print:s=>out=s})).toBe(0);
    expect(out).not.toContain(save.value!);
    expect(statSync(join(daemon,'scoped-secrets.json')).mode & 0o777).toBe(0o600);
    expect(operateScopedSecrets(nodes,'daemon',save).revision).toBe(1); // exact reconnect replay
    expect(readScopedNodeEnv(node)).toEqual({TEST_VENDOR_KEY:'synthetic-daemon-only'});
    const child = spawnSync(process.execPath,['-e','process.stdout.write(process.env.TEST_VENDOR_KEY||"")'],{
      env:{...process.env,...readScopedNodeEnv(node)},encoding:'utf8'});
    expect(child.status).toBe(0); expect(child.stdout).toBe(save.value!);
    expect(operateScopedSecrets(nodes,'daemon',input('put',1,'synthetic-node-only','node-fixture')).keys).toEqual([{key:'TEST_VENDOR_KEY',source:'node'}]);
    expect(readScopedNodeEnv(node).TEST_VENDOR_KEY).toBe('synthetic-node-only');
    expect(()=>operateScopedSecrets(nodes,'daemon',input('put',1,'stale'))).toThrow('secret_revision_conflict');
    expect(operateScopedSecrets(nodes,'daemon',input('delete',2,undefined,'node-fixture')).keys).toEqual([{key:'TEST_VENDOR_KEY',source:'daemon'}]);
    expect(readScopedNodeEnv(node).TEST_VENDOR_KEY).toBe(save.value!);
    expect(()=>operateScopedSecrets(nodes,'daemon',{...input('put',3,'bad'),key:'COMMHUB_TOKEN'})).toThrow('invalid_secret_input');
    expect(()=>operateScopedSecrets(nodes,'daemon',input('put',3,'bad','another-node'))).toThrow('secret_target_not_bound');
    expect(readFileSync(join(node,'config.json'),'utf8')).not.toContain('synthetic-');
    expect(operateScopedSecrets(nodes,'daemon',input('delete',3)).keys).toEqual([]);
    const registry=join(root,'.anet','child-workdirs.json');
    atomicWritePrivateJson(registry,{child:{adopted:true,request_id:'adopt-fixture',node_id:'node-fixture',nodeDir:node,workdir:root}});
    operateScopedSecrets(nodes,'daemon',input('put',4,'synthetic-adopted-only'));
    expect(readScopedNodeEnv(node).TEST_VENDOR_KEY).toBe('synthetic-adopted-only');
    atomicWritePrivateJson(registry,{});
    expect(()=>readScopedNodeEnv(node)).toThrow('secret_binding_revoked');
  } finally { rmSync(root,{recursive:true,force:true}); }
});
