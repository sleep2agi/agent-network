export const GROK_COPRESENCE_PROFILE_ENV = "ANET_INTERNAL_GROK_COPRESENCE_PROFILE";

export type GrokCopresenceCapabilityProfile = "commhub-only" | "x-search";

/**
 * Resolve once while agent-node boots. Co-presence deliberately does not
 * accept a general tool allowlist: the only opt-in is the reviewed WebSearch
 * profile, represented by the CLI's canonical Claude-style tool name.
 */
export function selectGrokCopresenceCapabilityProfile(
  tools: readonly string[] | undefined,
): GrokCopresenceCapabilityProfile {
  if (tools === undefined || tools.length === 0) return "commhub-only";
  if (tools.length === 1 && tools[0] === "WebSearch") return "x-search";
  throw new Error(
    'grok copresence supports only the exact tools profile ["WebSearch"] or an omitted tools field',
  );
}

/** Read only by modules loaded after cli.ts has pinned the process profile. */
export function readPinnedGrokCopresenceCapabilityProfile(
  env: NodeJS.ProcessEnv = process.env,
): GrokCopresenceCapabilityProfile {
  const value = env[GROK_COPRESENCE_PROFILE_ENV];
  if (value === undefined || value === "") return "commhub-only";
  if (value === "commhub-only" || value === "x-search") return value;
  throw new Error("grok copresence process capability profile is invalid");
}
