// Runtime-partitioned provider presets for the first Codex + OpenCode V2 slice.
//
// Codex writes its own config.toml [model_providers.*] table (key by env var
// name only). OpenCode V2 writes the native document shape measured on
// @opencode/cli 2.0.22: top-level `providers` (plural), `env` (credential
// variable names), optional `package`, `settings.baseURL`, and `models`.
// Catalog providers (deepseek, minimax) keep OpenCode's package; only a
// custom OpenAI-compatible provider sets
// `@opencode/ai/providers/openai-compatible`. Nothing here is an ANet-only
// provider schema, and Claude / OpenCode V1 are refused.

import { isReservedEnvKey } from "./shared/reserved-env";

export type ProviderFamily = "codex" | "opencode-v2";

export type ProviderPresetId = "deepseek" | "minimax" | "custom-openai-compat";

export interface ProviderPreset {
  readonly id: ProviderPresetId;
  /** Id used inside the runtime file. `custom-openai-compat` is `custom`. */
  readonly providerId: string;
  readonly label: string;
  readonly defaultModel: string;
  readonly defaultBaseUrl: string;
  readonly defaultEnvKey: string;
  readonly requiresBaseUrl: boolean;
  readonly requiresModel: boolean;
  readonly requiresEnvKey: boolean;
}

const CODEX_PRESETS: readonly ProviderPreset[] = Object.freeze([
  Object.freeze({
    id: "deepseek",
    providerId: "deepseek",
    label: "DeepSeek",
    defaultModel: "deepseek-v4-flash",
    // Codex Responses API. Official quickstart uses the host with no /v1.
    defaultBaseUrl: "https://api.deepseek.com",
    defaultEnvKey: "DEEPSEEK_API_KEY",
    requiresBaseUrl: false,
    requiresModel: false,
    requiresEnvKey: false,
  }),
  Object.freeze({
    id: "minimax",
    providerId: "minimax",
    label: "MiniMax",
    defaultModel: "MiniMax-M3",
    defaultBaseUrl: "https://api.minimaxi.com/v1",
    defaultEnvKey: "MINIMAX_API_KEY",
    requiresBaseUrl: false,
    requiresModel: false,
    requiresEnvKey: false,
  }),
  Object.freeze({
    id: "custom-openai-compat",
    providerId: "custom",
    label: "Custom",
    defaultModel: "",
    defaultBaseUrl: "",
    defaultEnvKey: "",
    requiresBaseUrl: true,
    requiresModel: true,
    requiresEnvKey: true,
  }),
]);

// Same ids, different defaults: OpenCode's DeepSeek package speaks
// /v1/chat/completions, so the catalog base URL includes /v1. The rendered
// document still omits `package` for catalog ids so OpenCode keeps its own
// deepseek/minimax runtimes. baseURL is written only when the operator
// overrides it.
const OPENCODE_V2_PRESETS: readonly ProviderPreset[] = Object.freeze([
  Object.freeze({
    id: "deepseek",
    providerId: "deepseek",
    label: "DeepSeek",
    defaultModel: "deepseek-v4-flash",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    defaultEnvKey: "DEEPSEEK_API_KEY",
    requiresBaseUrl: false,
    requiresModel: false,
    requiresEnvKey: false,
  }),
  Object.freeze({
    id: "minimax",
    providerId: "minimax",
    label: "MiniMax",
    defaultModel: "MiniMax-M3",
    defaultBaseUrl: "https://api.minimax.io/v1",
    defaultEnvKey: "MINIMAX_API_KEY",
    requiresBaseUrl: false,
    requiresModel: false,
    requiresEnvKey: false,
  }),
  Object.freeze({
    id: "custom-openai-compat",
    providerId: "custom",
    label: "Custom",
    defaultModel: "",
    defaultBaseUrl: "",
    defaultEnvKey: "",
    requiresBaseUrl: true,
    requiresModel: true,
    requiresEnvKey: true,
  }),
]);

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const SECRETISH = /(_TOKEN|_KEY|_SECRET|AUTH)$/;
const MODEL_PART = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BLOCKED_ENV_PREFIXES = ["ANET_", "COMMHUB_", "OPENCODE_"] as const;

export interface ProviderRuntimeContext {
  readonly opencodeGeneration?: string;
  readonly opencodeUnsafeTools?: boolean;
}

export function providerFamilyForRuntime(
  runtime: string,
  ctx: ProviderRuntimeContext = {},
): ProviderFamily | null {
  if (runtime === "codex-sdk" || runtime === "codex-app-server") return "codex";
  if (runtime === "opencode-cli" && ctx.opencodeGeneration === "v2" && ctx.opencodeUnsafeTools === true) {
    return "opencode-v2";
  }
  return null;
}

/** Presets legal for this runtime. OpenCode V1, Claude, and every other
 * runtime get an empty list — they are not a third column of the same table. */
export function providerPresetsForRuntime(
  runtime: string,
  ctx: ProviderRuntimeContext = {},
): readonly ProviderPreset[] {
  const family = providerFamilyForRuntime(runtime, ctx);
  if (family === "codex") return CODEX_PRESETS;
  if (family === "opencode-v2") return OPENCODE_V2_PRESETS;
  return [];
}

export function assertProviderSupported(
  runtime: string,
  ctx: ProviderRuntimeContext = {},
): ProviderFamily {
  if (runtime === "opencode-cli" && ctx.opencodeGeneration !== "v2") {
    throw new Error(
      "--provider is not available for OpenCode V1. Recreate the node with --runtime opencode-cli --opencode-generation v2 --opencode-unsafe-tools, or use `anet opencode auth-login` for the built-in anthropic/openai presets. --provider does not change the V1 safe preset.",
    );
  }
  if (runtime === "opencode-cli" && ctx.opencodeUnsafeTools !== true) {
    throw new Error(
      "--provider on OpenCode V2 requires --opencode-unsafe-tools (flags.opencodeUnsafeTools=true). --provider does not turn that on.",
    );
  }
  const family = providerFamilyForRuntime(runtime, ctx);
  if (!family) {
    throw new Error(
      `--provider is not supported for runtime ${JSON.stringify(runtime)}. This release supports codex-sdk, codex-app-server (codex-cli), and opencode-cli with --opencode-generation v2 --opencode-unsafe-tools.`,
    );
  }
  return family;
}

export function assertProviderEnvName(name: string): string {
  if (!ENV_NAME.test(name)) {
    throw new Error(`--api-key-env must match ^[A-Z][A-Z0-9_]*$ (got ${JSON.stringify(name)})`);
  }
  if (!SECRETISH.test(name)) {
    throw new Error(
      `--api-key-env ${name} must end with _KEY, _TOKEN, _SECRET, or AUTH so the value is stored as an envRef and not in config.json`,
    );
  }
  if (isReservedEnvKey(name)) {
    throw new Error(`--api-key-env ${name} is reserved and cannot be a provider credential`);
  }
  for (const prefix of BLOCKED_ENV_PREFIXES) {
    if (name.startsWith(prefix)) {
      throw new Error(`--api-key-env ${name} uses a reserved ${prefix} prefix`);
    }
  }
  return name;
}

export function assertProviderBaseUrl(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0 || /[\s\u0000]/.test(raw)) {
    throw new Error("--base-url must be a single-line http(s) URL");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`--base-url is not a URL: ${JSON.stringify(raw)}`);
  }
  if (url.username || url.password) throw new Error("--base-url must not contain credentials");
  if (url.search || url.hash) throw new Error("--base-url must not contain a query or fragment");
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol === "http:" && !loopback) {
    throw new Error("--base-url must be https, or http on localhost / 127.0.0.1 / ::1");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("--base-url scheme must be https or loopback http");
  }
  return raw.replace(/\/+$/, "");
}

function assertModelPart(model: string, flag: string): string {
  if (!MODEL_PART.test(model)) {
    throw new Error(`${flag} must be a single model id token (no whitespace or slash)`);
  }
  return model;
}

export interface ResolvedProvider {
  readonly family: ProviderFamily;
  readonly presetId: ProviderPresetId;
  readonly providerId: string;
  readonly label: string;
  readonly model: string;
  /** Value stored on the node profile. Codex is the bare id; OpenCode is provider/model. */
  readonly profileModel: string;
  readonly baseUrl: string;
  /** True when the operator passed --base-url. Catalog OpenCode entries omit settings otherwise. */
  readonly baseUrlExplicit: boolean;
  readonly envKey: string;
  readonly wireApi: "responses";
  readonly opencodePackage?: string;
}

export function resolveProviderSelection(input: {
  runtime: string;
  opencodeGeneration?: string;
  opencodeUnsafeTools?: boolean;
  provider: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  model?: string;
}): ResolvedProvider {
  const family = assertProviderSupported(input.runtime, {
    opencodeGeneration: input.opencodeGeneration,
    opencodeUnsafeTools: input.opencodeUnsafeTools,
  });
  const presets = family === "codex" ? CODEX_PRESETS : OPENCODE_V2_PRESETS;
  const preset = presets.find((row) => row.id === input.provider);
  if (!preset) {
    throw new Error(
      `--provider ${JSON.stringify(input.provider)} is not a ${family} preset. Choose one of: ${presets.map((row) => row.id).join(", ")}.`,
    );
  }
  if (preset.requiresBaseUrl && !input.baseUrl) {
    throw new Error("--provider custom-openai-compat requires --base-url");
  }
  if (preset.requiresEnvKey && !input.apiKeyEnv) {
    throw new Error("--provider custom-openai-compat requires --api-key-env");
  }
  if (preset.requiresModel && !input.model) {
    throw new Error("--provider custom-openai-compat requires --model");
  }
  const envKey = assertProviderEnvName(input.apiKeyEnv || preset.defaultEnvKey);
  const baseUrlExplicit = input.baseUrl !== undefined && input.baseUrl !== "";
  const baseUrl = assertProviderBaseUrl(baseUrlExplicit ? input.baseUrl! : preset.defaultBaseUrl);
  let requestedModel = input.model;
  if (requestedModel?.includes("/")) {
    const slash = requestedModel.indexOf("/");
    const prefix = requestedModel.slice(0, slash);
    const rest = requestedModel.slice(slash + 1);
    if (prefix !== preset.providerId || rest.includes("/") || !rest) {
      throw new Error(`--model must be a bare id or ${preset.providerId}/<id>`);
    }
    requestedModel = rest;
  }
  const model = assertModelPart(requestedModel || preset.defaultModel, "--model");
  const opencodePackage = preset.id === "custom-openai-compat" && family === "opencode-v2"
    ? "@opencode/ai/providers/openai-compatible"
    : undefined;
  return {
    family,
    presetId: preset.id,
    providerId: preset.providerId,
    label: preset.label,
    model,
    profileModel: family === "opencode-v2" ? `${preset.providerId}/${model}` : model,
    baseUrl,
    baseUrlExplicit: baseUrlExplicit || preset.id === "custom-openai-compat",
    envKey,
    wireApi: "responses",
    opencodePackage,
  };
}

/** Read the credential without ever accepting it on argv. */
export function takeProviderSecret(input: {
  envKey: string;
  argv: readonly string[];
  shellEnv: Readonly<Record<string, string | undefined>>;
  dotenv?: Readonly<Record<string, string | undefined>>;
  readStdin?: () => string | undefined;
}): string {
  for (const token of input.argv) {
    if (token === "--api-key" || token.startsWith("--api-key=")) {
      throw new Error(
        `--api-key is not accepted. Export ${input.envKey} in the shell, keep it in the node .env, or pipe one line on stdin. The value must not appear on the command line.`,
      );
    }
  }
  const fromShell = input.shellEnv[input.envKey];
  const fromFile = input.dotenv?.[input.envKey];
  let value = fromShell || fromFile || "";
  if (!value && input.readStdin) value = input.readStdin() ?? "";
  if (!value) {
    throw new Error(
      `${input.envKey} is not set. Export it in this shell (export ${input.envKey}=...) or pipe one line on stdin. Do not pass the value as a flag.`,
    );
  }
  if (/[\r\n\u0000]/.test(value)) {
    throw new Error(`${input.envKey} contains a line break or NUL and cannot be stored`);
  }
  for (const token of input.argv) {
    if (token === value || token.endsWith(`=${value}`) || token.includes(`=${value}`)) {
      throw new Error(
        `refusing to read ${input.envKey}: the value was passed on the command line. Export it in the shell instead.`,
      );
    }
  }
  return value;
}

const CODEX_MANAGED_KEYS = ["name", "base_url", "env_key", "wire_api"] as const;

function codexManagedValue(spec: ResolvedProvider, key: (typeof CODEX_MANAGED_KEYS)[number]): string {
  if (key === "name") return spec.label;
  if (key === "base_url") return spec.baseUrl;
  if (key === "env_key") return spec.envKey;
  return spec.wireApi;
}

/** Idempotent line merge. Other tables, including [projects.*] and
 * [mcp_servers.commhub], stay byte-identical. Unknown keys inside the managed
 * provider table are kept. The key value is never written. */
export function mergeCodexProviderToml(existing: string, spec: ResolvedProvider): string {
  if (spec.family !== "codex") throw new Error("Codex config.toml is only rendered for the codex family");
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const trimmed = existing.endsWith("\n") ? existing.slice(0, -1) : existing;
  const lines = trimmed.length ? trimmed.split(/\r?\n/) : [];
  const headerRe = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/;
  const managedHeader = `model_providers.${spec.providerId}`;
  let section: string | null = null;
  let sawModel = false;
  let sawProvider = false;
  let sawTable = false;
  const managedSeen = new Set<string>();
  const out: string[] = [];

  const flushMissing = () => {
    if (!sawTable) return;
    for (const key of CODEX_MANAGED_KEYS) {
      if (!managedSeen.has(key)) out.push(`${key} = ${JSON.stringify(codexManagedValue(spec, key))}`);
    }
  };

  for (const line of lines) {
    const header = headerRe.exec(line);
    if (header) {
      if (section === managedHeader) flushMissing();
      section = header[1].trim();
      if (section === managedHeader) {
        sawTable = true;
        managedSeen.clear();
      }
      out.push(line);
      continue;
    }
    if (section === null && /^\s*model\s*=/.test(line)) {
      out.push(`model = ${JSON.stringify(spec.model)}`);
      sawModel = true;
      continue;
    }
    if (section === null && /^\s*model_provider\s*=/.test(line)) {
      out.push(`model_provider = ${JSON.stringify(spec.providerId)}`);
      sawProvider = true;
      continue;
    }
    if (section === managedHeader) {
      const key = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line)?.[1];
      if (key && (CODEX_MANAGED_KEYS as readonly string[]).includes(key)) {
        managedSeen.add(key);
        out.push(`${key} = ${JSON.stringify(codexManagedValue(spec, key as (typeof CODEX_MANAGED_KEYS)[number]))}`);
        continue;
      }
    }
    out.push(line);
  }
  if (section === managedHeader) flushMissing();

  const head: string[] = [];
  if (!sawModel) head.push(`model = ${JSON.stringify(spec.model)}`);
  if (!sawProvider) head.push(`model_provider = ${JSON.stringify(spec.providerId)}`);
  if (head.length) out.unshift(...head);
  if (!sawTable) {
    if (out.length && out[out.length - 1] !== "") out.push("");
    out.push(`[${managedHeader}]`);
    for (const key of CODEX_MANAGED_KEYS) {
      out.push(`${key} = ${JSON.stringify(codexManagedValue(spec, key))}`);
    }
  }
  return `${out.join(eol)}${eol}`;
}

export interface OpenCodeV2ProviderEntry {
  readonly name: string;
  readonly env: readonly string[];
  readonly package?: string;
  readonly settings?: { readonly baseURL: string };
  readonly models: Readonly<Record<string, { readonly name: string }>>;
}

export function renderOpenCodeV2Provider(spec: ResolvedProvider): OpenCodeV2ProviderEntry {
  if (spec.family !== "opencode-v2") throw new Error("OpenCode providers are only rendered for OpenCode V2");
  const entry: OpenCodeV2ProviderEntry = {
    name: spec.label,
    env: [spec.envKey],
    ...(spec.opencodePackage ? { package: spec.opencodePackage } : {}),
    ...(spec.baseUrlExplicit ? { settings: { baseURL: spec.baseUrl } } : {}),
    models: { [spec.model]: { name: spec.model } },
  };
  return entry;
}

/** Merge one native provider into an existing opencode.json. V1 `provider`,
 * tools, permission, and mcp keys are left in place. */
export function mergeOpenCodeV2Config(existing: string, spec: ResolvedProvider): string {
  const parsed: unknown = existing.trim() ? JSON.parse(existing) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("opencode.json must be a JSON object");
  }
  const doc = parsed as Record<string, unknown>;
  const current = doc.providers;
  const providers: Record<string, unknown> =
    current && typeof current === "object" && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};
  providers[spec.providerId] = renderOpenCodeV2Provider(spec);
  doc.providers = providers;
  doc.model = spec.profileModel;
  if (typeof doc.$schema !== "string") doc.$schema = "https://opencode.ai/config.json";
  return `${JSON.stringify(doc, null, 2)}\n`;
}
