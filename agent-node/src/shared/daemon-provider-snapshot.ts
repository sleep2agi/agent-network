// #906 public Provider snapshot contract. Mirrored across separately published
// server/agent-node packages; drift is tested. No secret-shaped extension fields.
import { validCodexInventory } from './codex-inventory.js';
export function validateDaemonProviderSnapshot(value: unknown, networkId: string, daemonId: string): unknown {
  const fail = (): never => { throw new Error("invalid_provider_snapshot"); };
  const obj = (v: any, fields: string[]) => {
    if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => !fields.includes(k))) fail();
    return v;
  };
  const id = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v);
  const unique = (xs: any[], key: string) => { if (new Set(xs.map(x => x[key])).size !== xs.length) fail(); };
  const arr = (v: any, max: number, empty = false): any[] => {
    if (!Array.isArray(v) || (!empty && !v.length) || v.length > max) fail();
    return v;
  };
  const s = obj(value, ["network_id", "daemon_node_id", "revision", "source", "providers", "codex_inventory"]);
  if (s.codex_inventory !== undefined && !validCodexInventory(s.codex_inventory)) fail();
  if (s.network_id !== networkId || s.daemon_node_id !== daemonId || s.source !== "daemon"
    || !Number.isSafeInteger(s.revision) || s.revision < 0) fail();
  const providers = arr(s.providers, 100, true);
  unique(providers, "id");
  for (const p of providers) {
    obj(p, ["id", "label", "enabled", "runtimes"]);
    if (!id(p.id) || typeof p.label !== "string" || !p.label.trim() || p.label.length > 100
      || /[\x00-\x1f\x7f]/.test(p.label) || typeof p.enabled !== "boolean") fail();
    const runtimes = arr(p.runtimes, 8); unique(runtimes, "runtime");
    for (const r of runtimes) {
      obj(r, ["runtime", "auth"]); if (r.runtime !== "codex-tui") fail();
      const auths = arr(r.auth, 32); unique(auths, "id");
      for (const a of auths) {
        obj(a, ["id", "kind", "models", "baseUrl", "account_id", "credential_present", "verification", "application"]);
        if (!id(a.id) || a.verification !== "not_checked" || a.application !== "not_applied") fail();
        const models = arr(a.models, 200);
        if (new Set(models).size !== models.length || models.some(m => typeof m !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(m))) fail();
        if (a.kind === "chatgpt") {
          if (p.id !== "openai" || a.baseUrl !== undefined || typeof a.credential_present !== 'boolean') fail();
          if (a.account_id !== undefined && (typeof a.account_id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(a.account_id))) fail();
          if (a.credential_present && !a.account_id) fail();
        } else if (a.kind === "api_key") {
          if (a.account_id !== undefined) fail();
          if (a.credential_present !== true || typeof a.baseUrl !== "string" || a.baseUrl.length > 2048) fail();
          let u: URL; try { u = new URL(a.baseUrl); } catch { return fail(); }
          if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) fail();
        } else fail();
      }
    }
  }
  // JSON roundtrip detaches the validated object from mutable caller references.
  const encoded = JSON.stringify(s);
  if (new TextEncoder().encode(encoded).byteLength > 1024 * 1024) fail();
  return JSON.parse(encoded);
}
