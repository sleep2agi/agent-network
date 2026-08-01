/**
 * Environment boundary for every Grok CLI process.
 *
 * This is deliberately an exact allowlist built from an empty object.  The
 * agent-node parent commonly carries CommHub credentials and unrelated cloud
 * provider credentials; copying process.env and deleting known names is not a
 * safe boundary.  Additions to either list below require a focused review and
 * a set-equality test update.
 */
export const GROK_CHILD_INHERITED_ENV_KEYS = [
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "SHELL",
  "USER",
  "LOGNAME",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
] as const;

export const GROK_CHILD_CONTROLLED_ENV_KEYS = [
  "HOME",
  "PWD",
  "GROK_HOME",
  "GROK_AUTH_PATH",
  "GROK_OIDC_ISSUER",
  "GROK_OIDC_CLIENT_ID",
  "GROK_CLAUDE_MCPS_ENABLED",
  "GROK_CURSOR_MCPS_ENABLED",
  "GROK_CLAUDE_HOOKS_ENABLED",
  "GROK_CURSOR_HOOKS_ENABLED",
  "GROK_FOLDER_TRUST",
  "GROK_DEFAULT_SELECTED_PERMISSION",
  "GROK_DISABLE_AUTOUPDATER",
  "GROK_CHANGELOG_OFFLINE",
  "GROK_LEADER_LOG",
  "GROK_SUBAGENTS",
  "GROK_WEB_FETCH",
  "GROK_MEMORY",
  "ANET_EXPECTED_PARENT_PID",
] as const;

/**
 * Environment inherited by non-Grok helper processes such as the flock
 * holders. These processes do not need HOME, terminal state, Grok config, or
 * node identity. Keep this narrower than the interactive Grok child boundary.
 */
export const GROK_HELPER_INHERITED_ENV_KEYS = [
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
] as const;

export const GROK_PTY_CONTROLLED_ENV_KEYS = [
  "TERM",
  "GROK_SANDBOX",
  "ANET_GROK_LEADER_OWNER",
] as const;

const GROK_CHILD_ENV_KEYS = new Set<string>([
  ...GROK_CHILD_INHERITED_ENV_KEYS,
  ...GROK_CHILD_CONTROLLED_ENV_KEYS,
]);

export interface BuildGrokChildEnvOptions {
  /** Read only the exact inherited-key list above; every other key is ignored. */
  parentEnv: NodeJS.ProcessEnv;
  cwd: string;
  home: string;
  authPath: string;
  oidcIssuer?: string;
  oidcClientId?: string;
  expectedParentPid?: number;
  defaultSelectedPermission?: "allow_once";
}

/** Construct a Grok child environment from an empty object. */
export function buildGrokChildEnv(opts: BuildGrokChildEnvOptions): NodeJS.ProcessEnv {
  if (!opts.cwd || opts.cwd.includes("\0") || !opts.cwd.startsWith("/")) {
    throw new Error("Grok child environment requires an absolute cwd");
  }
  const env: NodeJS.ProcessEnv = {};
  for (const key of GROK_CHILD_INHERITED_ENV_KEYS) {
    const value = opts.parentEnv[key];
    if (value !== undefined && value !== "") env[key] = value;
  }

  env.HOME = opts.home;
  // dash exports PWD when the headless launcher enters /bin/sh. Seed the
  // exact expected value so that wrapper behavior cannot silently widen the
  // final child environment.
  env.PWD = opts.cwd;
  env.GROK_HOME = opts.home;
  env.GROK_AUTH_PATH = opts.authPath;
  env.GROK_CLAUDE_MCPS_ENABLED = "false";
  env.GROK_CURSOR_MCPS_ENABLED = "false";
  env.GROK_CLAUDE_HOOKS_ENABLED = "false";
  env.GROK_CURSOR_HOOKS_ENABLED = "false";
  env.GROK_FOLDER_TRUST = "1";
  // The preview pins one audited binary and one fixed no-I/O agent profile.
  // Keep the same posture across every preflight, Leader and recovery spawn.
  env.GROK_DISABLE_AUTOUPDATER = "1";
  // Authenticated 0.2.93 sessions can otherwise fetch and persist a remote
  // changelog cache. Keep the isolated preview on its pinned embedded bundle.
  env.GROK_CHANGELOG_OFFLINE = "1";
  // In pinned Grok 0.2.93 this is a tracing-filter value, not a destination
  // path. The exact `off` directive keeps the unavoidable leader.log empty;
  // values such as `/dev/null` instead enable the persistent stderr log.
  env.GROK_LEADER_LOG = "off";
  env.GROK_SUBAGENTS = "0";
  env.GROK_WEB_FETCH = "0";
  env.GROK_MEMORY = "0";
  if (opts.oidcIssuer) env.GROK_OIDC_ISSUER = opts.oidcIssuer;
  if (opts.oidcClientId) env.GROK_OIDC_CLIENT_ID = opts.oidcClientId;
  if (opts.expectedParentPid !== undefined) {
    if (!Number.isSafeInteger(opts.expectedParentPid) || opts.expectedParentPid <= 0) {
      throw new Error("Grok child expected parent PID must be a positive safe integer");
    }
    env.ANET_EXPECTED_PARENT_PID = String(opts.expectedParentPid);
  }
  if (opts.defaultSelectedPermission) {
    env.GROK_DEFAULT_SELECTED_PERMISSION = opts.defaultSelectedPermission;
  }
  return env;
}

/** Construct a helper-process environment from an empty object. */
export function buildGrokHelperEnv(parentEnv: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of GROK_HELPER_INHERITED_ENV_KEYS) {
    const value = parentEnv[key];
    if (value !== undefined && value !== "") env[key] = value;
  }
  // A bare command name is used for the Node executable under Bun. Supplying
  // a fixed fallback is safer than consulting the ambient parent environment.
  if (!env.PATH) env.PATH = "/usr/local/bin:/usr/bin:/bin";
  return env;
}

/**
 * Re-project a prepared environment at the final spawn boundary.
 *
 * beforeSpawn is intentionally untrusted here: a callback regression cannot
 * add a new parent credential to the PTY or headless worker environment.
 */
export function projectGrokChildEnv(
  candidate: NodeJS.ProcessEnv,
  expectedEnv?: NodeJS.ProcessEnv,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (!GROK_CHILD_ENV_KEYS.has(key) || value === undefined) continue;
    env[key] = value;
  }
  // Keep direct API callers functional without falling back to process.env.
  // Both supported Grok CLI lanes are Linux-only today.
  if (!env.PATH) env.PATH = "/usr/local/bin:/usr/bin:/bin";
  if (expectedEnv) {
    const expected = projectGrokChildEnv(expectedEnv);
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(env)])].sort();
    for (const key of keys) {
      if (env[key] !== expected[key]) {
        throw new Error(`Grok child environment changed at final spawn boundary: ${key}`);
      }
    }
  }
  return env;
}

/**
 * Final environment handed to node-pty. PWD is already fixed in the common
 * child set because the headless shell exports it. TERM and the reviewed
 * sandbox profile are added here; the latter is required so the auto-spawned
 * shared Leader inherits the same profile as the TUI argv. The cwd equality
 * check prevents the PTY lane from silently changing PWD.
 */
export function buildGrokPtyEnv(
  candidate: NodeJS.ProcessEnv,
  expectedEnv: NodeJS.ProcessEnv,
  cwd: string,
  terminalName = "xterm-256color",
  sandboxProfile: string,
  leaderOwner: string,
): Record<string, string> {
  if (
    !cwd
    || cwd.includes("\0")
    || !terminalName
    || terminalName.includes("\0")
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sandboxProfile)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(leaderOwner)
  ) {
    throw new Error("Grok PTY environment requires a valid cwd, terminal name, sandbox profile, and Leader owner");
  }
  const env = projectGrokChildEnv(candidate, expectedEnv);
  if (env.PWD !== cwd) {
    throw new Error("Grok PTY cwd differs from the reviewed child environment");
  }
  env.TERM = terminalName;
  // Grok 0.2.93 auto-spawns the shared Leader from the interactive client,
  // but does not forward the client's --sandbox argv to that child. The
  // documented environment form is inherited by the Leader and is therefore
  // required in addition to the same explicit argv value. This is a reviewed
  // runtime value, never inherited from the parent environment.
  env.GROK_SANDBOX = sandboxProfile;
  // This non-secret, per-spawn generation marker is inherited by Grok's
  // auto-spawned Leader. It lets lifecycle cleanup bind the listener process
  // to the exact TUI generation instead of trusting a reusable numeric PID.
  env.ANET_GROK_LEADER_OWNER = leaderOwner;
  return env;
}
