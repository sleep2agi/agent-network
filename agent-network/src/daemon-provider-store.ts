// #906: daemon-owned Provider -> runtime -> authentication configuration.
// This is the private persistence boundary, not a Hub registry or an inference
// health check. Public projections are constructed field by field: never spread
// a secret-bearing object onto a response. Runtime application is a separate gate.
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { atomicWritePrivateJson, ensurePrivateDirectory } from "./private-state";

export type ProviderAuthKind = "chatgpt" | "api_key";
type Auth = { id: string; kind: ProviderAuthKind; models: string[]; baseUrl?: string; key?: string; account_id?: string };
const accountId = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
type Runtime = { runtime: "codex-tui"; auth: Auth[] };
type Provider = { id: string; label: string; enabled: boolean; runtimes: Runtime[] };
type Scope = { network_id: string; daemon_node_id: string };
type State = Scope & { schema: 1; revision: number; providers: Provider[];
  last_write?: { request_id: string; input_hash: string; revision: number } };

export class DaemonProviderError extends Error {
  constructor(public readonly code: string) { super(code); }
}
function fail(code: string): never { throw new DaemonProviderError(code); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_object");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail("unsupported_field");
}
function id(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) fail("invalid_id");
  return value;
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) fail("invalid_list");
  return value;
}
function unique(values: string[]): void {
  if (new Set(values).size !== values.length) fail("duplicate_id");
}
function endpoint(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) fail("invalid_endpoint");
  let url: URL;
  try { url = new URL(value); } catch { fail("invalid_endpoint"); }
  // A saved endpoint is NOT permission to probe it: network requests must retain
  // the Hub/runtime's SSRF/redirect guard. No credentials in URLs or query strings.
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) fail("invalid_endpoint");
  return url.toString().replace(/\/$/, "");
}
function parseProvider(value: unknown, previous?: Provider): Provider {
  const p = object(value);
  keys(p, ["id", "label", "enabled", "runtimes"]);
  const providerId = id(p.id);
  if (typeof p.label !== "string" || !p.label.trim() || p.label.length > 100 || /[\x00-\x1f\x7f]/.test(p.label)) fail("invalid_label");
  if (typeof p.enabled !== "boolean") fail("invalid_enabled");
  const runtimes = list(p.runtimes, 8).map(raw => {
    const r = object(raw); keys(r, ["runtime", "auth"]);
    // Add runtimes only with an actual adapter; do not claim all runtimes support
    // both authentication modes because the UI hierarchy has those dimensions.
    if (r.runtime !== "codex-tui") fail("unsupported_runtime");
    const auth = list(r.auth, 32).map(rawAuth => {
      const a = object(rawAuth); keys(a, ["id", "kind", "models", "baseUrl", "key", "account_id"]);
      const authId = id(a.id);
      if (a.kind !== "chatgpt" && a.kind !== "api_key") fail("unsupported_auth");
      const models = list(a.models, 200).map(model => {
        if (typeof model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(model)) fail("invalid_model");
        return model;
      });
      unique(models);
      if (a.kind === "chatgpt") {
        if (providerId !== "openai" || a.key !== undefined || a.baseUrl !== undefined) fail("unsupported_auth_combination");
        if (a.account_id !== undefined && !accountId(a.account_id)) fail('invalid_account_id');
        return { id: authId, kind: "chatgpt" as const, models, ...(a.account_id ? { account_id: a.account_id as string } : {}) };
      }
      if (a.account_id !== undefined) fail('unsupported_auth_combination');
      const prior = previous?.runtimes.find(x => x.runtime === r.runtime)?.auth.find(x => x.id === authId && x.kind === "api_key");
      const baseUrl = endpoint(a.baseUrl);
      if (a.key === undefined && prior && baseUrl !== prior.baseUrl) fail("endpoint_change_requires_key");
      const key = a.key === undefined ? prior?.key : a.key;
      if (typeof key !== "string" || key.length < 1 || key.length > 8192 || /[\s\x00-\x1f\x7f]/.test(key)) fail("api_key_required");
      return { id: authId, kind: "api_key" as const, models, baseUrl, key };
    });
    unique(auth.map(x => x.id));
    return { runtime: "codex-tui" as const, auth };
  });
  unique(runtimes.map(x => x.runtime));
  return { id: providerId, label: p.label.trim(), enabled: p.enabled, runtimes };
}

// Read through a no-follow fd and enforce owner-only, single-link files. Never
// repair a foreign/linked file as a side effect of a read operation.
function readPrivateJson(path: string): unknown {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail("unsafe_private_file");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = fstatSync(fd);
    if (stat.ino !== before.ino || stat.dev !== before.dev || stat.nlink !== 1
      || (process.getuid && stat.uid !== process.getuid())
      || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
      || stat.size > 4 * 1024 * 1024) fail("unsafe_private_file");
    try { return JSON.parse(readFileSync(fd, "utf8")); } catch { fail("invalid_private_state"); }
  } finally { closeSync(fd); }
}

export class DaemonProviderStore {
  private readonly root: string;
  private readonly scope: Scope;
  constructor(daemonDir: string) {
    // Caller resolves the daemon by registered config, never by a client-supplied
    // arbitrary storage root. Symlinked directories fail closed.
    if (realpathSync(daemonDir) !== resolve(daemonDir)) fail("unsafe_daemon_directory");
    const dir = lstatSync(daemonDir);
    if (!dir.isDirectory() || (process.getuid && dir.uid !== process.getuid())
      || (process.platform !== "win32" && (dir.mode & 0o022) !== 0)) fail("unsafe_daemon_directory");
    const config = object(readPrivateJson(join(daemonDir, "config.json")));
    if (config.role !== "host_supervisor") fail("not_a_daemon");
    if (typeof config.network_id !== "string" || !config.network_id
      || typeof config.node_id !== "string" || !config.node_id) fail("daemon_identity_required");
    this.scope = { network_id: config.network_id, daemon_node_id: config.node_id };
    this.root = join(daemonDir, "provider-store");
    if (existsSync(this.root)) this.checkRoot();
  }
  private checkRoot(): void {
    const dir = lstatSync(this.root);
    if (dir.isSymbolicLink() || !dir.isDirectory() || (process.getuid && dir.uid !== process.getuid())
      || (process.platform !== "win32" && (dir.mode & 0o077) !== 0)) fail("unsafe_provider_directory");
  }
  private read(): State {
    if (!existsSync(this.root)) return { ...this.scope, schema: 1, revision: 0, providers: [] };
    this.checkRoot();
    const path = join(this.root, "state.json");
    if (!existsSync(path)) return { ...this.scope, schema: 1, revision: 0, providers: [] };
    const state = object(readPrivateJson(path));
    if (state.schema !== 1 || !Number.isSafeInteger(state.revision) || Number(state.revision) < 0
      || !Array.isArray(state.providers) || state.providers.length > 100) fail("invalid_private_state");
    if (state.network_id !== this.scope.network_id || state.daemon_node_id !== this.scope.daemon_node_id) fail("scope_mismatch");
    const providers = state.providers.map(x => parseProvider(x));
    unique(providers.map(x => x.id));
    const receipt = state.last_write as State['last_write'];
    if (receipt && (typeof receipt.request_id !== 'string' || !/^dps_[a-f0-9-]{36}$/.test(receipt.request_id)
      || typeof receipt.input_hash !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.input_hash)
      || receipt.revision !== state.revision)) fail('invalid_private_state');
    return { ...this.scope, schema: 1, revision: state.revision as number, providers, ...(receipt ? { last_write: receipt } : {}) };
  }
  private publicState(state: State) {
    return { ...this.scope, revision: state.revision, source: "daemon" as const,
      // Configured does not mean logged in, entitled, probed or applied to a node.
      providers: state.providers.map(p => ({ id: p.id, label: p.label, enabled: p.enabled,
        runtimes: p.runtimes.map(r => ({ runtime: r.runtime, auth: r.auth.map(a => ({
          id: a.id, kind: a.kind, models: [...a.models],
          ...(a.baseUrl ? { baseUrl: a.baseUrl } : {}),
          ...(a.account_id ? { account_id: a.account_id } : {}),
          credential_present: a.kind === "api_key" || !!(a.account_id && this.savedAccountPresent(a.account_id)), verification: "not_checked" as const,
          application: "not_applied" as const,
        })) })) })) };
  }
  list() { return this.publicState(this.read()); }
  /** Presence only, never entitlement. Resolve an opaque saved-login ID solely
   * inside this daemon's owned directory; callers cannot supply a credential path. */
  private savedAccountPresent(id: string): boolean {
    if (!accountId(id)) return false;
    const root = join(this.root, 'codex-logins');
    try {
      const stat = lstatSync(root);
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(root) !== resolve(root)
        || (process.getuid && stat.uid !== process.getuid()) || (process.platform !== 'win32' && (stat.mode & 0o077))) return false;
      for (const child of readdirSync(root, { withFileTypes: true })) {
        if (!child.isDirectory() || !/^login-[A-Za-z0-9]+$/.test(child.name)) continue;
        const home = join(root, child.name), dir = lstatSync(home);
        if (realpathSync(home) !== resolve(home) || (process.getuid && dir.uid !== process.getuid())
          || (process.platform !== 'win32' && (dir.mode & 0o077))) continue;
        try {
          const record = readPrivateJson(join(home, 'anet-account.json')) as any;
          if (record.version !== 1 || record.account_id !== id || record.network_id !== this.scope.network_id
            || record.daemon_node_id !== this.scope.daemon_node_id) continue;
          const auth = readPrivateJson(join(home, 'auth.json')) as any;
          return !!auth && auth.auth_mode === 'chatgpt' && !!auth.tokens && typeof auth.tokens.access_token === 'string'
            && !!auth.tokens.access_token && typeof auth.tokens.refresh_token === 'string' && !!auth.tokens.refresh_token;
        } catch { /* incomplete or unsafe account is not bindable */ }
      }
    } catch { /* absent/unsafe login root is not a credential */ }
    return false;
  }
  /** Internal daemon bootstrap; this private path must never enter Hub replies. */
  prepareLoginDirectory() {
    ensurePrivateDirectory(this.root);
    this.checkRoot();
    const root = join(this.root, 'codex-logins');
    if (existsSync(root)) {
      const stat = lstatSync(root);
      if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(root) !== resolve(root)) fail('unsafe_login_directory');
    }
    ensurePrivateDirectory(root);
    return { ...this.scope, root };
  }
  /** Local application lease. Secrets stay inside the daemon callback, never in list/scan. */
  async withApiKey<T>(selection: { revision: number; providerId: string; authId: string; model: string },
    apply: (profile: { providerId: string; authId: string; model: string; baseUrl: string; key: string }) => Promise<T>): Promise<T> {
    if (!Number.isSafeInteger(selection.revision) || selection.revision < 0) fail('invalid_revision');
    if (!existsSync(this.root)) fail('provider_not_found');
    this.checkRoot();
    const lock = join(this.root, 'write.lock');
    let fd: number;
    try { fd = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); }
    catch { fail('provider_store_busy'); }
    try {
      const state = this.read();
      if (state.revision !== selection.revision) fail('revision_conflict');
      const provider = state.providers.find(p => p.id === selection.providerId);
      if (!provider?.enabled) fail('provider_not_enabled');
      const auth = provider.runtimes.find(r => r.runtime === 'codex-tui')?.auth.find(a => a.id === selection.authId);
      if (!auth || auth.kind !== 'api_key' || !auth.key || !auth.baseUrl) fail('api_key_profile_required');
      if (!auth.models.includes(selection.model)) fail('model_not_configured');
      return await apply({ providerId: provider.id, authId: auth.id, model: selection.model, baseUrl: auth.baseUrl, key: auth.key });
    } finally { closeSync(fd); unlinkSync(lock); }
  }
  upsert(value: unknown, expectedRevision: number, requestId?: string) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail("invalid_revision");
    if (requestId !== undefined && !/^dps_[a-f0-9-]{36}$/.test(requestId)) fail('invalid_request');
    if (existsSync(this.root)) this.checkRoot();
    else ensurePrivateDirectory(this.root);
    this.checkRoot();
    const lock = join(this.root, "write.lock");
    let fd: number;
    try { fd = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); }
    catch { fail("provider_store_busy"); }
    try {
      const state = this.read();
      const inputHash = createHash('sha256').update(JSON.stringify([expectedRevision, value])).digest('hex');
      if (requestId && state.last_write?.request_id === requestId) {
        if (state.last_write.input_hash !== inputHash) fail('request_conflict');
        return this.publicState(state); // Durable receipt makes a lost acknowledgement replay harmless.
      }
      if (state.revision !== expectedRevision) fail("revision_conflict");
      const providerId = id(object(value).id);
      const provider = parseProvider(value, state.providers.find(p => p.id === providerId));
      for (const runtime of provider.runtimes) for (const auth of runtime.auth) {
        if (auth.account_id && !this.savedAccountPresent(auth.account_id)) fail('saved_account_unavailable');
      }
      const index = state.providers.findIndex(p => p.id === provider.id);
      if (index < 0) {
        if (state.providers.length >= 100) fail("provider_limit");
        state.providers.push(provider);
      } else state.providers[index] = provider;
      if (state.revision >= Number.MAX_SAFE_INTEGER) fail("revision_limit");
      state.revision++;
      delete state.last_write;
      if (requestId) state.last_write = { request_id: requestId, input_hash: inputHash, revision: state.revision };
      if (Buffer.byteLength(JSON.stringify(state, null, 2) + "\n") > 4 * 1024 * 1024) fail("provider_store_too_large");
      atomicWritePrivateJson(join(this.root, "state.json"), state);
      return this.publicState(this.read());
    } finally { closeSync(fd); unlinkSync(lock); }
  }
}
