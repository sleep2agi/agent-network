import '../../server/src/require-explicit-test-db';
import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { db } from '../../server/src/db';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from '../../server/src/tools';
import { atomicWritePrivateJson } from '../../agent-network/src/private-state';
import { reconcileScopedSecrets } from '../../agent-node/src/runtime/scoped-secrets';
import { readScopedNodeEnv as runtimeEnv } from '../../agent-node/src/shared/scoped-secret-env';
import { readScopedNodeEnv as cliEnv } from '../../agent-network/src/shared/scoped-secret-env';
const net='net_secret1053', user='u_secret1053', daemon='daemon_secret1053', token='tok_secret1053', node='node_secret1053';
function client(kind='human') {
  const handlers: Record<string,any>={}, server=new McpServer({name:'test1053',version:'0'}) as any;
  const tool=server.tool.bind(server), register=server.registerTool.bind(server);
  server.tool=(name:string,description:any,schema:any,handler:any)=>{handlers[name]=handler;return tool(name,description,schema,handler);};
  server.registerTool=(name:string,config:any,handler:any)=>{handlers[name]=handler;return register(name,config,handler);};
  registerTools(server,undefined,kind==='daemon'?net:null,user,'daemon',kind==='daemon',kind==='daemon'?token:null);
  return async(name:string,args:any={})=>JSON.parse((await handlers[name](args)).content[0].text);
}
test('actual Hub handler -> token-bound Daemon -> compiled CLI private store -> runtime startup child consumes key',async()=>{
  const root=mkdtempSync(join(tmpdir(),'secret1053-')), nodes=join(root,'.anet','nodes'), dir=join(nodes,'daemon'), child=join(nodes,'child');
  mkdirSync(dir,{recursive:true,mode:0o700});mkdirSync(child,{mode:0o700});chmodSync(nodes,0o700);
  atomicWritePrivateJson(join(dir,'config.json'),{role:'host_supervisor',network_id:net,node_id:daemon});
  const config=join(child,'config.json');
  atomicWritePrivateJson(config,{alias:'child',runtime:'codex-app-server',network_id:net,node_id:node,hub:'http://127.0.0.1:1',token:'TEST-ONLY-no-network'});
  db.run("INSERT INTO users(user_id,username,password_hash,role) VALUES(?1,?1,'x','user')",[user]);
  db.run('INSERT INTO networks(network_id,network_name,owner_id) VALUES(?1,?1,?2)',[net,user]);
  db.run("INSERT INTO network_members(user_id,network_id,role) VALUES(?1,?2,'owner')",[user,net]);
  db.run('INSERT INTO nodes(node_id,node_name,alias,network_id,config_snapshot) VALUES(?1,?2,?2,?3,?4)',[daemon,'daemon',net,JSON.stringify({role:'host_supervisor',scoped_secrets_capable:true})]);
  db.run('INSERT INTO nodes(node_id,node_name,alias,network_id) VALUES(?1,?2,?2,?3)',[node,'child',net]);
  db.run("INSERT INTO api_tokens(token_id,user_id,network_id,scope,name,token_hash) VALUES(?1,?2,?3,'network','node:daemon','TEST-ONLY-hash')",[token,user,net]);
  db.run("INSERT INTO node_daemon_bindings(request_id,network_id,node_id,daemon_node_id,workdir,requested_by,status,created_at,updated_at) VALUES('binding_secret1053',?1,?2,?3,'/tmp/test1053',?4,'active',0,0)",[net,node,daemon,user]);
  const human=client(), worker=client('daemon'), value='TEST-ONLY-synthetic-secret-1053';
  try {
    expect((await worker('daemon_provider_snapshot',{action:'secret_put',id:daemon,network_id:net,provider:{key:'TEST_VENDOR_KEY',value},revision:0})).error).toBe('user_token_required');
    expect((await human('daemon_provider_snapshot',{action:'secret_put',id:daemon,network_id:net,provider:{node_id:'other',key:'TEST_VENDOR_KEY',value},revision:0})).error).toBe('secret_target_not_bound');
    const request=await human('daemon_provider_snapshot',{action:'secret_put',id:daemon,network_id:net,provider:{key:'TEST_VENDOR_KEY',value},revision:0});
    expect(request.ok).toBe(true); expect(JSON.stringify(request)).not.toContain(value);
    const warnings:string[]=[];
    await reconcileScopedSecrets({callCommHub:worker,workDir:root,alias:'daemon',networkId:net,daemonId:daemon,warn:x=>warnings.push(x)});
    expect(warnings).toEqual([]);
    const receipt=await human('daemon_provider_snapshot',{action:'secret_read',id:request.request_id,network_id:net});
    expect(receipt.status).toBe('succeeded');expect(receipt.snapshot.revision).toBe(1);
    expect(JSON.stringify(receipt)).not.toContain(value);expect(receipt.snapshot.activation).toBe('next_start');
    expect(runtimeEnv(child)).toEqual(cliEnv(child));
    const output=join(root,'probe.json');
    const started=spawnSync(process.execPath,['agent-node/src/cli.ts','--config',config],{cwd:process.cwd(),encoding:'utf8',timeout:20000,
      env:{...process.env,ANET_NODE_SECRET_PROBE:'1',ANET_NODE_SECRET_PROBE_KEY:'TEST_VENDOR_KEY',ANET_NODE_SECRET_PROBE_OUT:output}});
    expect(started.status).toBe(0);
    const probe=await Bun.file(output).json();expect(probe.value).toBe(value);expect(JSON.stringify(probe.argv)).not.toContain(value);
    expect(started.stdout+started.stderr).not.toContain(value);
    // Same-name envRef must use the saved key without needing a shell export.
    atomicWritePrivateJson(config,{alias:'child',runtime:'codex-app-server',network_id:net,node_id:node,hub:'http://127.0.0.1:1',token:'TEST-ONLY-no-network',env:{TEST_VENDOR_KEY:{_envRef:'TEST_VENDOR_KEY'}}});
    const withRef=spawnSync(process.execPath,['agent-node/src/cli.ts','--config',config],{cwd:process.cwd(),encoding:'utf8',timeout:20000,
      env:{...process.env,ANET_NODE_SECRET_PROBE:'1',ANET_NODE_SECRET_PROBE_KEY:'TEST_VENDOR_KEY',ANET_NODE_SECRET_PROBE_OUT:output}});
    expect(withRef.status).toBe(0);expect((await Bun.file(output).json()).value).toBe(value);
  } finally {
    db.run('DELETE FROM node_daemon_bindings WHERE network_id=?1',[net]);
    for(const table of ['nodes','api_tokens','network_members'])db.run(`DELETE FROM ${table} WHERE network_id=?1`,[net]);
    db.run('DELETE FROM networks WHERE network_id=?1',[net]);db.run('DELETE FROM users WHERE user_id=?1',[user]);rmSync(root,{recursive:true,force:true});
  }
});
