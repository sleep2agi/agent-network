// #906/#901: read the native V2 API, never synthesize a provider preset list.
// The caller owns the authenticated loopback server and the daemon/network scope.
// A native model snapshot can precede plugin settlement: it is NOT a successful
// model invocation, credential verification, or proof that the catalog is complete.
export interface OpenCodeCatalogScope {
  networkId: string;
  daemonId: string;
  directory: string;
}

export interface OpenCodeCatalogSnapshot {
  scope: OpenCodeCatalogScope;
  source: "opencode-v2-api";
  state: "snapshot";
  invocationVerified: false;
  completeness: "unknown";
  observedAt: string;
  providers: Array<{ id: string; activation: "auto" | "enabled" | "disabled" }>;
  models: Array<{ providerId: string; id: string }>;
  defaultModel: { providerId: string; id: string } | null;
}

export type CatalogError = "invalid_target" | "unauthorized" | "unavailable" | "invalid_response" | "scope_mismatch" | "too_large";
export class OpenCodeCatalogError extends Error {
  constructor(readonly code: CatalogError) { super(`opencode_catalog_${code}`); }
}

const MAX_BODY = 2 * 1024 * 1024;
const MAX_ROWS = 20_000;
const SECRET = /^(sk-|gh[pousr]_|github_pat_|xox[baprs]-|AKIA|AIza|ya29\.|glpat-)/i;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// Preserve upstream IDs, including nested slashes in model IDs. Do not copy
// names/settings/headers/body/endpoint URLs: those may contain credential values.
function identifier(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 512 || /[\s\u0000-\u001f\u007f]/.test(value) || SECRET.test(value)) {
    throw new OpenCodeCatalogError("invalid_response");
  }
  return value;
}

function dataAt(value: unknown, directory: string): unknown {
  if (!record(value) || !record(value.location)) throw new OpenCodeCatalogError("invalid_response");
  if (value.location.directory !== directory) throw new OpenCodeCatalogError("scope_mismatch");
  return value.data;
}

/** Whitelist only public identity fields; reject partial/malformed snapshots. */
export function normalizeOpenCodeCatalog(
  scope: OpenCodeCatalogScope, providerResponse: unknown, modelResponse: unknown, defaultResponse: unknown,
  observedAt: string,
): OpenCodeCatalogSnapshot {
  const rawProviders = dataAt(providerResponse, scope.directory);
  const rawModels = dataAt(modelResponse, scope.directory);
  const rawDefault = dataAt(defaultResponse, scope.directory);
  if (!Array.isArray(rawProviders) || !Array.isArray(rawModels)) throw new OpenCodeCatalogError("invalid_response");
  if (rawProviders.length > MAX_ROWS || rawModels.length > MAX_ROWS) throw new OpenCodeCatalogError("too_large");
  const providers = new Map<string, OpenCodeCatalogSnapshot["providers"][number]>();
  for (const row of rawProviders) {
    if (!record(row) || !["auto", "enabled", "disabled"].includes(String(row.activation))) throw new OpenCodeCatalogError("invalid_response");
    const id = identifier(row.id);
    if (providers.has(id)) throw new OpenCodeCatalogError("invalid_response");
    providers.set(id, { id, activation: row.activation as "auto" | "enabled" | "disabled" });
  }
  const models = new Map<string, { providerId: string; id: string }>();
  for (const row of rawModels) {
    if (!record(row)) throw new OpenCodeCatalogError("invalid_response");
    const providerId = identifier(row.providerID), id = identifier(row.id);
    // A provider change between requests is not a consistent snapshot. Retry
    // at the caller; do not silently drop a model and report a complete list.
    if (!providers.has(providerId)) throw new OpenCodeCatalogError("invalid_response");
    const key = JSON.stringify([providerId, id]);
    if (models.has(key)) throw new OpenCodeCatalogError("invalid_response");
    models.set(key, { providerId, id });
  }
  let defaultModel: OpenCodeCatalogSnapshot["defaultModel"] = null;
  if (rawDefault !== undefined && rawDefault !== null) {
    if (!record(rawDefault)) throw new OpenCodeCatalogError("invalid_response");
    const providerId = identifier(rawDefault.providerID), id = identifier(rawDefault.id);
    defaultModel = models.get(JSON.stringify([providerId, id])) ?? null;
    if (!defaultModel) throw new OpenCodeCatalogError("invalid_response");
  }
  return { scope: { ...scope }, source: "opencode-v2-api", state: "snapshot", invocationVerified: false,
    completeness: "unknown", observedAt, providers: [...providers.values()], models: [...models.values()], defaultModel };
}

/** Read only an already-owned loopback server. Does not start/reload a server,
 * read auth.json, send a prompt, or make a paid model probe. No raw errors escape. */
export async function readOpenCodeCatalog(opts: {
  scope: OpenCodeCatalogScope;
  url: string;
  authorization: string;
  timeoutMs?: number;
}): Promise<OpenCodeCatalogSnapshot> {
  let base: URL;
  try { base = new URL(opts.url); } catch { throw new OpenCodeCatalogError("invalid_target"); }
  if (!['127.0.0.1', '[::1]'].includes(base.hostname) || base.protocol !== 'http:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new OpenCodeCatalogError("invalid_target");
  }
  if (!opts.scope.networkId || !opts.scope.daemonId || !opts.scope.directory || !opts.authorization || /[\r\n]/.test(opts.authorization)) throw new OpenCodeCatalogError("invalid_target");
  const timeoutMs = opts.timeoutMs ?? 5_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new OpenCodeCatalogError("invalid_target");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const read = async (path: string): Promise<unknown> => {
    const url = new URL(path, base);
    url.searchParams.set("directory", opts.scope.directory);
    const response = await fetch(url, { headers: { authorization: opts.authorization }, redirect: "error", signal: controller.signal });
    if (response.status === 401 || response.status === 403) throw new OpenCodeCatalogError("unauthorized");
    if (!response.ok) throw new OpenCodeCatalogError("unavailable");
    if (!response.body) throw new OpenCodeCatalogError("invalid_response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > MAX_BODY) throw new OpenCodeCatalogError("too_large");
        chunks.push(chunk.value);
      }
      try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw new OpenCodeCatalogError("invalid_response"); }
    } finally { await reader.cancel().catch(() => {}); }
  };
  try {
    const [providers, models, defaultModel] = await Promise.all([
      read("/api/provider"), read("/api/model"), read("/api/model/default"),
    ]);
    return normalizeOpenCodeCatalog(opts.scope, providers, models, defaultModel, new Date().toISOString());
  } catch (error) {
    throw error instanceof OpenCodeCatalogError ? error : new OpenCodeCatalogError("unavailable");
  } finally { clearTimeout(timer); controller.abort(); }
}
