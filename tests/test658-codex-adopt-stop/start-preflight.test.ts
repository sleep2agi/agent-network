import { expect } from "bun:test";
import { containerTest as test, fixtureTmux } from "./fixture-tmux.js";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { codexTmuxEnv, listCodexPanes } from "../../agent-node/src/runtime/adopt-codex-tmux.js";
import { handleAdoptDoorbell } from "../../agent-node/src/runtime/adopt-daemon.js";
import { handleAdoptedLifecycle } from "../../agent-node/src/runtime/adopt-lifecycle.js";
import { adoptedChild } from "../../agent-node/src/runtime/adopt-registry.js";
import { preflightCodexStart } from "../../agent-node/src/runtime/adopt-codex-start-preflight.js";

async function listener() {
  const server=createServer();
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  const port=(server.address() as {port:number}).port;
  return {server,port,close:()=>new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()))};
}
for (const layout of ["native","external-appserver"] as const)
test(`start preflight: ${layout} real stages, receipt/decoy unchanged, no launch`,async()=>{
  const workdir=mkdtempSync("/tmp/preflight-"),uid=process.getuid!(),nodeDir=`${workdir}/.anet/nodes/fixture`,daemon=`${workdir}/daemon`;
  mkdirSync(`${nodeDir}/codex-home`,{recursive:true,mode:0o700});mkdirSync(daemon,{mode:0o700});
  const scope={layout,alias:"启动样例",socket:`${workdir}/socket`,marker:"22222222-2222-4222-8222-222222222222",
    codexHome:`${nodeDir}/codex-home`,workdir,uid};
  const fixture=fixtureTmux(scope.socket),execTmux=fixture.exec;
  const port=await listener();await port.close();
  const config={node_id:"n_fixture",alias:scope.alias,network_id:"net_fixture",hub:"http://127.0.0.1:9999",runtime:"codex-app-server",
    codexCopresence:true,env:{ANET_TMUX_SOCKET:scope.socket},codexThreadId:"33333333-3333-4333-8333-333333333333",codexAppServerUrl:`ws://127.0.0.1:${port.port}`,
    ...(layout==="external-appserver"?{codexLaunchLayout:layout}:{})};
  writeFileSync(`${nodeDir}/config.json`,JSON.stringify(config),{mode:0o600});
  writeFileSync(`${nodeDir}/copresence-identity.json`,JSON.stringify({marker:scope.marker,owner_uid:uid,
    boot_id:readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim()}),{mode:0o600});
  const identity={workdir,nodeDir,configPath:`${nodeDir}/config.json`,nodeId:config.node_id,alias:scope.alias,config};
  const env=codexTmuxEnv(scope.socket),names=layout==="native"?[scope.alias,`${scope.alias}-桥`,`${scope.alias}-appsrv`]:[`${scope.alias}-tui`,scope.alias,`${scope.alias}-appsrv`];
  const req={ok:true,request_id:"adopt_fixture",node_id:config.node_id,alias:scope.alias,network_id:config.network_id,workdir};
  const calls:any[]=[];let authority: string|undefined=req.request_id;
  const deps={home:mkdtempSync("/tmp/preflight-home-"),workDir:daemon,hubUrl:config.hub,networkId:config.network_id,adoptRoots:[workdir],uid,daemonEnv:{},warn:()=>{},
    callCommHub:async(tool:string,args:any)=>{calls.push({tool,args});return tool==="get_adopt_request"?req:tool==="list_my_children"?
      {ok:true,children:[{managed:"adopted",child_node_id:config.node_id,alias:scope.alias,binding_request_id:authority}]}:{ok:true};}};
  try {
    for(const name of [...names,"preflight-decoy"])execTmux(["new-session","-d","-s",name,"-c",workdir,
      `exec env ANET_NODE_MARKER=${name==="preflight-decoy"?"foreign":scope.marker} CODEX_HOME=${scope.codexHome} sleep 300`],{env});
    await handleAdoptDoorbell(req,deps);
    expect(calls.at(-1).args.status).toBe("adopted");
    const entry=adoptedChild(daemon,scope.alias)!;
    expect(entry.codex_v2?.start_inputs?.thread_id).toBe(config.codexThreadId);
    await expect(preflightCodexStart(entry,identity,scope,req.request_id,()=>true)).rejects.toThrow("adopt_codex_stage_still_running");
    await handleAdoptedLifecycle({request_id:"stop_fixture",child_node_id:config.node_id,child_alias:scope.alias,action:"stop"},deps);
    expect(calls.at(-1).args.status).toBe("stopped");
    const marker=readFileSync(`${nodeDir}/.hub-stopped`,"utf8"),registry=readFileSync(`${daemon}/.anet/child-workdirs.json`,"utf8");
    const panes=listCodexPanes(scope);
    expect(panes).toHaveLength(1);
    for(const missing of [undefined,"adopt_other"])
      await expect(preflightCodexStart(entry,identity,scope,missing,()=>true)).rejects.toThrow("adopt_codex_binding_generation_unproven");
    await preflightCodexStart(entry,identity,scope,req.request_id,()=>true);
    let reads=0;
    await expect(preflightCodexStart(entry,identity,scope,req.request_id,()=>++reads===1)).rejects.toThrow("adopt_binding_revoked_during_start");
    const busy=createServer();await new Promise<void>(r=>busy.listen(port.port,"127.0.0.1",r));
    try {await expect(preflightCodexStart(entry,identity,scope,req.request_id,()=>true)).rejects.toThrow("adopt_codex_port_unavailable");}
    finally {await new Promise<void>(r=>busy.close(()=>r()));}
    // A remains closed even when all preliminary checks pass.
    await handleAdoptedLifecycle({request_id:"start_fixture",child_node_id:config.node_id,child_alias:scope.alias,action:"start"},deps);
    expect(calls.at(-1).args).toMatchObject({status:"start_failed",error:"adopt_codex_start_not_available"});
    authority=undefined; // Today's Hub: no binding generation projection.
    await handleAdoptedLifecycle({request_id:"start_old_hub",child_node_id:config.node_id,child_alias:scope.alias,action:"start"},deps);
    expect(calls.at(-1).args).toMatchObject({status:"start_failed",error:"adopt_codex_binding_generation_unproven"});
    expect(readFileSync(`${nodeDir}/.hub-stopped`,"utf8")).toBe(marker);
    expect(readFileSync(`${daemon}/.anet/child-workdirs.json`,"utf8")).toBe(registry);
    expect(listCodexPanes(scope)).toEqual(panes);
    // Dead remain-on-exit panes cannot be used as a launch destination either.
    execTmux(["new-session","-d","-s",names[0],"-c",workdir,"sleep 300"],{env});
    const target=listCodexPanes(scope).find(r=>r[0]===names[0])!;
    execTmux(["set-option","-p","-t",target[2],"remain-on-exit","on"],{env});
    process.kill(Number(target[3]),"SIGTERM");
    for(let i=0;i<40 && listCodexPanes(scope).find(r=>r[2]===target[2])?.[4]!=="1";i++)await new Promise(r=>setTimeout(r,25));
    await expect(preflightCodexStart(entry,identity,scope,req.request_id,()=>true)).rejects.toThrow("adopt_codex_session_conflict");
  } finally {
    fixture.cleanup();
  }
});
