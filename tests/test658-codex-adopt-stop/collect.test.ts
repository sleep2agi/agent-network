import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execTmux } from "../../agent-node/src/tmux.js";
import { collectCodexPanes, codexTmuxEnv, listCodexPanes } from "../../agent-node/src/runtime/adopt-codex-tmux.js";
import { handleAdoptDoorbell } from "../../agent-node/src/runtime/adopt-daemon.js";
import { handleAdoptedLifecycle } from "../../agent-node/src/runtime/adopt-lifecycle.js";
import { adoptedChild } from "../../agent-node/src/runtime/adopt-registry.js";

test("real default socket: collect, daemon adopt, ordered stop; unrelated decoy remains", async () => {
  const workdir = mkdtempSync("/tmp/codex-evidence-"), uid = process.getuid!();
  const socket = `/tmp/tmux-${uid}/default`, codexHome = `${workdir}/codex-home`;
  mkdirSync(`/tmp/tmux-${uid}`, {recursive:true, mode:0o700});
  mkdirSync(codexHome, {mode:0o700});
  const scope = { alias: "测试节点", socket, codexHome, workdir, uid, marker: "11111111-1111-4111-8111-111111111111" };
  const env = codexTmuxEnv(socket);
  const names = [scope.alias, `${scope.alias}-桥`, `${scope.alias}-appsrv`, "unrelated-decoy"];
  try {
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
      hub:"http://127.0.0.1:9999",runtime:"codex-app-server",codexCopresence:true}),{mode:0o600});
    writeFileSync(`${nodeDir}/copresence-identity.json`,JSON.stringify({marker:scope.marker,owner_uid:uid,
      boot_id:readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim()}),{mode:0o600});
    const daemon = `${workdir}/daemon`; mkdirSync(daemon,{mode:0o700});
    const req = {ok:true,request_id:"adopt_fixture",node_id:"n_fixture",alias:scope.alias,network_id:"net_fixture",workdir};
    const calls: any[]=[];
    const deps={home:"/home/bun",workDir:daemon,hubUrl:"http://127.0.0.1:9999",networkId:"net_fixture",adoptRoots:[workdir],uid,daemonEnv:{},warn:()=>{},
      callCommHub:async(tool:string,args:any)=>{calls.push({tool,args});return tool==="get_adopt_request"?req:tool==="list_my_children"?
        {ok:true,children:[{managed:"adopted",child_node_id:"n_fixture",alias:scope.alias}]}:{ok:true};}};
    await handleAdoptDoorbell(req,deps);
    expect(calls.at(-1).args.status).toBe("adopted");
    expect(adoptedChild(daemon,scope.alias)?.codex_v2?.version).toBe(1);
    await handleAdoptedLifecycle({request_id:"stop_fixture",child_node_id:"n_fixture",child_alias:scope.alias,action:"stop"},deps);
    expect(listCodexPanes(scope,true).some(r=>r[0]==="unrelated-decoy")).toBe(true);
    expect(calls.at(-1).args).toMatchObject({status:"stopped"});
    expect(existsSync(`${nodeDir}/.hub-stopped`)).toBe(true);
    const remaining=execTmux(["list-sessions"],{env,encoding:"utf8"});
    expect(remaining).toContain("unrelated-decoy");
    expect(remaining).not.toContain(scope.alias);
  } finally {
    // Container-only cleanup by enumerated opaque IDs, never names/kill-server.
    const ids = [...new Set(listCodexPanes(scope,true).map(r=>r[1]))];
    for (const id of ids) if (/^\$\d+$/.test(id)) execTmux(["kill-session", "-t", id], {env});
  }
});
