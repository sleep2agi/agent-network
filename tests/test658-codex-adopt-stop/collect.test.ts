import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execTmux } from "../../agent-node/src/tmux.js";
import { collectCodexPanes, codexTmuxEnv, listCodexPanes } from "../../agent-node/src/runtime/adopt-codex-tmux.js";
import { handleAdoptDoorbell } from "../../agent-node/src/runtime/adopt-daemon.js";
import { handleAdoptedLifecycle } from "../../agent-node/src/runtime/adopt-lifecycle.js";
import { adoptedChild, forgetAdoptedChild } from "../../agent-node/src/runtime/adopt-registry.js";
import { verifyCodexPanes } from "../../agent-node/src/runtime/adopt-codex-evidence.js";
import { stopCodexStages } from "../../agent-node/src/runtime/adopt-codex-stop.js";
import { processStamp } from "../../agent-node/src/runtime/adopt-process-tree.js";
import { hasAdoptionMarker, readAdoptionProc } from "../../agent-node/src/runtime/adopt-proc.js";

function barrier(ready:()=>boolean) {
  const deadline=Date.now()+3000;
  while(!ready()) {
    if(Date.now()>deadline)throw Error("fixture barrier timed out");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
  }
}
for(const scenario of ["late-escape","late-foreign-child"] as const)
test(`signal boundary: ${scenario}`,async()=>{
  const workdir=mkdtempSync("/tmp/codex-boundary-"),uid=process.getuid!();
  const scope={layout:"native" as const,alias:"边界样例",socket:`${workdir}/socket`,codexHome:`${workdir}/codex-home`,workdir,uid,marker:"55555555-5555-4555-8555-555555555555"};
  mkdirSync(scope.codexHome,{mode:0o700});
  const env=codexTmuxEnv(scope.socket),kill=process.kill;
  let escaped:ReturnType<typeof Bun.spawn>|undefined,foreignPid:number|undefined;
  try {
    for(const name of [`${scope.alias}-桥`,scope.alias,`${scope.alias}-appsrv`]){
      const command=scenario==="late-foreign-child" && name.endsWith("-桥")
        ? `bun /test/tests/test658-codex-adopt-stop/late-child.ts ${workdir}` : "sleep 300";
      execTmux(["new-session","-d","-s",name,"-c",workdir,`exec env ANET_NODE_MARKER=${scope.marker} CODEX_HOME=${scope.codexHome} ${command}`],{env});
    }
    if(scenario==="late-foreign-child")barrier(()=>existsSync(`${workdir}/ready`));
    const target=listCodexPanes(scope).find(r=>r[0]===`${scope.alias}-${scenario==="late-escape"?"appsrv":"桥"}`)!;
    let injected=false;
    process.kill=((pid:number,signal:any)=>{
      if(pid===Number(target[3]) && signal==="SIGSTOP" && !injected){
        injected=true;
        if(scenario==="late-escape") {
          escaped=Bun.spawn(["sleep","300"],{cwd:workdir,env:{...process.env,ANET_NODE_MARKER:scope.marker,CODEX_HOME:scope.codexHome},stdout:"ignore",stderr:"ignore"});
          barrier(()=>hasAdoptionMarker(escaped!.pid,scope.marker));
        }else{
          writeFileSync(`${workdir}/trigger`,"go");
          barrier(()=>existsSync(`${workdir}/child-pid`));
          foreignPid=Number(readFileSync(`${workdir}/child-pid`,"utf8"));
        }
      }
      return kill(pid,signal);
    }) as typeof process.kill;
    await expect(stopCodexStages(scope)).rejects.toThrow(scenario==="late-escape"?"adopt_codex_stage_still_running":"adopt_codex_identity_unproven");
    expect(injected).toBe(true);
    expect(processStamp(scenario==="late-escape"?escaped!.pid:foreignPid!)).not.toBeNull();
    if(scenario==="late-escape")expect(processStamp(Number(target[3]))).toBeNull();
  }finally{
    process.kill=kill;
    if(escaped){escaped.kill();await escaped.exited;}
    if(foreignPid && processStamp(foreignPid))kill(foreignPid,"SIGKILL");
    for(const row of listCodexPanes(scope,true))execTmux(["kill-pane","-t",row[2]],{env});
  }
});

test("mixed layout and unknown layout reject before any signal", async () => {
  const workdir = mkdtempSync("/tmp/codex-layout-"), uid = process.getuid!();
  const socket = `${workdir}/socket`, codexHome = `${workdir}/codex-home`;
  mkdirSync(codexHome, {mode:0o700});
  const scope = {layout:"native" as const,alias:"布局样例",socket,codexHome,workdir,uid,marker:"22222222-2222-4222-8222-222222222222"};
  const env = codexTmuxEnv(socket);
  const spawn = (name:string) => execTmux(["new-session","-d","-s",name,"-c",workdir,
    `exec env ANET_NODE_MARKER=${scope.marker} CODEX_HOME=${codexHome} sleep 300`],{env});
  try {
    for(const name of [`${scope.alias}-appsrv`,`${scope.alias}-tui`,scope.alias]) spawn(name);
    spawn(`${scope.alias}-桥`);
    const before=listCodexPanes(scope), kill=process.kill; let signals=0;
    process.kill=((...args:any[])=>{signals++;return (kill as any)(...args);}) as typeof process.kill;
    try {
      for(const layout of ["native","external-appserver"] as const) {
        expect(()=>collectCodexPanes({...scope,layout})).toThrow("adopt_codex_untracked_process");
        await expect(stopCodexStages({...scope,layout})).rejects.toThrow("adopt_codex_untracked_process");
      }
      await expect(stopCodexStages({...scope,layout:"unknown" as any})).rejects.toThrow("adopt_codex_layout_unsupported");
      expect(signals).toBe(0);
      expect(listCodexPanes(scope)).toEqual(before);
    } finally {process.kill=kill;}
  } finally {
    for(const id of new Set(listCodexPanes(scope,true).map(r=>r[1])))
      if(/^\$\d+$/.test(id)) execTmux(["kill-session","-t",id],{env});
  }
});

for(const scenario of ["missing-bridge","frozen","descendant-cwd","escaped","remain-on-exit"] as const)
test(`partial stop recovery: ${scenario}`,async()=>{
  const workdir=mkdtempSync("/tmp/codex-recovery-"), uid=process.getuid!();
  const scope={layout:"native" as const,alias:"恢复样例",socket:`${workdir}/socket`,codexHome:`${workdir}/codex-home`,workdir,uid,marker:"44444444-4444-4444-8444-444444444444"};
  mkdirSync(scope.codexHome,{mode:0o700});mkdirSync(`${workdir}/child`);
  const env=codexTmuxEnv(scope.socket);let escaped:ReturnType<typeof Bun.spawn>|undefined;
  try {
    for(const name of [`${scope.alias}-桥`,scope.alias,`${scope.alias}-appsrv`]) {
      if(scenario==="missing-bridge" && name.endsWith("-桥"))continue;
      const command=scenario==="descendant-cwd" && name.endsWith("-appsrv")
        ? `exec env ANET_NODE_MARKER=${scope.marker} CODEX_HOME=${scope.codexHome} bash -c '(cd child; exec sleep 300) & wait'`
        : `exec env ANET_NODE_MARKER=${scope.marker} CODEX_HOME=${scope.codexHome} sleep 300`;
      execTmux(["new-session","-d","-s",name,"-c",workdir,command],{env});
    }
    const before=listCodexPanes(scope);
    if(scenario==="frozen") for(const row of before) process.kill(Number(row[3]),"SIGSTOP");
    if(scenario==="remain-on-exit") for(const row of before) execTmux(["set-option","-p","-t",row[2],"remain-on-exit","on"],{env});
    if(scenario==="escaped") {
      escaped=Bun.spawn(["sleep","300"],{cwd:workdir,env:{...process.env,ANET_NODE_MARKER:scope.marker,CODEX_HOME:scope.codexHome},stdout:"ignore",stderr:"ignore"});
      await new Promise(r=>setTimeout(r,30));
      const kill=process.kill;let signals=0;
      process.kill=((...args:any[])=>{signals++;return(kill as any)(...args);}) as typeof process.kill;
      try {await expect(stopCodexStages(scope)).rejects.toThrow("adopt_codex_untracked_process");expect(signals).toBe(0);}
      finally {process.kill=kill;}
      expect(listCodexPanes(scope)).toEqual(before);
      escaped.kill();await escaped.exited;escaped=undefined;
    }
    await stopCodexStages(scope);
    expect(before.every(r=>!processStamp(Number(r[3])))).toBe(true);
    expect(listCodexPanes(scope,true).filter(r=>r[4]!=="1")).toHaveLength(0);
    await stopCodexStages(scope); // repeated stop / daemon replay remains safe
  }finally{
    if(escaped){escaped.kill();await escaped.exited;}
    for(const row of listCodexPanes(scope,true))execTmux(["kill-pane","-t",row[2]],{env});
  }
});

for (const layout of ["native","external-appserver"] as const) test(`real default socket: ${layout}, adopt, stop, re-adopt, replay; decoy remains`, async () => {
  const workdir = mkdtempSync("/tmp/codex-evidence-"), uid = process.getuid!();
  const socket = `/tmp/tmux-${uid}/default`, codexHome = `${workdir}/codex-home`;
  mkdirSync(`/tmp/tmux-${uid}`, {recursive:true, mode:0o700});
  mkdirSync(codexHome, {mode:0o700});
  const scope = { layout, alias: "测试节点", socket, codexHome, workdir, uid, marker: "11111111-1111-4111-8111-111111111111" };
  const env = codexTmuxEnv(socket);
  const names = layout==="native" ? [scope.alias, `${scope.alias}-桥`, `${scope.alias}-appsrv`, "unrelated-decoy"] : [`${scope.alias}-tui`,scope.alias,`${scope.alias}-appsrv`,"unrelated-decoy"];
  const bad=Bun.spawn(["bash","-c","exec env $'BAD=\\xff\\xfe' sleep 300"],{stdout:"ignore",stderr:"ignore"});
  try {
    barrier(()=>{try{readAdoptionProc(bad.pid);return false;}catch(e:any){return e.message==="adopt_proc_invalid";}});
    expect(processStamp(bad.pid)).not.toBeNull();
    for (const name of names) execTmux(["new-session", "-d", "-s", name, "-c", workdir,
      `exec env ANET_NODE_MARKER=${name === "unrelated-decoy" ? "foreign" : scope.marker} CODEX_HOME=${codexHome} sleep 300`], {env});
    const panes = collectCodexPanes(scope);
    expect(panes.length).toBe(3);
    expect(panes.every(p => /^%\d+$/.test(p.pane))).toBe(true);
    expect(() => collectCodexPanes({...scope, marker:"wrong"})).toThrow("adopt_codex_identity_unproven");
    // Collection is read-only: all four sessions still exist.
    const sessions = execTmux(["list-sessions"], {env,encoding:"utf8"});
    expect(sessions).toContain("unrelated-decoy");
    const nodeDir = `${workdir}/.anet/nodes/fixture`;
    mkdirSync(nodeDir, {recursive:true,mode:0o700});
    // The production canonical home is inside nodeDir; relaunch with it.
    for (const pane of panes) execTmux(["kill-pane","-t",pane.pane], {env});
    const realHome = `${nodeDir}/codex-home`; mkdirSync(realHome,{mode:0o700});
    for (const name of names.slice(0,3)) execTmux(["new-session","-d","-s",name,"-c",workdir,
      `exec env ANET_NODE_MARKER=${scope.marker} CODEX_HOME=${realHome} sleep 300`],{env});
    writeFileSync(`${nodeDir}/config.json`, JSON.stringify({node_id:"n_fixture",alias:scope.alias,network_id:"net_fixture",
      hub:"http://127.0.0.1:9999",runtime:"codex-app-server",codexCopresence:true,...(layout==="external-appserver"?{codexLaunchLayout:layout}:{})}),{mode:0o600});
    writeFileSync(`${nodeDir}/copresence-identity.json`,JSON.stringify({marker:scope.marker,owner_uid:uid,
      boot_id:readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim()}),{mode:0o600});
    const daemon = `${workdir}/daemon`; mkdirSync(daemon,{mode:0o700});
    const req = {ok:true,request_id:"adopt_fixture",node_id:"n_fixture",alias:scope.alias,network_id:"net_fixture",workdir};
    const calls: any[]=[];
    const deps={home:mkdtempSync("/tmp/codex-daemon-home-"),workDir:daemon,hubUrl:"http://127.0.0.1:9999",networkId:"net_fixture",adoptRoots:[workdir],uid,daemonEnv:{},warn:()=>{},
      callCommHub:async(tool:string,args:any)=>{calls.push({tool,args});return tool==="get_adopt_request"?req:tool==="list_my_children"?
        {ok:true,children:[{managed:"adopted",child_node_id:"n_fixture",alias:scope.alias}]}:{ok:true};}};
    await handleAdoptDoorbell(req,deps);
    expect(calls.at(-1).args.status).toBe("adopted");
    expect(adoptedChild(daemon,scope.alias)?.codex_v2?.version).toBe(1);
    const live=collectCodexPanes({...scope,codexHome:realHome});
    const order:string[]=[], kill=process.kill;
    process.kill=((pid:number,signal:any)=>{
      const pane=live.find(p=>p.rootPid===pid);
      if(pane&&signal==="SIGTERM")order.push(pane.sessionName);
      return kill(pid,signal);
    }) as typeof process.kill;
    try {await handleAdoptedLifecycle({request_id:"stop_fixture",child_node_id:"n_fixture",child_alias:scope.alias,action:"stop"},deps);}
    finally {process.kill=kill;}
    expect(listCodexPanes(scope,true).some(r=>r[0]==="unrelated-decoy")).toBe(true);
    expect(calls.at(-1).args).toMatchObject({status:"stopped"});
    expect(existsSync(`${nodeDir}/.hub-stopped`)).toBe(true);
    const remaining=execTmux(["list-sessions"],{env,encoding:"utf8"});
    expect(remaining).toContain("unrelated-decoy");
    expect(remaining).not.toContain(scope.alias);
    expect(order).toEqual([names[1],names[0],names[2]]);
    await handleAdoptedLifecycle({request_id:"stop_retry",child_node_id:"n_fixture",child_alias:scope.alias,action:"stop"},deps);
    expect(calls.at(-1).args).toMatchObject({status:"stopped"});
    const marker2="33333333-3333-4333-8333-333333333333";
    for(const name of names.slice(0,3)) execTmux(["new-session","-d","-s",name,"-c",workdir,
      `exec env ANET_NODE_MARKER=${marker2} CODEX_HOME=${realHome} sleep 300`],{env});
    writeFileSync(`${nodeDir}/copresence-identity.json`,JSON.stringify({marker:marker2,owner_uid:uid,
      boot_id:readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim()}),{mode:0o600});
    await handleAdoptedLifecycle({request_id:"stop_rotated",child_node_id:"n_fixture",child_alias:scope.alias,action:"stop"},deps);
    expect(calls.at(-1).args).toMatchObject({status:"stop_failed",error:"adopt_codex_readopt_required"});
    forgetAdoptedChild(daemon,scope.alias,req.request_id);
    req.request_id="adopt_new_generation";
    await handleAdoptDoorbell(req,deps);
    expect(calls.at(-1).args.status).toBe("adopted");
    expect(existsSync(`${nodeDir}/.hub-stopped`)).toBe(false);
    // Stale and matching receipts alike cannot mask live verified stages.
    writeFileSync(`${nodeDir}/.hub-stopped`,JSON.stringify({node_id:"n_fixture",stopped:true}),{mode:0o600});
    await handleAdoptedLifecycle({request_id:"stop_new_generation",child_node_id:"n_fixture",child_alias:scope.alias,action:"stop"},deps);
    expect(calls.at(-1).args.status).toBe("stopped");
    expect(JSON.parse(readFileSync(`${nodeDir}/.hub-stopped`,"utf8"))).toMatchObject({marker:marker2,binding_request_id:req.request_id});
  } finally {
    bad.kill();await bad.exited;
    // Container-only cleanup by enumerated opaque IDs, never names/kill-server.
    const ids = [...new Set(listCodexPanes(scope,true).map(r=>r[1]))];
    for (const id of ids) if (/^\$\d+$/.test(id)) execTmux(["kill-session", "-t", id], {env});
  }
});
