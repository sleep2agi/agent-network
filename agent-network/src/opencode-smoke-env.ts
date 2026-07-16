// Isolated environment for `anet opencode upgrade-pin`'s ACP protocol smoke.
// The smoke only needs the binary, locale/network trust settings, and an
// empty writable OpenCode home. It must never inherit node credentials,
// vendor keys, project config/plugin selectors, or arbitrary runtime hooks.

import { join } from "path";
import { buildOpencodeDefaultToolsPolicy } from "./opencode-preset";

const INHERITED_SMOKE_ENV_KEYS = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
] as const;

export function buildOpencodeSmokeEnv(
  parentEnv: NodeJS.ProcessEnv,
  smokeRoot: string,
  cwd = smokeRoot,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_SMOKE_ENV_KEYS) {
    const value = parentEnv[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }

  env.HOME = smokeRoot;
  env.PWD = cwd;
  env.XDG_CONFIG_HOME = join(smokeRoot, ".config");
  env.XDG_DATA_HOME = join(smokeRoot, ".local", "share");
  env.XDG_CACHE_HOME = join(smokeRoot, ".cache");
  env.XDG_STATE_HOME = join(smokeRoot, ".local", "state");
  env.XDG_RUNTIME_DIR = join(smokeRoot, ".runtime");
  env.TMPDIR = join(smokeRoot, "tmp");
  env.TMP = env.TMPDIR;
  env.TEMP = env.TMPDIR;
  env.OPENCODE_DISABLE_AUTOUPDATE = "true";
  // The smoke is a protocol probe, not an operator project session. Prevent
  // cwd ancestors from contributing config, MCP commands, instructions, or
  // executable plugins, even if the disposable directory happens to live
  // below a hostile temp ancestor.
  env.OPENCODE_DISABLE_PROJECT_CONFIG = "true";
  env.OPENCODE_PURE = "1";
  env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "1";
  env.OPENCODE_DISABLE_CLAUDE_CODE = "1";
  env.OPENCODE_DISABLE_LSP_DOWNLOAD = "1";
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    tools: buildOpencodeDefaultToolsPolicy(),
    plugin: [],
  });
  return env;
}
