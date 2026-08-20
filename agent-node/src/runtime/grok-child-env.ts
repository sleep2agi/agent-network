import { posix as posixPath, win32 as win32Path } from "path";
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

/**
 * Windows 上**运行任何子进程都必需**的系统变量。
 *
 * 🔴 这个边界刻意是精确白名单（见文件头）。但那份名单是照 POSIX 写的：
 *    没有 SystemRoot 的 Windows 子进程会直接挂死 —— 实测 grok 的
 *    `mcp doctor commhub` 从 `os error 193` 变成 **ETIMEDOUT**，
 *    正是缺这几个变量导致 MCP server 起不来。
 *    这些都是**系统路径与处理器信息，不含任何凭据**；仍逐个列出、不做通配。
 */
export const GROK_CHILD_WINDOWS_INHERITED_ENV_KEYS = [
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ComSpec",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
] as const;

export const GROK_CHILD_CONTROLLED_ENV_KEYS = [
  "HOME",
  // 🔴 Windows 用 USERPROFILE / HOMEDRIVE+HOMEPATH 解析家目录，**不看 HOME**。
  //    只设 HOME 的话隔离 home 在 Windows 上等于没设 —— 实测被
  //    assertGrokCopresenceExternalSurfaces 当场抓到：
  //      refuses external skills source C:\\Users\\<u>\\.agents\\skills\\...\\SKILL.md
  //    也就是说 grok 仍在读真实用户目录下的 skills。
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "PWD",
  "GROK_HOME",
  "GROK_AUTH_PATH",
  "GROK_OIDC_ISSUER",
  "GROK_OIDC_CLIENT_ID",
  // 🔴 2026-08-20：grok 1.0.5 把跨厂商发现扩成 13 个 compat cell，**默认全 true**
  //    （cursor/claude 各 skills/rules/agents/mcps/hooks/sessions，codex 只有 sessions）。
  //    0.2.93 时代只关了 MCPS/HOOKS 四个 —— 在 1.0.5 上那留下 9 个洞。
  //    实测（本机 grok 1.0.5 (5115b46bc9)，隔离 HOME，`grok inspect --json` 读
  //    externalCompat.cells）：
  //      不设            ⇒ enabled=13/13
  //      只设原来那 4 个  ⇒ enabled=9/13
  //      设下面这 13 个   ⇒ enabled=0/13
  //    命名规律是 GROK_<VENDOR>_<SURFACE>_ENABLED，**文档只列了 4 个但 13 个都生效**。
  //    ⚠️ 试过 GROK_CONFIG 内联 JSON overlay 关整张矩阵 ⇒ **无效，仍是 13/13**，
  //       所以这里必须逐个列，不能靠一个 overlay。
  "GROK_CLAUDE_SKILLS_ENABLED",
  "GROK_CURSOR_SKILLS_ENABLED",
  "GROK_CLAUDE_RULES_ENABLED",
  "GROK_CURSOR_RULES_ENABLED",
  "GROK_CLAUDE_AGENTS_ENABLED",
  "GROK_CURSOR_AGENTS_ENABLED",
  "GROK_CLAUDE_MCPS_ENABLED",
  "GROK_CURSOR_MCPS_ENABLED",
  "GROK_CLAUDE_HOOKS_ENABLED",
  "GROK_CURSOR_HOOKS_ENABLED",
  "GROK_CLAUDE_SESSIONS_ENABLED",
  "GROK_CURSOR_SESSIONS_ENABLED",
  "GROK_CODEX_SESSIONS_ENABLED",
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
  ...GROK_CHILD_WINDOWS_INHERITED_ENV_KEYS,
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
  defaultSelectedPermission?: "allow_once" | "always_allow_all_sessions";
  /** 注入平台以便在 Linux CI 上覆盖 Windows 分支。缺省取 process.platform。 */
  platform?: NodeJS.Platform;
}

/** Construct a Grok child environment from an empty object. */
export function buildGrokChildEnv(opts: BuildGrokChildEnvOptions): NodeJS.ProcessEnv {
  // 🔴 原来写的是 `startsWith("/")` —— POSIX-only 的绝对路径判据，
  //    Windows 的 `D:\\x` 不满足它，一个完全合法的 cwd 会被判成"不是绝对路径"。
  //    而 `path.isAbsolute` 也不够：它按【当前运行平台】判，
  //    于是在 Linux CI 上给它一个 Windows 路径会答 false ——
  //    这一条是被本文件的测试红出来的，不是想出来的。
  //    ⇒ 显式按目标平台选约定，判据自己说清它在用哪一套。
  const targetPlatform = opts.platform ?? process.platform;
  const isAbsoluteForTarget = targetPlatform === "win32"
    ? win32Path.isAbsolute
    : posixPath.isAbsolute;
  if (!opts.cwd || opts.cwd.includes("\0") || !isAbsoluteForTarget(opts.cwd)) {
    throw new Error("Grok child environment requires an absolute cwd");
  }
  const env: NodeJS.ProcessEnv = {};
  const inherited = targetPlatform === "win32"
    ? [...GROK_CHILD_INHERITED_ENV_KEYS, ...GROK_CHILD_WINDOWS_INHERITED_ENV_KEYS]
    : GROK_CHILD_INHERITED_ENV_KEYS;
  for (const key of inherited) {
    const value = opts.parentEnv[key];
    if (value !== undefined && value !== "") env[key] = value;
  }

  env.HOME = opts.home;
  if (targetPlatform === "win32") {
    // 三个都要设：Node 的 os.homedir() 在 Windows 上依次看 USERPROFILE、
    // 然后 HOMEDRIVE+HOMEPATH；漏掉任何一个都会让隔离在某条路径上失效。
    env.USERPROFILE = opts.home;
    const drive = opts.home.length >= 2 && opts.home[1] === ":" ? opts.home.slice(0, 2) : "";
    if (drive) {
      env.HOMEDRIVE = drive;
      env.HOMEPATH = opts.home.slice(2) || "\\";
    }
  }
  // dash exports PWD when the headless launcher enters /bin/sh. Seed the
  // exact expected value so that wrapper behavior cannot silently widen the
  // final child environment.
  env.PWD = opts.cwd;
  env.GROK_HOME = opts.home;
  env.GROK_AUTH_PATH = opts.authPath;
  // 关死整张 compat 矩阵（13 格）。解析顺序是 env > config.toml > 默认 on，
  // 所以 env 是运行时唯一不依赖磁盘状态的杠杆。
  for (const vendor of ["CLAUDE", "CURSOR"] as const) {
    for (const surface of ["SKILLS", "RULES", "AGENTS", "MCPS", "HOOKS", "SESSIONS"] as const) {
      env[`GROK_${vendor}_${surface}_ENABLED`] = "false";
    }
  }
  env.GROK_CODEX_SESSIONS_ENABLED = "false";
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
export function buildGrokHelperEnv(
  parentEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (platform === "win32") {
    for (const key of GROK_CHILD_WINDOWS_INHERITED_ENV_KEYS) {
      const value = parentEnv[key];
      if (value !== undefined && value !== "") env[key] = value;
    }
  }
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
