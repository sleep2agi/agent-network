import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, renameSync, symlinkSync, unlinkSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { containerTest as test, fixtureTmux } from "./fixture-tmux.js";
import { stoppedReceiptAtStart, isHubStopped } from "../../agent-network/src/stopped-receipt.js";
import { execFileSync, spawnSync } from "node:child_process";
import { handleAdoptDoorbell } from "../../agent-node/src/runtime/adopt-daemon.js";
import { handleAdoptedLifecycle } from "../../agent-node/src/runtime/adopt-lifecycle.js";
import { listCodexPanes } from "../../agent-node/src/runtime/adopt-codex-tmux.js";
import { processStamp } from "../../agent-node/src/runtime/adopt-process-tree.js";

test("manual start supersedes only its captured stopped receipt; fleet parity", () => {
  const bootScript = readFileSync("deploy/fleet/anet-nodes-boot.sh", "utf8");
  const probe = bootScript.split("<<'HUB_STOPPED_PROBE' || rc=$?\n")[1].split("\nHUB_STOPPED_PROBE")[0];
  const fleetStopped = (dir:string) => {
    try { execFileSync("node", ["-",`${dir}/config.json`],{input:probe});return true; }
    catch (e:any) { if(e.status===42)return false;throw e; }
  };
  for (const change of ["none", "replace", "rewrite", "missing", "foreign", "symlink", "failed"] as const) {
    const dir = mkdtempSync("/tmp/codex-receipt-"), file = `${dir}/.hub-stopped`;
    writeFileSync(`${dir}/config.json`, JSON.stringify({node_id:"n_fixture"}));
    const old = JSON.stringify({node_id: "n_fixture", stopped: true, request_id: "stop_old"});
    if (change !== "missing") writeFileSync(file, old, {mode: 0o600});
    if (change === "foreign") writeFileSync(file, old.replace("n_fixture", "n_foreign"));
    if (change === "symlink") { renameSync(file, `${file}.target`); symlinkSync(`${file}.target`, file); }
    const clear = stoppedReceiptAtStart(dir, "n_fixture");
    if (change === "replace") {
      writeFileSync(`${file}.next`, old, {mode: 0o600}); renameSync(`${file}.next`, file);
    }
    if (change === "rewrite" || change === "missing") writeFileSync(file, old.replace("stop_old", "stop_new"), {mode: 0o600});
    if (change !== "failed") clear();
    expect(existsSync(file)).toBe(true); // Never unlink another process's stop.
    expect(isHubStopped(dir,"n_fixture")).toBe(change !== "none");
    expect(fleetStopped(dir)).toBe(change !== "none");
    if (change === "none") {
      const cert = readFileSync(`${dir}/.hub-resumed`,"utf8");
      const st = lstatSync(file, {bigint:true});
      expect(JSON.parse(cert).receipt_fingerprint).toBe(`${st.ino}:${st.ctimeNs}:${createHash("sha256").update(old).digest("hex")}`);
      // A new stop with identical JSON must not inherit an old resume grant.
      writeFileSync(`${file}.next`,old,{mode:0o600});renameSync(`${file}.next`,file);
      writeFileSync(`${dir}/.hub-resumed`,cert); // Simulate a late old-start certificate.
      expect(isHubStopped(dir,"n_fixture")).toBe(true);
      expect(fleetStopped(dir)).toBe(true);
    }
  }
});

test("fleet shell keeps stopped on probe exception or syntax failure", () => {
  const source = readFileSync("deploy/fleet/anet-nodes-boot.sh", "utf8");
  const fn = source.slice(source.indexOf("hub_stopped_dir() {"), source.indexOf("\n# 一层依赖"));
  const dir = mkdtempSync("/tmp/codex-probe-crash-");
  writeFileSync(`${dir}/config.json`, JSON.stringify({node_id:"n_fixture"}));
  writeFileSync(`${dir}/.hub-stopped`, JSON.stringify({node_id:"n_fixture",stopped:true}), {mode:0o600});
  const held = (body:string) => spawnSync("bash", ["-c", `${body}\nif hub_stopped_dir "$1"; then exit 0; else exit 1; fi`, "fixture", `${dir}/config.json`], {encoding:"utf8"});
  expect(held(fn).status).toBe(0);
  for (const injection of ['throw Error("fixture probe crash");', 'const = ;']) {
    const result = held(fn.replace("const fs = require", `${injection}\nconst fs = require`));
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(result.status).toBe(0); // Actual shell predicate, not a reimplementation.
  }
  stoppedReceiptAtStart(dir,"n_fixture")();
  expect(held(fn).status).toBe(1); // Reserved exit 42 is a real release, not always held.
});

test("both CLI layouts capture before launch and clear only on successful start", () => {
  const cli = readFileSync("agent-network/bin/cli.ts", "utf8");
  expect(cli).toContain("stoppedReceiptAtStart(join(nodesDir(), resolved.id), prelaunchCfg.node_id)");
  expect(cli.indexOf("const clearOldStoppedReceipt")).toBeLessThan(cli.indexOf("const identityPrep = await prepareIdentityForStart"));
  expect(cli).toContain("clearOldStoppedReceipt(); // Successful manual start");
  const external = cli.slice(cli.indexOf("async function startExternalAppserverNode("));
  expect(external.indexOf("stoppedReceiptAtStart(plan.nodeDir")).toBeLessThan(external.indexOf('"new-session"'));
  expect(external).toContain("if (rc === 0) clearOldStoppedReceipt();");
  expect(cli).toContain("if (isHubStopped(join(nodesDir(), n.id), n.profile?.node_id))");
});

for (const layout of ["native", "external-appserver"] as const)
test(`recovery ${layout}: old boot never signals; receipt and delete refusals`, async () => {
  const workdir = mkdtempSync("/tmp/codex-recovery-"), uid = process.getuid!();
  const nodeDir = `${workdir}/.anet/nodes/fixture`, daemon = `${workdir}/daemon`;
  mkdirSync(`${nodeDir}/codex-home`, {recursive:true,mode:0o700}); mkdirSync(daemon,{mode:0o700});
  const scope = {layout, alias:"recovery-fixture", socket:`${workdir}/socket`, workdir,
    uid, codexHome:`${nodeDir}/codex-home`, marker:"66666666-6666-4666-8666-666666666666"};
  const fixture = fixtureTmux(scope.socket);
  const config = {node_id:"n_fixture", alias:scope.alias, network_id:"net_fixture", hub:"http://127.0.0.1:9999",
    runtime:"codex-app-server", codexCopresence:true, env:{ANET_TMUX_SOCKET:scope.socket},
    ...(layout === "external-appserver" ? {codexLaunchLayout:layout} : {})};
  writeFileSync(`${nodeDir}/config.json`, JSON.stringify(config), {mode:0o600});
  const boot = readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim();
  const identity = (bootId:string) => writeFileSync(`${nodeDir}/copresence-identity.json`, JSON.stringify({marker:scope.marker,owner_uid:uid,boot_id:bootId}),{mode:0o600});
  identity(boot);
  const names = layout === "native" ? [scope.alias, `${scope.alias}-桥`, `${scope.alias}-appsrv`]
    : [`${scope.alias}-tui`, scope.alias, `${scope.alias}-appsrv`];
  const create = (name:string, marker:string, home=scope.codexHome) => fixture.exec(["new-session","-d","-s",name,"-c",workdir,
    `exec env ANET_NODE_MARKER=${marker} CODEX_HOME=${home} sleep 300`]).trim();
  const req = {ok:true,request_id:"adopt_fixture",node_id:config.node_id,alias:scope.alias,network_id:config.network_id,workdir};
  const calls:any[] = [];
  const deps = {home:mkdtempSync("/tmp/codex-home-"),workDir:daemon,hubUrl:config.hub,networkId:config.network_id,adoptRoots:[workdir],uid,daemonEnv:{},warn:()=>{},
    callCommHub:async(tool:string,args:any)=>{calls.push({tool,args});return tool === "get_adopt_request" ? req : tool === "list_my_children" ?
      {ok:true,children:[{managed:"adopted",child_node_id:config.node_id,alias:scope.alias}]} : {ok:true};}};
  const action = (action:"stop"|"delete", id="stop_fixture") => handleAdoptedLifecycle({request_id:id,child_node_id:config.node_id,child_alias:scope.alias,action},deps);
  const markerFile = `${nodeDir}/.hub-stopped`, kill = process.kill;
  try {
    for (const name of names) create(name,scope.marker);
    create("unrelated-decoy","foreign",`${workdir}/other-home`);
    await handleAdoptDoorbell(req,deps);
    expect(calls.at(-1).args.status).toBe("adopted");
    const before = listCodexPanes(scope);
    await action("delete");
    expect(calls.at(-1).args).toMatchObject({status:"stop_failed",error:"adopted_node_delete_unsupported"});
    expect(listCodexPanes(scope)).toEqual(before);
    const newer = JSON.stringify({node_id:config.node_id,stopped:true,request_id:"stop_concurrent"});
    let injected = false;
    process.kill = ((pid:number, signal:any) => {
      if (signal === "SIGTERM" && !injected) { injected=true; writeFileSync(markerFile,newer,{mode:0o600}); }
      return kill(pid,signal);
    }) as typeof process.kill;
    await action("stop");
    process.kill = kill;
    expect(injected).toBe(true);
    expect(calls.at(-1).args).toMatchObject({status:"stop_failed",error:"adopt_stop_receipt_changed"});
    expect(readFileSync(markerFile,"utf8")).toBe(newer);
    // Simulate old boot metadata, including a stale PID now pointing at decoy.
    identity("77777777-7777-4777-8777-777777777777");
    const decoy = listCodexPanes(scope)[0];
    writeFileSync(`${nodeDir}/.pid`, decoy[3], {mode:0o600});
    const decoyStamp = processStamp(Number(decoy[3]));
    let signals = 0;
    process.kill = ((pid:number, signal:any) => { signals++; return kill(pid,signal); }) as typeof process.kill;
    await action("stop","stop_after_boot");
    expect(calls.at(-1).args.status).toBe("stopped");
    expect(signals).toBe(0);
    expect(processStamp(Number(decoy[3]))).toEqual(decoyStamp);
    // Different marker + escaped/renamed session but same home is NOT absent.
    const current = create("new-generation-escaped","new-marker");
    await action("stop","stop_current_generation");
    expect(calls.at(-1).args).toMatchObject({status:"stop_failed",error:"adopt_codex_readopt_required"});
    expect(signals).toBe(0);
    expect(listCodexPanes(scope).some(r=>r[2]===current)).toBe(true);
    // Lost PID evidence must not hide a live new generation with the same home.
    unlinkSync(`${nodeDir}/.pid`);
    await action("stop","stop_missing_pid_current_generation");
    expect(calls.at(-1).args).toMatchObject({status:"stop_failed",error:"adopt_codex_readopt_required"});
    expect(signals).toBe(0);
    expect(listCodexPanes(scope).some(r=>r[2]===current)).toBe(true);
    fixture.exec(["kill-pane","-t",current]);
    const old = create("old-marker-carrier",scope.marker,`${workdir}/other-home`);
    await action("stop","stop_old_marker_carrier");
    expect(calls.at(-1).args.error).toBe("adopt_codex_readopt_required");
    expect(signals).toBe(0);
    fixture.exec(["kill-pane","-t",old]);
    const foreign = create(names[0],"foreign",`${workdir}/other-home`);
    await action("stop","stop_foreign_named_pane");
    expect(calls.at(-1).args.error).toBe("adopt_codex_readopt_required");
    expect(signals).toBe(0);
    expect(listCodexPanes(scope).some(r=>r[2]===foreign)).toBe(true);
  } finally { process.kill=kill; fixture.cleanup(); }
});
