import { existsSync, lstatSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { minimalEnv } from "./create-node-daemon.js";
import { loadNodeSecrets, parseSecretsEnv } from "../node-secrets.js";
import { CommHubError } from "../reply-reliability.js";
import { verifyAdoptionLocalIdentity, verifyAdoptionProcess, type AdoptionIdentityOptions, type AdoptionLocalIdentity } from "./adopt-local-identity.js";
import { readAdoptionPid, readAdoptionProc, type AdoptionProc } from "./adopt-proc.js";
import { adoptedChild, forgetAdoptedChild, readWorkdirRegistry, writeAdoptedChild } from "./adopt-registry.js";
import { readCodexScope } from "./adopt-codex-scope.js";
import { collectCodexPanes } from "./adopt-codex-tmux.js";
import { configHash } from "./adopt-launch-evidence.js";
import { optionalCodexStartInputs } from "./adopt-codex-start-inputs.js";

export interface AdoptDaemonDeps extends AdoptionIdentityOptions {
  workDir: string;
  callCommHub: (tool: string, args: Record<string, unknown>) => Promise<any>;
  readProc?: (pid: number) => AdoptionProc | null;
  warn: (message: string) => void;
}
export function reproducibleEnvironment(identity: AdoptionLocalIdentity, deps: AdoptDaemonDeps): NodeJS.ProcessEnv {
  const cfg = identity.config;
  const env = minimalEnv({}, "linux", { HOME: deps.home, LANG: deps.daemonEnv.LANG });
  const local: Record<string, string> = {};
  const path = join(identity.nodeDir, ".env");
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== deps.uid || (st.mode & 0o077)) throw Error("adopt_env_file_unsafe");
    const parsed = parseSecretsEnv(readFileSync(path, "utf8"));
    if (parsed.problems.length) throw Error("adopt_env_file_invalid");
    Object.assign(local, parsed.values);
  } catch (e: any) { if (e.code !== "ENOENT") throw e; }
  if (cfg.env !== undefined) {
    if (!cfg.env || typeof cfg.env !== "object" || Array.isArray(cfg.env)) throw Error("adopt_config_env_invalid");
    for (const [key, value] of Object.entries(cfg.env)) {
      if (typeof value === "string") env[key] = value.replace(/^~/, deps.home);
      else if (value && typeof value === "object" && typeof (value as any)._envRef === "string") {
        const ref = (value as any)._envRef;
        if (local[ref] === undefined) throw Error(`adopt_env_not_reproducible:${key}`);
        env[key] = local[ref];
      } else throw Error("adopt_config_env_invalid");
    }
  }
  loadNodeSecrets(identity.nodeDir, env);
  Object.assign(env, { COMMHUB_ALIAS: identity.alias, COMMHUB_NODE_ID: identity.nodeId,
    COMMHUB_URL: deps.hubUrl, ANET_CONFIG_UPDATE_CAPABLE: "1" });
  if (typeof cfg.token === "string") env.COMMHUB_TOKEN = cfg.token;
  return env;
}
const running = new Map<string, Promise<void>>();
export function handleAdoptDoorbell(event: { request_id: string }, deps: AdoptDaemonDeps): Promise<void> {
  const key = `${deps.workDir}\0${event.request_id}`;
  const existing = running.get(key); if (existing) return existing;
  const promise = adopt(event.request_id, deps).finally(() => running.delete(key));
  running.set(key, promise); return promise;
}
async function adopt(requestId: string, deps: AdoptDaemonDeps): Promise<void> {
  const req = await deps.callCommHub("get_adopt_request", { request_id: requestId });
  if (!req?.ok) return;
  let registered = false;
  let alias = "";
  let staleStopped: {path:string; ino:number; mtimeMs:number} | undefined;
  try {
    if (process.platform !== "linux") throw Error("adopt_platform_unsupported");
    if (req.request_id !== requestId) throw Error("adopt_request_mismatch");
    const identity = verifyAdoptionLocalIdentity(req, { ...deps, allowCodexV2: true });
    alias = identity.alias;
    if (identity.config.codexCopresence) {
      const scope = readCodexScope(identity, deps.uid);
      collectCodexPanes(scope);
      const checked = verifyAdoptionLocalIdentity(req, { ...deps, allowCodexV2: true });
      if (!isDeepStrictEqual(identity, checked) || !isDeepStrictEqual(scope, readCodexScope(checked, deps.uid))) throw Error("adopt_identity_changed");
      const receipt=join(identity.nodeDir,".hub-stopped");
      if(existsSync(receipt)) {
        const st=lstatSync(receipt);
        if(!st.isFile() || st.isSymbolicLink() || st.uid!==deps.uid || (st.mode&0o022)) throw Error("adopt_codex_marker_unsafe");
        staleStopped={path:receipt,ino:st.ino,mtimeMs:st.mtimeMs};
      }
      writeAdoptedChild(deps.workDir, alias, { adopted: true, request_id: requestId, node_id: identity.nodeId,
        nodeDir: identity.nodeDir, workdir: identity.workdir, launch_mode: "tmux",
        codex_v2: { version: 1, layout:scope.layout, socket: scope.socket, marker: scope.marker, config_hash: configHash(identity),
          start_inputs: optionalCodexStartInputs(identity, scope, requestId) } });
    } else {
    const readProc = deps.readProc ?? readAdoptionProc;
    const pid = readAdoptionPid(identity.nodeDir);
    const before = pid ? readProc(pid) : null;
    const expectedEnv = reproducibleEnvironment(identity, deps);
    const procOpts = { uid: deps.uid, home: deps.home,
      defaultTmuxSocket: expectedEnv.ANET_TMUX_SOCKET || `/tmp/tmux-${deps.uid}/default`, reproducibleEnv: expectedEnv };
    const mode = before ? verifyAdoptionProcess(identity, before, procOpts) : "tmux";
    // No await between final verification and atomic registry persistence.
    const checked = verifyAdoptionLocalIdentity(req, deps);
    if (!isDeepStrictEqual(identity, checked) || readAdoptionPid(identity.nodeDir) !== pid ||
        !isDeepStrictEqual(expectedEnv, reproducibleEnvironment(checked, deps))) throw Error("adopt_identity_changed");
    const after = pid ? readProc(pid) : null;
    if (!isDeepStrictEqual(before, after)) throw Error("adopt_process_changed");
    writeAdoptedChild(deps.workDir, alias, { adopted: true, request_id: requestId,
      node_id: identity.nodeId, nodeDir: identity.nodeDir, workdir: identity.workdir, launch_mode: mode });
    }
    registered = true;
  } catch (e: any) {
    // Do not expose filesystem paths or secrets from parser/OS error messages.
    const message = typeof e?.message === "string" && /^(adopt_|daemon_has_|copresence_|cannot_adopt_|workdir_)[a-z_]+(:[A-Z0-9_,]+)?$/.test(e.message)
      ? e.message : "adopt_local_verification_failed";
    await deps.callCommHub("ack_adopt_request", { request_id: requestId, status: "refused", error: message });
    return;
  }
  if (registered) {
    // Unknown transport outcome keeps the local evidence. It grants no authority:
    // lifecycle commands still require a current Hub binding before any action.
    try {
      const ack = await deps.callCommHub("ack_adopt_request", { request_id: requestId, status: "adopted" });
      if (!ack?.ok) {
        forgetAdoptedChild(deps.workDir, alias, requestId);
        throw new Error("adopt_ack_rejected");
      }
      const current=adoptedChild(deps.workDir,alias);
      if(current?.request_id===requestId && current.codex_v2 && staleStopped) {
        const marker=staleStopped.path;
        if(existsSync(marker)) {
          const st=lstatSync(marker);
          if(!st.isFile() || st.isSymbolicLink() || st.uid!==deps.uid || (st.mode&0o022)) throw Error("adopt_codex_marker_unsafe");
          // A stop may have completed while the adoption ack was in flight.
          // Never unlink its newly written receipt, only the pre-ack old file.
          if(st.ino===staleStopped.ino && st.mtimeMs===staleStopped.mtimeMs) unlinkSync(marker);
        }
      }
    } catch (error) {
      // callCommHub throws structured application refusals rather than returning
      // ok:false. Revoke's doorbell may already have run before our local write.
      // Only definite refusal rolls back; transport failure has unknown outcome.
      if (error instanceof CommHubError && error.appLevel) forgetAdoptedChild(deps.workDir, alias, requestId);
      throw error;
    }
  }
}
export async function handleUnadoptDoorbell(event: { request_id: string; node_id: string }, deps: AdoptDaemonDeps): Promise<void> {
  const live = await deps.callCommHub("list_my_children", {});
  if (!live?.ok || !Array.isArray(live.children)) return;
  if (live.children.some((c: any) => c.child_node_id === event.node_id && c.managed === "adopted")) return;
  for (const alias of Object.keys(readWorkdirRegistry(deps.workDir))) {
    const entry = adoptedChild(deps.workDir, alias);
    if (entry?.node_id === event.node_id) forgetAdoptedChild(deps.workDir, alias, event.request_id);
  }
}
