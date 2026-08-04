import { createHash } from "crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from "fs";
import { isAbsolute, join } from "path";

export const GROK_UNIX_SOCKET_PATH_MAX_BYTES = 100;
// V2 means the child uses the runtime-owned fixed no-I/O profile. V1 previews
// used TUI-ignored --tools flags and must never shadow this package via a
// pre-existing global agent-node installation.
export const GROK_COPRESENCE_CAPABILITY_MARKER = "ANET_CAPABILITY_GROK_COPRESENCE_V2";
export const GROK_PREVIEW_RESOLVER_INHERITED_ENV_KEYS = [
  "PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
] as const;
export const GROK_AGENT_NODE_INHERITED_ENV_KEYS = [
  "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
  "SHELL", "USER", "LOGNAME", "TERM", "COLORTERM", "NO_COLOR",
] as const;
export const GROK_AGENT_NODE_OPTIONAL_ENV_KEYS = [
  "GROK_BINARY", "GROK_HOME", "FLOCK_BINARY", "SETPRIV_BINARY", "UNSHARE_BINARY",
  "GROK_CLI_TIMEOUT_MS", "GROK_HANDSHAKE_TIMEOUT_MS", "LOG_LEVEL",
  "ANET_GOAL_TICK_MS", "COMMHUB_MAX_GOALS_PER_NODE",
] as const;

/** Exact environment for the long-lived agent-node parent of the Grok TUI. */
export function buildGrokAgentNodeEnv(parentEnv: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [
    ...GROK_AGENT_NODE_INHERITED_ENV_KEYS,
    ...GROK_AGENT_NODE_OPTIONAL_ENV_KEYS,
  ]) {
    const value = parentEnv[key];
    if (value !== undefined && value !== "") env[key] = value;
  }
  if (!env.PATH) env.PATH = "/usr/local/bin:/usr/bin:/bin";
  if (!env.HOME || !isAbsolute(env.HOME) || env.HOME.includes("\0")) {
    throw new Error("Grok preview agent-node requires an absolute HOME");
  }
  env.ANET_CONFIG_UPDATE_CAPABLE = "1";
  return env;
}

export function grokPreviewResolverConfigPaths(home: string): {
  directory: string;
  userConfig: string;
  globalConfig: string;
} {
  if (!isAbsolute(home) || home.includes("\0")) {
    throw new Error("Grok preview resolver requires an absolute HOME");
  }
  const directory = join(home, ".anet", "npm-resolver");
  return {
    directory,
    userConfig: join(directory, "user.npmrc"),
    globalConfig: join(directory, "global.npmrc"),
  };
}

/**
 * npm rejects loading the same file as both user and global config. Prepare
 * two distinct, empty, owner-only files without following a final symlink so
 * the resolver cannot inherit a user's ordinary npmrc credentials.
 */
export function prepareGrokPreviewResolverConfigs(home: string): void {
  const paths = grokPreviewResolverConfigPaths(home);
  mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  const directoryStat = lstatSync(paths.directory);
  const uid = process.getuid?.();
  if (
    directoryStat.isSymbolicLink()
    || !directoryStat.isDirectory()
    || realpathSync(paths.directory) !== paths.directory
    || (uid !== undefined && directoryStat.uid !== uid)
  ) {
    throw new Error("Grok preview resolver config directory is not owner-controlled");
  }
  chmodSync(paths.directory, 0o700);

  for (const path of [paths.userConfig, paths.globalConfig]) {
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || (uid !== undefined && stat.uid !== uid)) {
        throw new Error("Grok preview resolver config file is not owner-controlled");
      }
      ftruncateSync(fd, 0);
      fchmodSync(fd, 0o600);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}

/** Exact environment for the short-lived npm resolver and capability probe. */
export function buildGrokPreviewResolverEnv(
  parentEnv: NodeJS.ProcessEnv,
  home: string,
): Record<string, string> {
  if (!isAbsolute(home) || home.includes("\0")) {
    throw new Error("Grok preview resolver requires an absolute HOME");
  }
  const env: Record<string, string> = {};
  for (const key of GROK_PREVIEW_RESOLVER_INHERITED_ENV_KEYS) {
    const value = parentEnv[key];
    if (value !== undefined && value !== "") env[key] = value;
  }
  if (!env.PATH) env.PATH = "/usr/local/bin:/usr/bin:/bin";
  env.HOME = home;

  const rawRegistry = parentEnv.npm_config_registry || "https://registry.npmjs.org";
  let registry: URL;
  try {
    registry = new URL(rawRegistry);
  } catch {
    throw new Error("Grok preview resolver received an invalid npm registry URL");
  }
  const loopback = registry.hostname === "127.0.0.1"
    || registry.hostname === "localhost"
    || registry.hostname === "::1";
  if (
    registry.username
    || registry.password
    || registry.hash
    || registry.search
    || (registry.protocol !== "https:" && !(registry.protocol === "http:" && loopback))
  ) {
    throw new Error("Grok preview resolver refuses a credential-bearing or insecure npm registry URL");
  }
  env.npm_config_registry = registry.toString();
  env.npm_config_cache = join(home, ".npm");
  const resolverConfigs = grokPreviewResolverConfigPaths(home);
  env.npm_config_userconfig = resolverConfigs.userConfig;
  env.npm_config_globalconfig = resolverConfigs.globalConfig;
  env.npm_config_audit = "false";
  env.npm_config_fund = "false";
  env.npm_config_update_notifier = "false";
  return env;
}

/** Old headless-only agent-node builds already advertised grok-build-cli. */
export function agentNodeHelpSupportsGrokCopresence(help: string): boolean {
  return help.includes("grok-build-cli") && help.includes(GROK_COPRESENCE_CAPABILITY_MARKER);
}

export interface GrokCopresenceProfileFields {
  grokCopresence: boolean;
  grokLeaderSocket?: string;
  grokAttachSocket?: string;
}

export interface GrokSocketPathOptions {
  cwd?: string;
  home?: string;
  xdgRuntimeDir?: string;
  uid?: number;
  platform?: NodeJS.Platform;
}

/**
 * Allocate deterministic Unix socket paths without creating anything.
 *
 * Grok's workspace sandbox does not admit an otherwise owner-controlled
 * XDG_RUNTIME_DIR such as /run/user/<uid>. Keep the primary sockets under the
 * node's owner-bound state home, which the runtime already admits, and use a
 * short private tmp path only when the Unix socket length limit requires it.
 * The runtime owns directory creation and permissions; `anet node create`
 * only persists the identity of the two sockets.
 */
export function grokCopresenceSocketPaths(
  nodeId: string,
  options: GrokSocketPathOptions = {},
): { leaderSocket: string; attachSocket: string } {
  const home = options.home ?? process.env.HOME ?? process.env.USERPROFILE ?? "~";
  const uid = options.uid ?? process.getuid?.();
  const platform = options.platform ?? process.platform;
  const nodeHash = createHash("sha256").update(nodeId).digest("hex");
  const stateKey = `node-${nodeHash.slice(0, 24)}`;

  if (isAbsolute(home) && !home.includes("\0")) {
    const runtimeDir = join(home, ".anet-grok", stateKey, "run");
    const leaderSocket = join(runtimeDir, "leader.sock");
    const attachSocket = join(runtimeDir, "attach.sock");
    if (
      Buffer.byteLength(leaderSocket) <= GROK_UNIX_SOCKET_PATH_MAX_BYTES
      && Buffer.byteLength(attachSocket) <= GROK_UNIX_SOCKET_PATH_MAX_BYTES
    ) {
      return { leaderSocket, attachSocket };
    }
  }

  const privateTmp = platform === "darwin" ? "/private/tmp" : "/tmp";
  const ownerKey = uid === undefined
    ? createHash("sha256").update(home).digest("hex").slice(0, 8)
    : String(uid);
  const runtimeDir = join(privateTmp, `anet-u${ownerKey}`, "g", nodeHash.slice(0, 16));
  const leaderSocket = join(runtimeDir, "l.sock");
  const attachSocket = join(runtimeDir, "a.sock");
  if (
    Buffer.byteLength(leaderSocket) <= GROK_UNIX_SOCKET_PATH_MAX_BYTES
    && Buffer.byteLength(attachSocket) <= GROK_UNIX_SOCKET_PATH_MAX_BYTES
  ) {
    return { leaderSocket, attachSocket };
  }

  throw new Error("cannot allocate a Grok copresence socket path shorter than 100 bytes");
}

export function grokBuildCliCreationFields(
  runtime: string,
  nodeId: string,
  headless = false,
  options: GrokSocketPathOptions = {},
): GrokCopresenceProfileFields | Record<string, never> {
  if (runtime !== "grok-build-cli") return {};
  // Persist the opt-out. A stale ANET_GROK_COPRESENCE=1 in the operator's
  // shell must not silently turn a documented headless node into the shared
  // TUI lane without anet's danger warning.
  if (headless) return { grokCopresence: false };
  const paths = grokCopresenceSocketPaths(nodeId, options);
  return {
    grokCopresence: true,
    grokLeaderSocket: paths.leaderSocket,
    grokAttachSocket: paths.attachSocket,
  };
}
