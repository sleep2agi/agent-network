/**
 * Process-loader hooks that must never cross the opencode-cli launcher
 * boundary. The exact agent-node package/entrypoint check happens before the
 * node profile env is merged; allowing that profile to supply one of these
 * variables would let code run before the verified entrypoint's first line.
 */
export const OPENCODE_AGENT_NODE_LOADER_ENV_KEYS = [
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_V8_COVERAGE",
  "NODE_REDIRECT_WARNINGS",
  "NODE_COMPILE_CACHE",
  "BUN_OPTIONS",
  "BUN_PRELOAD",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "LD_DEBUG_OUTPUT",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  "DYLD_FALLBACK_LIBRARY_PATH",
  "OPENSSL_CONF",
  "OPENSSL_ENGINES",
  "OPENSSL_MODULES",
] as const;

/**
 * Return a child env that preserves the launcher's original executable search
 * path and removes pre-entrypoint loader/write hooks. Other operator settings
 * (locale, proxy, custom CA, channel integration) remain backward-compatible.
 */
export function hardenOpencodeAgentNodeEnv(
  source: NodeJS.ProcessEnv,
  launcherPath: string | undefined,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  const loaderKeys = new Set(OPENCODE_AGENT_NODE_LOADER_ENV_KEYS.map((key) => key.toUpperCase()));
  // Windows treats environment names case-insensitively and Node may retain
  // the caller's original spelling. Remove every spelling so `node_options`
  // cannot survive beside a newly-written `NODE_OPTIONS`/`PATH` key.
  for (const key of Object.keys(env)) {
    const canonical = key.toUpperCase();
    if (loaderKeys.has(canonical) || canonical === "PATH") delete env[key];
  }
  if (launcherPath !== undefined) env.PATH = launcherPath;
  return env;
}
