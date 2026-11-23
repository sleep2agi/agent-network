import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openCodeWeek, readUsageLog } from '../../agent-network/src/usage-week';
const now=new Date(2026,10,23,13), since='2026-11-23';
const root=mkdtempSync('/tmp/sources5338-');
test('rollout: remove pre-Monday baseline and repeated cumulative readings',async()=>{
  const file=join(root,'rollout.jsonl');writeFileSync(file,[['2026-11-22',100],['2026-11-23',105],['2026-11-23',105]].map(([date,n])=>JSON.stringify({type:'event_msg',timestamp:date+'T02:10:00',payload:{type:'token_count',info:{total_token_usage:{total_tokens:n}}}})).join('\n'));
  assert.deepEqual(await readUsageLog('codex',file,now),{tokens:5,since});
});
test('Claude deduplicates assistant chunks; absent logs are unknown',async()=>{
 const file=join(root,'claude.jsonl'), r={type:'assistant',timestamp:now.toISOString(),message:{id:'m',usage:{input_tokens:1,output_tokens:3,cache_read_input_tokens:8}}};writeFileSync(file,[r,r].map(x=>JSON.stringify(x)).join('\n'));
 assert.deepEqual(await readUsageLog('claude',file,now),{tokens:12,since});assert.equal(await readUsageLog('claude',file+'missing',now),null);
});
test('OpenCode stats backing rows scoped by session/week, preserving measured zero cost',async()=>{
 const file=join(root,'opencode.db'),db=new DatabaseSync(file);db.exec('CREATE TABLE session_message(session_id TEXT,type TEXT,time_created INTEGER,data TEXT)');
 for(const [id,time] of [['ours',+now],['other',+now],['ours',0]] as const) db.prepare('INSERT INTO session_message VALUES(?,?,?,?)').run(id,'assistant',time,JSON.stringify({tokens:{input:2,output:3,reasoning:4,cache:{read:1,write:2}},cost:0}));db.close();
 assert.deepEqual(await openCodeWeek(file,'ours',true,now),{tokens:12,cost_usd:0,since});assert.equal(await openCodeWeek(file,'absent',true,now),null);
});
