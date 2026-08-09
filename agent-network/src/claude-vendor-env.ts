export const CLAUDE_VENDOR_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
] as const;

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
