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

export const GROK_PTY_CONTROLLED_ENV_KEYS = ["PWD", "TERM"] as const;

const GROK_CHILD_ENV_KEYS = new Set<string>([
  ...GROK_CHILD_INHERITED_ENV_KEYS,
  ...GROK_CHILD_CONTROLLED_ENV_KEYS,
]);

export interface BuildGrokChildEnvOptions {
  /** Read only the exact inherited-key list above; every other key is ignored. */
  parentEnv: NodeJS.ProcessEnv;
  home: string;
  authPath: string;
  oidcIssuer?: string;
  oidcClientId?: string;
  expectedParentPid?: number;
  defaultSelectedPermission?: "allow_once";
}

/** Construct a Grok child environment from an empty object. */
export function buildGrokChildEnv(opts: BuildGrokChildEnvOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of GROK_CHILD_INHERITED_ENV_KEYS) {
    const value = opts.parentEnv[key];
    if (value !== undefined && value !== "") env[key] = value;
  }

  env.HOME = opts.home;
  env.GROK_HOME = opts.home;
  env.GROK_AUTH_PATH = opts.authPath;
  env.GROK_CLAUDE_MCPS_ENABLED = "false";
  env.GROK_CURSOR_MCPS_ENABLED = "false";
  env.GROK_CLAUDE_HOOKS_ENABLED = "false";
  env.GROK_CURSOR_HOOKS_ENABLED = "false";
  env.GROK_FOLDER_TRUST = "1";
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
 * Final environment handed to node-pty. node-pty itself materializes PWD and
 * TERM; set both explicitly so the actual TUI child environment remains a
 * reviewed exact set instead of relying on undocumented implicit additions.
 */
export function buildGrokPtyEnv(
  candidate: NodeJS.ProcessEnv,
  expectedEnv: NodeJS.ProcessEnv,
  cwd: string,
  terminalName = "xterm-256color",
): Record<string, string> {
  if (!cwd || cwd.includes("\0") || !terminalName || terminalName.includes("\0")) {
    throw new Error("Grok PTY environment requires a valid cwd and terminal name");
  }
  const env = projectGrokChildEnv(candidate, expectedEnv);
  env.PWD = cwd;
  env.TERM = terminalName;
  return env;
}
