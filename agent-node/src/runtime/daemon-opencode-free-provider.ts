// Daemon-owned OpenCode Provider discovery. A catalog is not an invocation or
// an entitlement check. Never infer "free" from a model name or missing price.
import { readOpenCodeRaw, type OpenCodeCatalogScope } from "./opencode-v2-catalog";
import { OPENCODE_V2_PIN } from "./opencode-versions";
export interface OpenCodeFreeModel { providerID: "opencode"; id: string }
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const modelId = (v: unknown): v is string => typeof v === "string"
  && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(v);

export function freeOpenCodeModels(snapshot: unknown, directory: string): OpenCodeFreeModel[] {
  if (!record(snapshot) || !record(snapshot.location) || snapshot.location.directory !== directory
    || !Array.isArray(snapshot.data) || snapshot.data.length > 20_000) throw new Error("opencode_free_catalog_invalid");
  const result: OpenCodeFreeModel[] = [];
  const seen = new Set<string>();
  for (const row of snapshot.data) {
    if (!record(row) || row.providerID !== "opencode" || !modelId(row.id)
      || row.enabled !== true || !["active", "beta", "alpha"].includes(String(row.status))
      || !Array.isArray(row.cost) || row.cost.length === 0) continue;
    // Every context tier and every chargeable token category must be explicitly
    // numeric zero. Unknown/empty prices, strings and partial cache data fail closed.
    if (!row.cost.every(tier => record(tier) && tier.input === 0 && tier.output === 0
      && record(tier.cache) && tier.cache.read === 0 && tier.cache.write === 0)) continue;
    if (seen.has(row.id)) throw new Error("opencode_free_catalog_duplicate");
    seen.add(row.id);
    result.push({ providerID: "opencode", id: row.id });
  }
  // Preserve native catalog order (release date), not a hardcoded preference.
  return result;
}

export function selectFreeOpenCodeModel(snapshot: unknown, directory: string, unsafeToolsConsent: boolean): OpenCodeFreeModel {
  if (unsafeToolsConsent !== true) throw new Error("opencode_v2_requires_unsafe_opt_in");
  const selected = freeOpenCodeModels(snapshot, directory)[0];
  if (!selected) throw new Error("opencode_free_model_unavailable");
  return selected;
}

/** Private daemon discovery: same authenticated, redirect-denying, scoped read
 * as the existing catalog. No raw settings/credentials are returned. */
export async function readFreeOpenCodeModels(opts: {
  scope: OpenCodeCatalogScope; url: string; authorization: string; timeoutMs?: number;
}) {
  const info = await readOpenCodeRaw(opts, "/api/info");
  if (!record(info) || info.version !== OPENCODE_V2_PIN) throw new Error("opencode_free_version_mismatch");
  const models = freeOpenCodeModels(await readOpenCodeRaw(opts, "/api/model"), opts.scope.directory);
  return { scope: { ...opts.scope }, models, invocationVerified: false as const, completeness: "unknown" as const };
}
