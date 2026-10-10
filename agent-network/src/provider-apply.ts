// Filesystem side of `anet node create|edit --provider`. The rendered bytes
// come from provider-presets.ts; this module only places them.
//
// Codex: <node>/codex-home/config.toml (directory 0700, file 0600).
// OpenCode V2: merge into the node's native opencode.json after the safe
// preset writer has created the tree. The API key is not an argument here.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { replaceOpencodeConfigJson } from "./opencode-preset";
import { atomicWritePrivateFile, ensurePrivateDirectory } from "./private-state";
import {
  mergeCodexProviderToml,
  mergeOpenCodeV2Config,
  resolveProviderSelection,
  takeProviderSecret,
  type ResolvedProvider,
} from "./provider-presets";

export interface StageProviderInput {
  runtime: string;
  opencodeGeneration?: string;
  opencodeUnsafeTools?: boolean;
  provider?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  model?: string;
  argv: readonly string[];
  shellEnv: Readonly<Record<string, string | undefined>>;
  dotenv?: Readonly<Record<string, string | undefined>>;
  readStdin?: () => string | undefined;
}

export interface StagedProvider {
  readonly resolved: ResolvedProvider;
  readonly secret: string;
}

/** Returns null when the operator did not ask for a provider. Throws on a
 * partial or illegal request. Does not write. */
export function stageProviderRequest(input: StageProviderInput): StagedProvider | null {
  if (!input.provider && !input.baseUrl && !input.apiKeyEnv) return null;
  if (!input.provider) {
    throw new Error("--base-url and --api-key-env require --provider");
  }
  const resolved = resolveProviderSelection({
    runtime: input.runtime,
    opencodeGeneration: input.opencodeGeneration,
    opencodeUnsafeTools: input.opencodeUnsafeTools,
    provider: input.provider,
    baseUrl: input.baseUrl,
    apiKeyEnv: input.apiKeyEnv,
    model: input.model,
  });
  const secret = takeProviderSecret({
    envKey: resolved.envKey,
    argv: input.argv,
    shellEnv: input.shellEnv,
    dotenv: input.dotenv,
    readStdin: input.readStdin,
  });
  return { resolved, secret };
}

export function applyStagedProviderToProfile(
  profile: { model?: string; env?: Record<string, string> },
  staged: StagedProvider,
): void {
  profile.model = staged.resolved.profileModel;
  const env = profile.env ?? {};
  env[staged.resolved.envKey] = staged.secret;
  profile.env = env;
}

/** Write the runtime file. Call after the node directory exists, and for
 * OpenCode after writeOpencodePresetIfRequested so this merge is last. */
export function materializeStagedProvider(nodeDir: string, resolved: ResolvedProvider): void {
  if (resolved.family === "codex") {
    const home = join(nodeDir, "codex-home");
    ensurePrivateDirectory(home);
    const path = join(home, "config.toml");
    let existing = "";
    try {
      existing = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    atomicWritePrivateFile(path, mergeCodexProviderToml(existing, resolved));
    return;
  }
  const configPath = join(nodeDir, ".config", "opencode", "opencode.json");
  let existing = "";
  try {
    existing = readFileSync(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  replaceOpencodeConfigJson(nodeDir, mergeOpenCodeV2Config(existing, resolved));
}
