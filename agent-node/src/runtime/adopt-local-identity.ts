// Board #626: read-only local evidence. No signaling, spawn or config writes.
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { assertWorkdirAllowed } from "./child-workdir.js";

export interface AdoptionIdentityRequest {
  node_id: string;
  alias: string;
  network_id: string;
  workdir: string;
}
export interface AdoptionIdentityOptions {
  home: string;
  hubUrl: string;
  /** Operator-declared other URLs of the SAME Hub (daemon config `hub_aliases`), e.g. the plain
   *  http :9300 port that hand-started nodes on a host still use while the daemon itself must use
   *  https (the source-fork worker refuses non-loopback http). Never inferred: a node is accepted
   *  only on the daemon's own URL or one its operator listed. Invalid entries are ignored. */
  hubAliases?: readonly unknown[];
  /** Locate the identity without the Hub URL check. ONLY for proveSameHubByToken's lookup. */
  ignoreHub?: boolean;
  networkId: string;
  adoptRoots: readonly string[];
  uid: number;
  daemonEnv: NodeJS.ProcessEnv;
  allowCodexV2?: boolean;
  /** Opt-in: OpenCode V2 co-presence (TUI + bridge + shared serve). Registration only; see adopt-opencode-v2.ts. */
  allowOpenCodeV2?: boolean;
}
export interface AdoptionLocalIdentity {
  workdir: string;
  nodeDir: string;
  configPath: string;
  nodeId: string;
  alias: string;
  config: Record<string, unknown>;
}
const refuse = (code: string): never => { throw new Error(code); };
function under(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
// stickyWorkdir: ONLY the workdir itself may be group/other-writable, and only with the sticky
// bit (S_ISVTX) on a daemon-owned directory, so others can't rename/delete its .anet (#747).
function secure(path: string, uid: number, directory: boolean, stickyWorkdir = false): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink() || (directory ? !st.isDirectory() : !st.isFile())) refuse("adopt_path_not_regular");
  if (st.uid !== uid) refuse("adopt_path_owner_mismatch");
  if ((st.mode & 0o022) && !(stickyWorkdir && directory && (st.mode & 0o1000))) refuse("adopt_path_writable_by_others");
}
function canonicalHub(raw: unknown): string {
  if (typeof raw !== "string") return refuse("adopt_hub_missing");
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) refuse("adopt_hub_invalid");
  return url.href.replace(/\/$/, "");
}

function acceptedHubs(opts: Pick<AdoptionIdentityOptions, "hubUrl" | "hubAliases">): Set<string> {
  const accepted = new Set([canonicalHub(opts.hubUrl)]);
  for (const alias of opts.hubAliases ?? []) {
    try { if (typeof alias === "string") accepted.add(canonicalHub(alias)); } catch { /* invalid alias: ignore */ }
  }
  return accepted;
}

export function verifyAdoptionLocalIdentity(req: AdoptionIdentityRequest, opts: AdoptionIdentityOptions): AdoptionLocalIdentity {
  if (opts.daemonEnv.ANET_NODE_MARKER !== undefined) refuse("daemon_has_node_marker");
  if (!opts.adoptRoots.length) refuse("adopt_roots_not_configured");
  if (!req.alias || /[\x00-\x1f\x7f/\\]/.test(req.alias) || req.alias === "." || req.alias === ".." || req.alias.startsWith("-")) refuse("adopt_alias_invalid");
  if (!req.node_id || !req.network_id || req.network_id !== opts.networkId) refuse("adopt_network_mismatch");
  if (!isAbsolute(req.workdir)) refuse("adopt_workdir_not_absolute");
  const workdir = realpathSync(req.workdir);
  const home = realpathSync(opts.home);
  assertWorkdirAllowed(workdir, { home });
  if (!opts.adoptRoots.some(root => isAbsolute(root) && under(workdir, realpathSync(root)))) refuse("adopt_workdir_outside_roots");
  secure(workdir, opts.uid, true, true);
  const anet = join(workdir, ".anet");
  const nodes = join(anet, "nodes");
  secure(anet, opts.uid, true);
  secure(nodes, opts.uid, true);
  const matches: AdoptionLocalIdentity[] = [];
  for (const entry of readdirSync(nodes)) {
    const nodeDir = join(nodes, entry);
    const configPath = join(nodeDir, "config.json");
    // Other nodes can have incomplete directories. Never follow their symlinks.
    if (lstatSync(nodeDir).isSymbolicLink() || !lstatSync(nodeDir).isDirectory()) continue;
    let config: any;
    try {
      if (lstatSync(configPath).isSymbolicLink()) continue;
      config = JSON.parse(readFileSync(configPath, "utf8"));
    } catch { continue; }
    if (config?.node_id !== req.node_id) continue;
    secure(nodeDir, opts.uid, true);
    secure(configPath, opts.uid, false);
    if (!config || typeof config !== "object" || Array.isArray(config)) refuse("adopt_config_invalid");
    const names = [config.alias, config.node_name].filter(v => v !== undefined);
    if (!names.length || names.some(v => v !== req.alias)) refuse("adopt_alias_mismatch");
    if (config.role === "host_supervisor") refuse("cannot_adopt_daemon");
    if (config.network_id !== req.network_id) refuse("adopt_config_network_mismatch");
    if (opts.ignoreHub) canonicalHub(config.hub);
    else if (!acceptedHubs(opts).has(canonicalHub(config.hub))) refuse("adopt_hub_mismatch");
    const openCodeV2 = config.opencodeMode === "copresence" && config.runtime === "opencode-cli" && config.opencodeGeneration === "v2";
    if (config.grokCopresence || config.grokCopresenceAuto ||
        (config.opencodeMode === "copresence" && !(opts.allowOpenCodeV2 && openCodeV2)) ||
        (config.codexCopresence && !(opts.allowCodexV2 && config.runtime === "codex-app-server"))) refuse("copresence_adopt_v2");
    matches.push({ workdir, nodeDir, configPath, nodeId: req.node_id, alias: req.alias, config });
  }
  if (matches.length !== 1) refuse(matches.length ? "adopt_identity_ambiguous" : "adopt_identity_not_found");
  return matches[0];
}

export interface AdoptionProcessEvidence {
  argv: readonly string[];
  env: Record<string, string>;
  uid: number;
  cwd: string;
}
// Process evidence must be captured and rechecked by the caller immediately before
// registry persistence. Values never appear in errors (env names only).
export function verifyAdoptionProcess(
  identity: AdoptionLocalIdentity,
  evidence: AdoptionProcessEvidence,
  opts: { uid: number; home: string; defaultTmuxSocket: string; reproducibleEnv: Record<string, string | undefined> },
): "bare" | "tmux" {
  if (evidence.uid !== opts.uid || evidence.cwd !== identity.workdir) refuse("adopt_process_identity_mismatch");
  const args = evidence.argv;
  const aliasAt = args.indexOf("--alias");
  const configAt = args.indexOf("--config");
  if (aliasAt < 0 || args[aliasAt + 1] !== identity.alias || args.filter(v => v === "--alias").length !== 1 ||
      configAt < 0 || args[configAt + 1] !== identity.configPath || args.filter(v => v === "--config").length !== 1 ||
      !args.some(v => v === "agent-node" || v.endsWith("/agent-node") || /\/agent-node\/dist\/cli\.js$/.test(v))) refuse("adopt_process_argv_mismatch");
  if (evidence.env.HOME !== opts.home) refuse("adopt_process_home_mismatch");
  if (evidence.env.ANET_NODE_MARKER !== undefined) refuse("copresence_adopt_v2");
  const tmux = evidence.env.TMUX;
  if (tmux && tmux.split(",")[0] !== opts.defaultTmuxSocket) refuse("adopt_tmux_socket_mismatch");
  const launcherKeys = new Set(["TMUX", "TMUX_PANE", "SHLVL", "_", "PWD", "OLDPWD"]);
  const missing = Object.keys(evidence.env).filter(key => !launcherKeys.has(key) && evidence.env[key] !== opts.reproducibleEnv[key]);
  if (missing.length) refuse(`adopt_env_not_reproducible:${missing.sort().join(",")}`);
  return tmux ? "tmux" : "bare";
}

/** A Hub URL the node's own config uses that was PROVEN to reach the daemon's Hub at adoption
 *  (see proveSameHubByToken) is accepted for this adopted child from then on. */
export function withProvenHub<T extends Pick<AdoptionIdentityOptions, "hubAliases">>(deps: T, entry: { proven_hub?: unknown } | null | undefined): T {
  return typeof entry?.proven_hub === "string" ? { ...deps, hubAliases: [...(deps.hubAliases ?? []), entry.proven_hub] } : deps;
}

/**
 * admin 2026-11-10: "本来就是同一个，别用链接判断是不是同一个". The same Hub is often reachable at
 * more than one URL (the daemon must use https for source fork; hand-started nodes on the same box
 * use http :9300). URL text cannot tell; the Hub can. Present the node's own credential to the
 * DAEMON's Hub: only if that Hub accepts it as exactly this node (same network, same alias) is the
 * node's URL the same Hub. A different Hub would reject the token. The token never leaves for any
 * URL other than the daemon's own Hub.
 */
export async function proveSameHubByToken(
  identity: AdoptionLocalIdentity, req: AdoptionIdentityRequest, hubUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const token = identity.config?.token;
  if (typeof token !== "string" || !token) refuse("adopt_hub_mismatch");
  let body: any;
  try {
    const res = await fetchImpl(`${canonicalHub(hubUrl)}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) refuse("adopt_hub_mismatch");
    body = await res.json();
  } catch (e: any) {
    if (e?.message === "adopt_hub_mismatch") throw e;
    refuse("adopt_hub_unverifiable");
  }
  const c = body?.credential;
  if (body?.ok !== true || c?.kind !== "node" || c.network_id !== req.network_id || c.node_alias !== req.alias) refuse("adopt_hub_mismatch");
  return String(identity.config.hub);
}
