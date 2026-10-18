const fs=require('node:fs'),cp=require('node:child_process');
const check=dir=>{const r=cp.spawnSync('/work/agent-network/node_modules/.bin/tsc',['--noEmit'],{cwd:'/work/'+dir,encoding:'utf8'});return {status:r.status,errors:(r.stdout+r.stderr).split('\n').filter(x=>/error TS\d+/.test(x)).map(x=>x.replace(/\(\d+,\d+\)/g,'(#)')).sort()};};
const actual={server:check('server'),runtime:check('agent-node')};
for(const file of ['server/src/daemon-provider-snapshots.ts','server/src/daemon-provider-snapshots.test.ts','server/src/tools.ts','agent-node/src/runtime/daemon-provider-snapshot.ts','agent-network/src/daemon-provider-collect.ts'])fs.copyFileSync('/baseline/'+file,'/work/'+file);
const baseline={server:check('server'),runtime:check('agent-node')};
let failed=false;for(const dir of ['server','runtime']){const added=actual[dir].errors.filter(e=>!baseline[dir].errors.includes(e));console.log(JSON.stringify({directory:dir,current_status:actual[dir].status,baseline_status:baseline[dir].status,current_errors:actual[dir].errors.length,baseline_errors:baseline[dir].errors.length,added}));failed ||= added.length>0;}process.exit(failed?1:0);
