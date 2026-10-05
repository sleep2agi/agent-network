// Board #543 — the anet side of the OpenCode V2 preview gate.
//
// `anet node create <n> --runtime opencode-cli --opencode-generation v2 --opencode-unsafe-tools`
// is the only way to create a V2 node: V2 ignores the V1 safety env, so it
// may only run with flags.opencodeUnsafeTools=true (and only in co-presence
// mode). Without the explicit flag the create is refused with one line.
// Nothing here runs for V1: a create without --opencode-generation, or with
// `v1`, returns the profile object untouched (same identity).

import {
  isOpencodeGeneration,
  opencodeGenerationOfConfig,
  opencodeGenerationRefusal,
  opencodeGenerationSupport,
} from "./opencode-versions";

export type OpencodeGenerationCreateResult<P> =
  | { ok: true; profile: P }
  | { ok: false; refusal: string };

export function applyOpencodeGenerationCreateOption<
  P extends { opencodeGeneration?: unknown; opencodeMode?: string; flags?: Record<string, any> },
>(
  profile: P,
  opts: Record<string, unknown> & { "opencode-generation"?: string; "opencode-unsafe-tools"?: string },
): OpencodeGenerationCreateResult<P> {
  const raw = opts["opencode-generation"];
  if (raw === undefined) {
    if (opts["opencode-unsafe-tools"] !== undefined) {
      return { ok: false, refusal: "--opencode-unsafe-tools is only accepted together with --opencode-generation v2; for an OpenCode v1 node set flags.opencodeUnsafeTools in its config.json." };
    }
    return { ok: true, profile };
  }
  if (!isOpencodeGeneration(raw)) {
    return { ok: false, refusal: `--opencode-generation must be v1 or v2 (got ${JSON.stringify(raw)}).` };
  }
  if (raw === "v1") {
    if (opts["opencode-unsafe-tools"] !== undefined) {
      return { ok: false, refusal: "--opencode-unsafe-tools is only accepted together with --opencode-generation v2; for an OpenCode v1 node set flags.opencodeUnsafeTools in its config.json." };
    }
    return { ok: true, profile };
  }
  const unsafeTools = opts["opencode-unsafe-tools"] === "true";
  const refusal = opencodeGenerationRefusal(raw, { unsafeTools, mode: "copresence" });
  if (refusal) {
    return {
      ok: false,
      refusal: unsafeTools
        ? refusal
        : `Refusing --opencode-generation ${raw}: OpenCode ${raw} (${opencodeGenerationSupport(raw).packageName}) ignores the node safety policy, so it only runs with every local tool enabled. Re-run with --opencode-unsafe-tools (trusted tasks only), or omit --opencode-generation for OpenCode v1.`,
    };
  }
  return {
    ok: true,
    profile: {
      ...profile,
      opencodeGeneration: raw,
      opencodeMode: "copresence",
      flags: { ...(profile.flags ?? {}), opencodeUnsafeTools: true },
    },
  };
}

/** Start-time gate for a stored profile: one line when it must not start,
 *  else null. V1 (and a config without the field) is never refused. */
export function opencodeStartGenerationRefusal(
  profile: { opencodeGeneration?: unknown; opencodeMode?: string; flags?: Record<string, any> },
  opts: { copresence: boolean; configFile?: string },
): string | null {
  const generation = opencodeGenerationOfConfig(profile);
  if (generation === undefined) {
    return `Refusing opencodeGeneration=${JSON.stringify(profile.opencodeGeneration)} in ${opts.configFile ?? "the node config.json"}; expected "v1" or "v2".`;
  }
  return opencodeGenerationRefusal(generation, {
    unsafeTools: profile.flags?.opencodeUnsafeTools === true,
    mode: opts.copresence || profile.opencodeMode === "copresence" ? "copresence" : "headless",
    configFile: opts.configFile,
  });
}

/** Exact install command for a generation's pin. */
export function opencodeGenerationInstallCommand(generation: "v1" | "v2"): string {
  const support = opencodeGenerationSupport(generation);
  return `npm install -g ${support.packageName}@${support.pin}`;
}
