import { spawn } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { inspectBorrowedLaunchHealth, readBorrowedLaunchConfig, BORROWED_LAUNCH_HEALTH } from "../../shared/opencode-borrowed-launch-health";
import { selectV1BorrowedCli, borrowedV1CliAdmission, V1BorrowedCliError } from "./v1-borrowed-cli";
import { loadV1HostRegistry, readPrivateV1HostFile, V1HostAdmissionError } from "./v1-host-registry";
import { createV1SharedReadClient, validateV1SharedBinding, V1SharedBindingError } from "./v1-shared-read";
import { fetchOpenCodeJson } from "./http";
import { OPENCODE_DEFAULT_DISABLED_TOOLS } from "../../shared/opencode-preset";
import { OPENCODE_V1_BACKEND } from "../opencode-backend";
import { readStartTicks } from "./attach-tui";

export const BORROWED_TUI_CAPABILITY = "ANET_CAPABILITY_OPENCODE_BORROWED_TUI_V1";
export const BORROWED_TUI_RECORD = "opencode-borrowed-v1-tui.json";
class BorrowedV1TuiError extends Error {}
function refuse(reason: string): never { throw new BorrowedV1TuiError(`OpenCode V1 borrowed TUI refused: ${reason}`); }
export function borrowedTuiFailure(error: unknown): string {
  return error instanceof BorrowedV1TuiError || error instanceof V1BorrowedCliError || error instanceof V1HostAdmissionError || error instanceof V1SharedBindingError
    ? error.message : "OpenCode V1 borrowed TUI refused: inspect original bridge/Host/session/model/lease or TUI ownership; no fallback";
}

/** Read-only admission to the already-live node's cooperative lease. No second
 * MCP registration, config rewrite, Host start/stop or session create/fork. */
async function prepare(configPath: string) {
  if (!inspectBorrowedLaunchHealth(configPath,0).ok) refuse("original bridge is not proven ready");
  const selected = readBorrowedLaunchConfig(configPath,process.cwd()), stateRoot = dirname(configPath), uid = process.getuid!();
  readPrivateV1HostFile(join(stateRoot,"opencode-borrowed-v1-selection.json"),uid,16384);
  const raw = JSON.parse(readPrivateV1HostFile(configPath,uid,1024*1024).toString("utf8"));
  const selection = selectV1BorrowedCli(raw.opencodeBorrowedV1,{runtime:"opencode",generation:"v1",mode:raw.opencodeMode,
    configFile:configPath,networkId:raw.network_id,nodeId:raw.node_id,alias:raw.alias,cwd:process.cwd(),stateRoot,
    model:raw.model,sessionId:raw.session,newSession:false,unsafeTools:raw.flags?.opencodeUnsafeTools===true});
  if (!selection) refuse("explicit existing borrowed selection required");
  const admission = borrowedV1CliAdmission(selection,{hubMcpUrl:`${raw.hub.replace(/\/+$/,"")}/mcp`,hubToken:raw.token,
    binary:process.env.ANET_OPENCODE_BIN,binarySearchPath:process.env.PATH,expectedVersion:process.env.ANET_OPENCODE_VERSION});
  const launch = JSON.parse(readPrivateV1HostFile(join(stateRoot,BORROWED_LAUNCH_HEALTH),uid,16384).toString("utf8"));
  const lockPath = join(selected.selection.binding.directory,".anet-v1-mcp.lock");
  const config = join(selected.selection.binding.directory,"opencode.json");
  const lockBytes = readPrivateV1HostFile(lockPath,uid,16384), projectBytes = readPrivateV1HostFile(config,uid,1024*1024);
  const lock = JSON.parse(lockBytes.toString("utf8")), project = JSON.parse(projectBytes.toString("utf8"));
  const names = Object.keys(project.mcp ?? {}).filter(n=>/^commhub_[a-f0-9]{32}$/.test(n));
  if (lock.schema!==1 || !/^[a-f0-9]{64}$/.test(lock.lease) || names.length!==1
    || project.mcp[names[0]]?.headers?.Authorization!==`Bearer ${lock.lease}`) refuse("original scoped MCP lease unavailable");
  validateV1SharedBinding(admission.expectedBinding,lock);
  const original = loadV1HostRegistry(admission.hostRoot,admission.expectedHost,admission.attestation).server;
  async function verify(requireIdle: boolean) {
    try {
      if (!inspectBorrowedLaunchHealth(configPath,0,launch.nonce).ok) refuse("bridge incarnation lost");
      selection!.readBinding();
      const server = loadV1HostRegistry(admission.hostRoot,admission.expectedHost,admission.attestation).server;
      if (server.identity!==original.identity || server.url!==original.url || server.password!==original.password) refuse("Host authority changed");
      if (!readPrivateV1HostFile(lockPath,uid,16384).equals(lockBytes)
        || !readPrivateV1HostFile(config,uid,1024*1024).equals(projectBytes)) refuse("lease/config changed");
      await createV1SharedReadClient(server,admission.expectedBinding,selection!.readBinding()).readSession();
      const read = (path: string)=>fetchOpenCodeJson(server.url,server.password,path,{headers:{"x-opencode-directory":encodeURIComponent(admission.expectedBinding.directory)},redirect:"error"},2000);
      const c = await read("/config"), mcp = await read("/mcp");
      if (c?.model!==selected.model || c.permission?.["commhub_*"]!=="allow" || c.permission?.["*"]==="deny"
        || c.permission?.external_directory!=="deny" || mcp?.[names[0]]?.status!=="connected") refuse("original model/MCP/policy changed");
      for (const tool of OPENCODE_DEFAULT_DISABLED_TOOLS) if (c.tools?.[tool]!==false || c.permission?.[tool]!=="deny") refuse("built-in policy changed");
      if (requireIdle) {
        const states = await read("/session/status");
        if (!states || typeof states!=="object" || Array.isArray(states)
          || (Object.hasOwn(states,admission.expectedBinding.sessionId) && states[admission.expectedBinding.sessionId]?.type!=="idle")) refuse("session busy/retrying/unknown");
      }
      selection!.readBinding();
      const after = loadV1HostRegistry(admission.hostRoot,admission.expectedHost,admission.attestation).server;
      if (after.identity!==original.identity || after.url!==original.url || after.password!==original.password) refuse("Host authority changed during read");
      if (!inspectBorrowedLaunchHealth(configPath,0,launch.nonce).ok
        || !readPrivateV1HostFile(lockPath,uid,16384).equals(lockBytes)
        || !readPrivateV1HostFile(config,uid,1024*1024).equals(projectBytes)) refuse("authority changed during read");
    } catch (error) { if (error instanceof BorrowedV1TuiError) throw error; refuse("selected bridge/Host/session/model/MCP is not ready; retain original state"); }
  }
  await verify(true);
  return { selected, admission, server:original, verify, stateRoot, launch };
}

/** Foreground native human TUI. Only its own child can be signalled; no native
 * abort is issued, so closing the terminal does not cancel a human Host turn. */
export async function runBorrowedV1Tui(configPath: string): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) refuse("an interactive terminal is required");
  const path = join(dirname(configPath),BORROWED_TUI_RECORD);
  // Known/unknown terminal ownership refuses before native probes and reads.
  // The exclusive create below still handles a concurrent first attach.
  try { lstatSync(path); refuse("existing or unknown TUI record; retain its Owner's terminal"); }
  catch (error: any) { if (error?.code!=="ENOENT") { if(error instanceof BorrowedV1TuiError)throw error; refuse("TUI ownership unreadable; retain original state"); } }
  const p = await prepare(configPath), nonce = randomUUID();
  const base = {schema:1,nonce,mode:"borrowed-v1",binding:p.admission.expectedBinding,model:p.selected.model,
    bridge:p.launch.bridge,wrapper:{pid:process.pid,ticks:readStartTicks(process.pid)}};
  // Exclusive cooperative ownership; stale/unknown records require Owner
  // recovery, never automatic replacement or same-name terminal takeover.
  try { writeFileSync(path,JSON.stringify({...base,state:"opening"})+"\n",{flag:"wx",mode:0o600}); }
  catch { refuse("existing or unknown TUI record; inspect the original Owner's terminal"); }
  let done: Promise<number> | undefined;
  let root: string | undefined, child: ReturnType<typeof spawn> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let stopRequested = false, guardFailed = false, checking = false;
  const stop = () => {
    stopRequested = true;
    if (!child || child.exitCode!==null || child.signalCode!==null) return;
    child.kill("SIGTERM");
    timer ??= setTimeout(()=>{if(child?.exitCode===null && child.signalCode===null)child.kill("SIGKILL");},2000);
  };
  const signals = ["SIGINT","SIGTERM","SIGHUP"] as const;
  for (const s of signals) process.on(s,stop);
  let watch: ReturnType<typeof setInterval> | undefined;
  try {
    root = mkdtempSync(join(tmpdir(),"anet-v1-borrowed-tui-"));
    const roots = Object.fromEntries(["home","config","data","cache","state","runtime","managed"].map(n=>{
      const dir=join(root!,n);mkdirSync(dir,{mode:0o700});return [n,dir];}));
    const env: NodeJS.ProcessEnv = {PATH:process.env.PATH,TERM:process.env.TERM??"xterm-256color",LANG:process.env.LANG??"C.UTF-8",
      COLORTERM:process.env.COLORTERM,HOME:roots.home,XDG_CONFIG_HOME:roots.config,XDG_DATA_HOME:roots.data,
      XDG_CACHE_HOME:roots.cache,XDG_STATE_HOME:roots.state,XDG_RUNTIME_DIR:roots.runtime,OPENCODE_TEST_MANAGED_CONFIG_DIR:roots.managed,
      OPENCODE_SERVER_USERNAME:"opencode",OPENCODE_SERVER_PASSWORD:p.server.password,
      OPENCODE_DISABLE_AUTOUPDATE:"1",OPENCODE_DISABLE_EXTERNAL_SKILLS:"1",OPENCODE_DISABLE_CLAUDE_CODE:"1",OPENCODE_DISABLE_LSP_DOWNLOAD:"1",
      OPENCODE_DISABLE_PROJECT_CONFIG:"1",OPENCODE_PURE:"1",OPENCODE_CONFIG_CONTENT:JSON.stringify({model:p.selected.model,plugin:[]})};
    await p.verify(true);
    if (stopRequested) return 1;
    const binary = OPENCODE_V1_BACKEND.revalidateBinary(p.admission.attestation,{expectedVersion:p.server.version,
      forbiddenRoots:[p.selected.selection.binding.directory,p.stateRoot,p.selected.selection.hostRoot,root]});
    child = spawn(binary,OPENCODE_V1_BACKEND.attachArgs({url:p.server.url,sessionId:p.admission.expectedBinding.sessionId,
      cwd:p.admission.expectedBinding.directory}),{cwd:p.admission.expectedBinding.directory,env,stdio:"inherit"});
    done = new Promise<number>(resolve=>{child!.once("error",()=>resolve(1));child!.once("exit",code=>resolve(code??(stopRequested&&!guardFailed?0:1)));});
    if (!child.pid) { await done; refuse("native TUI spawn did not provide process identity"); }
    const ticks = readStartTicks(child.pid);
    if (!ticks) { stop(); await done; refuse("native TUI process birth unavailable"); }
    const tmp = `${path}.${nonce}.tmp`;
    try { writeFileSync(tmp,JSON.stringify({...base,state:"running",tui:{pid:child.pid,ticks},root})+"\n",{flag:"wx",mode:0o600});renameSync(tmp,path); }
    finally { rmSync(tmp,{force:true}); }
    watch = setInterval(()=>{
      if (checking || stopRequested) return;
      checking = true;
      void p.verify(false).catch(()=>{guardFailed=true;stop();}).finally(()=>{checking=false;});
    },1000);
    const code = await done;
    return guardFailed ? 1 : code;
  } finally {
    if (child && child.exitCode===null && child.signalCode===null) { stop(); await done; }
    if (watch) clearInterval(watch);
    if (timer) clearTimeout(timer);
    for (const s of signals) process.off(s,stop);
    try { const r=JSON.parse(readPrivateV1HostFile(path,process.getuid!(),16384).toString("utf8"));
      if (r.nonce===nonce && r.wrapper?.pid===process.pid && r.wrapper?.ticks===base.wrapper.ticks) rmSync(path);
    } catch { /* preserve changed or unreadable ownership */ }
    if (root && (!child || child.exitCode!==null || child.signalCode!==null)) {
      const st=lstatSync(root);if(st.isDirectory() && !st.isSymbolicLink() && st.uid===process.getuid?.())rmSync(root,{recursive:true});
    }
  }
}
