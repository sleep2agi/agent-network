const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// These values define the node/session identity or are launcher-owned. A
// config.env entry must not replace them while we are fixing the independent
// problem of carrying provider credentials into the three co-presence stages.
const LAUNCHER_ENV = new Set([
  "ANET_CODEX_COMMHUB_TOKEN",
  "ANET_CODEX_PAIRED_AGENT_NODE",
  "ANET_CODEX_RECOVERY_MAX_PAYLOAD_BYTES",
  "ANET_CODEX_RESUME_TIMEOUT_MS",
  "ANET_CODEX_TUI_SESSION",
  "ANET_COPRESENCE_BRIDGE",
  "ANET_NODE_MARKER",
  "CODEX_HOME",
  "COMMHUB_ALIAS",
  "COMMHUB_AUTH_TOKEN",
  "COMMHUB_NODE_ID",
  "COMMHUB_TOKEN",
  "COMMHUB_URL",
]);

/** Merge user config.env into one co-presence stage. Required launcher values
 * always win. Invalid shell names/NULs fail closed before a tmux session starts. */
export function codexCopresenceStageEnv(
  configEnv: Readonly<Record<string, string>>,
  required: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(configEnv)) {
    if (!ENV_NAME.test(key)) throw new Error(`invalid config.env key for Codex co-presence: ${JSON.stringify(key)}`);
    if (value.includes("\0")) throw new Error(`config.env.${key} contains NUL`);
    const canonical = key.toUpperCase();
    if (isReservedEnvKey(canonical)) throw new Error(`config.env.${key} is reserved and cannot enter Codex co-presence`);
    if (!LAUNCHER_ENV.has(canonical)) out[key] = value;
  }
  for (const [key, value] of Object.entries(required)) {
    if (!ENV_NAME.test(key) || value.includes("\0")) throw new Error(`invalid launcher environment for ${key}`);
    out[key] = value;
  }
  return out;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** Contents for a private source-then-delete file. Values never enter argv. */
export function codexCopresenceEnvFileText(env: Readonly<Record<string, string>>): string {
  return Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join("\n") + "\n";
}
import { isReservedEnvKey } from "./shared/reserved-env";
