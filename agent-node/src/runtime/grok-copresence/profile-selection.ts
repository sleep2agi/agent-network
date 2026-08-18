export const GROK_COPRESENCE_PROFILE_ENV = "ANET_INTERNAL_GROK_COPRESENCE_PROFILE";

export type GrokCopresenceCapabilityProfile = "commhub-only" | "x-search" | "repo-read";

export interface GrokCopresenceSandboxProfiles {
  workspaceProfile: string;
  strictProfile: string;
}

/**
 * Resolve once while agent-node boots. Co-presence deliberately does not
 * accept a general tool allowlist. Each opt-in is one reviewed, exact profile
 * represented by canonical Claude-style tool names.
 */
export function selectGrokCopresenceCapabilityProfile(
  tools: readonly string[] | undefined,
): GrokCopresenceCapabilityProfile {
  if (tools === undefined || tools.length === 0) return "commhub-only";
  if (tools.length === 1 && tools[0] === "WebSearch") return "x-search";
  if (
    tools.length === 3
    && tools[0] === "Read"
    && tools[1] === "Grep"
    && tools[2] === "Glob"
  ) return "repo-read";
  throw new Error(
    'grok copresence supports only the exact tools profiles ["WebSearch"], ["Read","Grep","Glob"], or an omitted tools field',
  );
}

/** Read only by modules loaded after cli.ts has pinned the process profile. */
export function readPinnedGrokCopresenceCapabilityProfile(
  env: NodeJS.ProcessEnv = process.env,
): GrokCopresenceCapabilityProfile {
  const value = env[GROK_COPRESENCE_PROFILE_ENV];
  if (value === undefined || value === "") return "commhub-only";
  if (value === "commhub-only" || value === "x-search" || value === "repo-read") return value;
  throw new Error("grok copresence process capability profile is invalid");
}

/**
 * Repo reads require Grok's kernel-enforced strict base. Pinned 0.2.93
 * documents the workspace base as read-everywhere.
 */
export function selectGrokCopresenceSandboxProfile(
  profile: GrokCopresenceCapabilityProfile,
  profiles: GrokCopresenceSandboxProfiles,
): string {
  return profile === "repo-read" ? profiles.strictProfile : profiles.workspaceProfile;
}
