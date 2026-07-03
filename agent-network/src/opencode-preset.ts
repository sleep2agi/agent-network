// RFC-029 PR③ — opencode vendor preset registry + auth.json writer.
//
// Preset choices covered here (per RFC-029 §8 D3, 通信龙 拍板):
//
//   anthropic — Anthropic 原生 API. opencode's built-in Anthropic
//               client uses `x-api-key`; reads key from env
//               `ANTHROPIC_API_KEY`. Any Bearer-only vendor gateway
//               (Kimi coding etc.) is a plugin-track backlog item.
//   openai    — OpenAI. Uses `OPENAI_API_KEY`.
//
// The auth.json file is written to `<nodeWorkDir>/.local/share/
// opencode/auth.json` (opencode's config root under HOME as set by
// PR② §8 D5 isolation) with mode 0o600. The API key is READ FROM
// ENV — per 通信龙 PR③ refinement 2, we don't prompt for it.
//
// The path is also denylisted from the agent's own tool-layer
// reads in agent-node/src/feishu-tool-deny.ts (parallel to the
// feishu access.json defense in reference feishu-open-channel-secret-
// exfil): a running opencode agent MUST NOT be able to Read /
// exfiltrate its own vendor key.

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

export type OpencodePresetId = "anthropic" | "openai";

export interface OpencodePreset {
  id: OpencodePresetId;
  displayName: string;
  envKey: string;
  signupUrl: string;
  /** How opencode's provider config identifies this vendor in the
   *  `provider.<id>.options.baseUrl` config. Left null when we don't
   *  need to override the built-in default. */
  configProviderId: "anthropic" | "openai";
}

export const OPENCODE_PRESETS: OpencodePreset[] = [
  {
    id: "anthropic",
    displayName: "Anthropic 原生 API (claude.ai)",
    envKey: "ANTHROPIC_API_KEY",
    signupUrl: "https://console.anthropic.com/settings/keys",
    configProviderId: "anthropic",
  },
  {
    id: "openai",
    displayName: "OpenAI",
    envKey: "OPENAI_API_KEY",
    signupUrl: "https://platform.openai.com/api-keys",
    configProviderId: "openai",
  },
];

export function findOpencodePreset(id: string): OpencodePreset | null {
  return OPENCODE_PRESETS.find((p) => p.id === id) ?? null;
}

/**
 * Look up the API key for a preset from the current process env.
 * Callers MUST handle the `null` case (per RFC v0.3 D3 + 通信龙 PR③
 * flag: "从 env 读, 别 prompt"). Returns null so the wizard can
 * emit a clear message telling the operator to export the env var
 * and re-run — rather than silently continuing without a key.
 */
export function readPresetKeyFromEnv(preset: OpencodePreset, env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env[preset.envKey];
  if (typeof v === "string" && v.trim()) return v.trim();
  return null;
}

/**
 * opencode.ai's auth.json shape:
 *   { "<providerId>": { "type": "api", "key": "..." } }
 * Same shape Phase 0b probes verified against opencode-ai@1.17.13.
 */
export function buildAuthJsonBody(preset: OpencodePreset, apiKey: string): string {
  const body: Record<string, unknown> = {
    [preset.configProviderId]: { type: "api", key: apiKey },
  };
  return JSON.stringify(body, null, 2) + "\n";
}

/**
 * Write auth.json into the opencode config root that lives under
 * `nodeWorkDir` (which becomes the child's HOME per PR② §8 D5).
 * mode 0o600 keeps it operator-only. Directory is created if
 * missing.
 *
 * Returns the absolute path we wrote for logging.
 */
export function writeOpencodeAuthJson(
  nodeWorkDir: string,
  preset: OpencodePreset,
  apiKey: string,
): string {
  const authDir = join(nodeWorkDir, ".local", "share", "opencode");
  if (!existsSync(authDir)) mkdirSync(authDir, { recursive: true, mode: 0o700 });
  const authPath = join(authDir, "auth.json");
  const body = buildAuthJsonBody(preset, apiKey);
  writeFileSync(authPath, body, { mode: 0o600 });
  return authPath;
}

/**
 * Companion opencode.json: pins the vendor's baseUrl (defaults for
 * Anthropic / OpenAI are fine, so this is minimal for now). A
 * placeholder so later PRs can push per-node overrides without
 * needing to invent the file.
 */
export function writeOpencodeConfigJson(
  nodeWorkDir: string,
  preset: OpencodePreset,
): string {
  const configDir = join(nodeWorkDir, ".config", "opencode");
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const configPath = join(configDir, "opencode.json");
  const body = JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    provider: {
      [preset.configProviderId]: { options: {} },
    },
  }, null, 2) + "\n";
  writeFileSync(configPath, body, { mode: 0o600 });
  return configPath;
}
