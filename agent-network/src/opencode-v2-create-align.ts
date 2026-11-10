// CLI side of V2 co-presence create. The model and provider come from
// OpenCode's own config on this machine. --provider may only restate that
// provider id. --base-url, --api-key-env, and a preset default model are
// not applied: they would replace the native document.

import { providerPresetsForRuntime } from "./provider-presets";
import {
  assertOpenCodeV2RequestedModel,
  OpenCodeV2AlignError,
  readOpenCodeConfiguredSelection,
  renderOpenCodeV2AlignedConfig,
  type OpenCodeConfiguredSelection,
} from "./opencode-v2-configured-model";

export interface PlanOpencodeV2CreateInput {
  projectDir: string;
  homeDir: string;
  xdgConfigHome?: string;
  requestedModel?: string;
  requestedProvider?: string;
  requestedBaseUrl?: string;
  requestedApiKeyEnv?: string;
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
}

export interface PlannedOpencodeV2Create {
  readonly selection: OpenCodeConfiguredSelection;
  readonly opencodeJson: string;
  readonly credentialEnv: readonly string[];
}

export function planOpencodeV2Create(input: PlanOpencodeV2CreateInput): PlannedOpencodeV2Create {
  for (const token of input.argv) {
    if (token === "--api-key" || token.startsWith("--api-key=")) {
      throw new OpenCodeV2AlignError(
        "opencode_v2_provider_mismatch",
        "--api-key is not accepted. OpenCode V2 co-presence uses the provider already configured on this machine. The value must not appear on the command line.",
      );
    }
  }
  if (input.requestedBaseUrl || input.requestedApiKeyEnv) {
    throw new OpenCodeV2AlignError(
      "opencode_v2_provider_mismatch",
      "--base-url and --api-key-env would replace OpenCode's provider settings. Edit OpenCode's own opencode.json instead.",
    );
  }
  const selection = readOpenCodeConfiguredSelection({
    projectDir: input.projectDir,
    homeDir: input.homeDir,
    xdgConfigHome: input.xdgConfigHome,
  });
  const requestedModel = input.requestedModel?.trim();
  assertOpenCodeV2RequestedModel(selection, requestedModel || undefined);
  if (input.requestedProvider) {
    const presets = providerPresetsForRuntime("opencode-cli", {
      opencodeGeneration: "v2",
      opencodeUnsafeTools: true,
    });
    const preset = presets.find((row) => row.id === input.requestedProvider);
    if (!preset) {
      throw new OpenCodeV2AlignError(
        "opencode_v2_provider_mismatch",
        `--provider ${JSON.stringify(input.requestedProvider)} is not an OpenCode V2 preset (${presets.map((row) => row.id).join(", ")}). It is not used as a fallback.`,
      );
    }
    if (preset.providerId !== selection.providerId) {
      throw new OpenCodeV2AlignError(
        "opencode_v2_provider_mismatch",
        `--provider ${preset.id} (${preset.providerId}) does not match this machine's OpenCode provider ${JSON.stringify(selection.providerId)}.`,
      );
    }
  }
  for (const name of selection.credentialEnv) {
    const value = input.env[name];
    if (typeof value !== "string" || value.length === 0) {
      throw new OpenCodeV2AlignError(
        "opencode_v2_provider_credential_missing",
        `OpenCode provider ${JSON.stringify(selection.providerId)} requires ${name}, which is not set. Export it in this shell. The value is not printed.`,
      );
    }
  }
  return {
    selection,
    opencodeJson: renderOpenCodeV2AlignedConfig(selection),
    credentialEnv: selection.credentialEnv,
  };
}
