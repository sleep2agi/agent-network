import '../../server/src/require-explicit-test-db';
import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { db } from '../../server/src/db';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from '../../server/src/tools';
import { atomicWriteJson } from '../../agent-node/src/runtime/config-apply';
import { reconcileNodeSecrets } from '../../agent-node/src/runtime/node-secrets';
import { readScopedNodeEnv as runtimeEnv } from '../../agent-node/src/shared/scoped-secret-env';
import { readScopedNodeEnv as cliEnv } from '../../agent-network/src/shared/scoped-secret-env';
const net='net_secret1075',user='u_secret1075',node='node_secret1075',other='node_other1075';
function client(target?:string,member=false) {
  const handlers: Record<string,any>={}, server=new McpServer({name:'test1075',version:'0'}) as any;
  const tool=server.tool.bind(server),register=server.registerTool.bind(server);
  server.tool=(name:string,desc:any,schema:any,handler:any)=>{handlers[name]=handler;return tool(name,desc,schema,handler);};
  server.registerTool=(name:string,config:any,handler:any)=>{handlers[name]=handler;return register(name,config,handler);};
  registerTools(server,undefined,target?net:null,member?'member1075':user,'independent',!!target,target?`tok_${target}`:null);
  return async(name:string,args:any={})=>JSON.parse((await handlers[name](args)).content[0].text);
}
test('unbound node saves, modifies and deletes keys; real startup child consumes the private store',async()=>{
  const root=mkdtempSync(join(tmpdir(),'node-secrets1075-')),dir=join(root,'.anet','nodes','independent'),config=join(dir,'config.json');
  mkdirSync(dir,{recursive:true,mode:0o700});
  const original={alias:'independent',runtime:'codex-app-server',network_id:net,node_id:node,hub:'http://127.0.0.1:1',token:'TEST-ONLY-no-network'};
  atomicWriteJson(config,original);
  db.run("INSERT INTO users(user_id,username,password_hash,role) VALUES(?1,?1,'x','user')",[user]);
  db.run('INSERT INTO networks(network_id,network_name,owner_id) VALUES(?1,?1,?2)',[net,user]);
  db.run("INSERT INTO network_members(user_id,network_id,role) VALUES(?1,?2,'owner')",[user,net]);
  for(const id of [node,other]) {
    db.run('INSERT INTO nodes(node_id,node_name,alias,network_id,config_snapshot) VALUES(?1,?1,?1,?2,?3)',[id,net,JSON.stringify({node_secrets_capable:true})]);
    db.run("INSERT INTO api_tokens(token_id,user_id,network_id,scope,name,token_hash,bound_node_id) VALUES(?1,?2,?3,'network',?4,'TEST-ONLY-hash',?5)",[`tok_${id}`,user,net,`node:${id}`,id]);
  }
  const human=client(),worker=client(node),wrong=client(other),warnings:string[]=[];
  const deps={callCommHub:worker,nodeDir:dir,nodeId:node,networkId:net,warn:(s:string)=>warnings.push(s)};
  const request=(action:string,revision?:number,value?:string)=>human('daemon_provider_snapshot',{action:`node_secret_${action}`,id:node,network_id:net,
    ...(revision===undefined?{}:{revision}),provider:{key:'TEST_VENDOR_KEY',...(value?{value}:{})}});
  const receipt=(id:string)=>human('daemon_provider_snapshot',{action:'secret_read',id,network_id:net});
  const startup=()=>{
    const output=join(root,'probe.json');
    const result=spawnSync(process.execPath,['agent-node/src/cli.ts','--config',config],{cwd:process.cwd(),encoding:'utf8',timeout:20000,
      env:{...process.env,ANET_NODE_SECRET_PROBE:'1',ANET_NODE_SECRET_PROBE_KEY:'TEST_VENDOR_KEY',ANET_NODE_SECRET_PROBE_OUT:output}});
    expect(result.status).toBe(0);expect(result.stdout+result.stderr).not.toContain('TEST-ONLY-direct-');
    return Bun.file(output).json();
  };
  try {
    expect(db.get<{n:number}>('SELECT count(*) AS n FROM node_daemon_bindings WHERE network_id=?1',net)!.n).toBe(0);
    expect((await client(undefined,true)('daemon_provider_snapshot',{action:'node_secret_put',id:node,network_id:net,revision:0,provider:{key:'TEST_VENDOR_KEY',value:'TEST-ONLY-direct-A'}})).error).toBe('secret_admin_required');
    expect((await worker('daemon_provider_snapshot',{action:'node_secret_put',id:node,network_id:net,revision:0,provider:{key:'TEST_VENDOR_KEY',value:'TEST-ONLY-direct-A'}})).error).toBe('user_token_required');
    const list=await request('list');await reconcileNodeSecrets(deps);
    expect((await receipt(list.request_id)).snapshot).toMatchObject({daemon_node_id:null,node_id:node,revision:0,keys:[]});
    const save=await request('put',0,'TEST-ONLY-direct-A');
    expect((await wrong('pull_daemon_provider_snapshots',{accept_node_secrets:true})).requests).toEqual([]);
    expect((await wrong('ack_daemon_provider_snapshot',{request_id:save.request_id,failed:true})).error).toBe('request_not_found');
    await reconcileNodeSecrets(deps);const saved=await receipt(save.request_id);
    expect(saved.status).toBe('succeeded');expect(saved.snapshot).toMatchObject({daemon_node_id:null,node_id:node,revision:1,keys:[{key:'TEST_VENDOR_KEY',source:'node'}]});
    expect(JSON.stringify(saved)).not.toContain('TEST-ONLY-direct-A');
    expect(existsSync(join(dir,'secrets-source.json'))).toBe(false);
    expect(statSync(join(dir,'node-secrets.json')).mode&0o777).toBe(0o600);
    expect(runtimeEnv(dir)).toEqual(cliEnv(dir));expect((await startup()).value).toBe('TEST-ONLY-direct-A');
    // Same-name envRef consumes the independent store without a shell export.
    atomicWriteJson(config,{...original,env:{TEST_VENDOR_KEY:{_envRef:'TEST_VENDOR_KEY'}}});
    expect((await startup()).value).toBe('TEST-ONLY-direct-A');atomicWriteJson(config,original);
    const modify=await request('put',1,'TEST-ONLY-direct-B');await reconcileNodeSecrets(deps);
    expect((await receipt(modify.request_id)).snapshot.revision).toBe(2);expect((await startup()).value).toBe('TEST-ONLY-direct-B');
    const remove=await request('delete',2);await reconcileNodeSecrets(deps);
    expect((await receipt(remove.request_id)).snapshot).toMatchObject({revision:3,keys:[]});expect((await startup()).value).toBe(null);
    expect(await Bun.file(config).json()).toEqual(original);expect(warnings).toEqual([]);
  } finally {
    for(const table of ['nodes','api_tokens','network_members'])db.run(`DELETE FROM ${table} WHERE network_id=?1`,[net]);
    db.run('DELETE FROM networks WHERE network_id=?1',[net]);db.run('DELETE FROM users WHERE user_id=?1',[user]);rmSync(root,{recursive:true,force:true});
  }
});
