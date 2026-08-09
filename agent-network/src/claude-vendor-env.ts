export const CLAUDE_VENDOR_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
] as const;

const SECRET_ENV_KEY_RX = /(_TOKEN|_KEY|_SECRET|AUTH)$/i;
const SECRET_ENV_VALUE_RX = /^(sk-|utok_|ntok_|atok_|ak-|gsk_|key-|Bearer\s)/i;

export type PlainSecretEnvRewrite = {
  key: string;
  refName: string;
  value: string;
};

/**
 * Plan the values that the node-create writer will move into its line-oriented
 * `.env` file. This is deliberately side-effect free: callers can run it as a
 * preflight before creating a node directory, changing process.env, or writing
 * config.json. Keeping the line-break rejection here makes it cover every
 * caller of the dotenv writer, including the no-name interactive wizard.
 */
export function planPlainSecretEnvRewrites(input: {
  env: unknown;
  nodeId: string;
}): PlainSecretEnvRewrite[] {
  if (!input.env || typeof input.env !== "object") return [];
  const nodeIdShort = input.nodeId.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 16);
  const rewrites: PlainSecretEnvRewrite[] = [];
  for (const [key, value] of Object.entries(input.env)) {
    if (typeof value !== "string") continue;
    if (!(SECRET_ENV_KEY_RX.test(key) || SECRET_ENV_VALUE_RX.test(value))) continue;
    if (/[\r\n]/.test(value)) {
      throw new Error(`${key} contains a line break and cannot be persisted safely`);
    }
    rewrites.push({
      key,
      refName: `${key}_${nodeIdShort}`.toUpperCase(),
      value,
    });
  }
  return rewrites;
}

/**
 * Persist the exact Anthropic-compatible vendor environment used by an
 * explicit claude-agent-sdk create. Explicit --env values retain precedence;
 * ambient shell values only fill missing known keys. Other environment values
 * are intentionally ignored so node create never snapshots the whole shell.
 */
export function collectClaudeVendorEnvForCreate(input: {
  runtime: string;
  explicitEnv: readonly string[];
  shellEnv: Readonly<Record<string, string | undefined>>;
}): string[] {
  const out = [...input.explicitEnv];
  for (const entry of out) {
    if (/[\r\n]/.test(entry)) {
      throw new Error("--env entries cannot contain line breaks");
    }
  }
  if (input.runtime !== "claude-agent-sdk") return out;

  const explicitKeys = new Set(
    out.map((entry) => {
      const eq = entry.indexOf("=");
      return eq > 0 ? entry.slice(0, eq) : "";
    }),
  );
  for (const key of CLAUDE_VENDOR_ENV_KEYS) {
    if (explicitKeys.has(key)) continue;
    const value = input.shellEnv[key];
    if (value === undefined || value === "") continue;
    if (/[\r\n]/.test(value)) {
      throw new Error(`${key} contains a line break and cannot be persisted safely`);
    }
    out.push(`${key}=${value}`);
  }
  return out;
}
