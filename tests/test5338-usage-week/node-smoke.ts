// A real local claude-code MCP channel process registers against an isolated Hub.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { db } from '../../server/src/db';
import { register, createNetworkTokenForNode } from '../../server/src/auth';
import { bootServer } from '../../server/src/server';
import { encodeCwd } from '../../agent-network/src/project-key';
import { weekStart } from '../../agent-network/src/usage-week';
const home=mkdtempSync('/tmp/usage5338-'), cwd=join(home,'work'), alias='weekly-local', id='n_week5338', session=crypto.randomUUID();
const nodeDir=join(cwd,'.anet','nodes',alias), logs=join(home,'.claude','projects',encodeCwd(cwd));
for(const p of [nodeDir,logs]) mkdirSync(p,{recursive:true});
writeFileSync(join(nodeDir,'config.json'),JSON.stringify({node_id:id,node_name:alias}));
writeFileSync(join(logs,session+'.jsonl'),JSON.stringify({type:'assistant',timestamp:new Date().toISOString(),message:{id:'m',usage:{input_tokens:11,output_tokens:6}}}));
const owner=register('weekly_'+Date.now(),'TestOnly5338!',undefined,'seed');
const token=createNetworkTokenForNode(owner.user!.user_id,owner.network_id!,alias,id).token!;
const hub=bootServer({port:0,hostname:'127.0.0.1'});
const child=Bun.spawn(['node','/tmp/node-server.mjs'],{cwd,stdin:'pipe',stdout:'ignore',stderr:'inherit',env:{...process.env,HOME:home,ANET_USAGE_CLAUDE_SESSION:session,COMMHUB_RESUME_ID:`cc-${id}`,COMMHUB_URL:`http://127.0.0.1:${hub.port}`,COMMHUB_TOKEN:token,COMMHUB_ALIAS:alias}});
try {
  let value; for(let i=0;i<100;i++) {
    const row=db.get<{config_snapshot:string}>('SELECT config_snapshot FROM nodes WHERE node_id=?1 AND network_id=?2',id,owner.network_id);
    if(row?.config_snapshot){value=JSON.parse(row.config_snapshot).usage_week;if(value) break;}
    await Bun.sleep(100);
  }
  assert.deepEqual(value,{tokens:17,since:weekStart().since});console.log('PASS nodes.config_snapshot.usage_week:',value);
} finally {child.kill();await child.exited;hub.stop(true);}
process.exit(0);
