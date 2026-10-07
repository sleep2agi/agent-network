import { readFileSync,writeFileSync,existsSync } from "node:fs";
if(!existsSync("/.dockerenv"))throw Error("container only");
async function runMutation(label:string,file:string,from:string,to:string,testName:string){
  if(process.env.MUTATION_CASE!==label)return;
  const original=readFileSync(file,"utf8");
  if(original.split(from).length!==2)throw Error(`anchor not unique: ${label}`);
  try{
    writeFileSync(file,original.replace(from,to));
    const p=Bun.spawn(["bun","test","src/binding-generation-http.test.ts","-t",testName],{stdout:"pipe",stderr:"pipe"});
    const [out,err,rc]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
    if(rc===0 || !(out+err).includes(`(fail) ${testName}`) || !(out+err).includes("expect(received)"))throw Error(`NOT assertion-red ${label}\n${out}${err}`);
    console.log(`WITNESSED_RED ${label} rc=${rc} assertion=${testName}`);
  }finally{writeFileSync(file,original);}
}
await runMutation("projection","src/tools.ts",'binding_request_id: n.request_id','binding_request_id: undefined','generation projection and unchanged created row');
await runMutation("token","src/tools.ts",'const callerDaemon = resolveCallerDaemonTokenBound(); // board #674: token-bound snapshot, not a lease',`const callerDaemon = {ok:true as const,daemonNodeId:"n_binding_daemon",networkId:db.get<{network_id:string}>("SELECT network_id FROM nodes WHERE node_id='n_binding_daemon'")!.network_id}; // mutation`,'token boundary denies humans general revoked and other owners');
await runMutation("daemon","src/tools.ts","WHERE b.daemon_node_id=?1 AND b.network_id=?2 AND b.status='active'","WHERE CAST(?1 AS TEXT) IS NOT NULL AND b.network_id=?2 AND b.status='active'",'token boundary denies humans general revoked and other owners');
await runMutation("child","src/tools.ts","WHERE b.daemon_node_id=?1 AND b.network_id=?2 AND b.status='active'","WHERE CAST(?1 AS TEXT) IS NOT NULL AND b.network_id=?2 AND b.status='active'",'child node token sees an empty list, not its parent binding');
await runMutation("network","src/tools.ts","WHERE b.daemon_node_id=?1 AND b.network_id=?2 AND b.status='active'","WHERE b.daemon_node_id=?1 AND CAST(?2 AS TEXT) IS NOT NULL AND b.status='active'",'network predicate rejects corrupted cross-network binding sentinel');
await runMutation("join","src/tools.ts","JOIN nodes n ON n.node_id=b.node_id AND n.network_id=b.network_id","JOIN nodes n ON n.node_id=b.node_id",'node join rejects mismatched node network sentinel');
await runMutation("active","src/tools.ts","WHERE b.daemon_node_id=?1 AND b.network_id=?2 AND b.status='active'","WHERE b.daemon_node_id=?1 AND b.network_id=?2",'non-active bindings never project generation');
await runMutation("rotation","src/node-daemon-bindings.ts",'request_id: `adopt_${uuidv4()}`','request_id: "adopt_fixed"','revocation rotates generation and old acknowledgements cannot revive');
await runMutation("revival","src/node-daemon-bindings.ts","WHERE request_id=?4 AND status='pending'","WHERE request_id=?4",'revocation rotates generation and old acknowledgements cannot revive');
await runMutation("consumer","../agent-node/src/runtime/adopt-codex-start-preflight.ts",'if (authorityRequestId !== entry.request_id) throw Error("adopt_codex_binding_generation_unproven");','', 'revocation rotates generation and old acknowledgements cannot revive');
