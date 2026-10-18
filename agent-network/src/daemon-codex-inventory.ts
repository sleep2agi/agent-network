// #906: read-only discovery, separate from the managed Provider store. The Hub
// supplies identity/alias only; filesystem locations come from LOCAL registries.
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { parse } from 'smol-toml';
import { codexLoginFactsFromText, isCodexNodeConfig } from './codex-node-login';
import { resolveNodeCodexHome } from './codex-home-enforce';
import { providerNodeRevision } from './daemon-provider-application';

const obj = (v: any): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const name = (v: unknown): v is string => typeof v === 'string' && /^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,99}$/u.test(v);
const identifier = (v: unknown): string | null => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(v) ? v : null;
function directory(path: string, readOnly = false) {
  if (realpathSync(path) !== resolve(path)) throw Error('unsafe_directory');
  const s = lstatSync(path);
  if (!s.isDirectory() || (process.getuid && s.uid !== process.getuid())) throw Error('unsafe_directory');
  if (process.platform !== 'win32' && (s.mode & 0o022)) {
    // Legacy nodes directories can be 0775 underneath a private 0700 .anet.
    // Read-only discovery may traverse that inaccessible-to-others tree;
    // application keeps the original stricter directory requirement.
    if (!readOnly) throw Error('unsafe_directory');
    let parent = dirname(path), protectedTree = false;
    for (let depth = 0; depth < 32 && parent !== dirname(parent); depth++, parent = dirname(parent)) {
      if (realpathSync(parent) !== resolve(parent)) throw Error('unsafe_directory');
      const p = lstatSync(parent);
      if (!p.isDirectory() || (process.getuid && p.uid !== process.getuid())) break;
      if (!(p.mode & 0o077)) { protectedTree = true; break; }
    }
    if (!protectedTree) throw Error('unsafe_directory');
  }
}
function read(path: string, credential = false, readOnly = false): string | null {
  try {
    directory(dirname(path), readOnly);
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink()) throw Error('unsafe_file');
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const s = fstatSync(fd);
      if (s.ino !== before.ino || s.dev !== before.dev || s.nlink !== 1 || s.size > 256 * 1024
        || (process.getuid && s.uid !== process.getuid())
        || (process.platform !== 'win32' && (s.mode & (credential ? 0o077 : 0o022)))) throw Error('unsafe_file');
      return readFileSync(fd, 'utf8');
    } finally { closeSync(fd); }
  } catch (e: any) { if (e.code === 'ENOENT') return null; throw Error('unreadable'); }
}
function homeFacts(home: string) {
  let config: Record<string, any> = {}, configStatus = 'missing';
  try { const text = read(join(home, 'config.toml'), false, true); if (text !== null) { config = obj(parse(text)); configStatus = 'read'; } }
  catch { configStatus = 'unreadable'; }
  const selected = identifier(config.model_provider);
  const providers = Object.keys(obj(config.model_providers)).filter(k => identifier(k)).slice(0, 100);
  if (selected && !providers.includes(selected)) providers.push(selected);
  let authKind = 'unknown', credentialStatus = 'unknown', account: string | null = null;
  // keyring/ephemeral can be valid without a file. Never call a missing file a logout.
  if (!config.cli_auth_credentials_store || config.cli_auth_credentials_store === 'file') {
    try {
      const raw = read(join(home, 'auth.json'), true, true);
      if (raw !== null) {
        const facts = codexLoginFactsFromText(raw);
        authKind = facts.kind === 'api-key' ? 'api_key' : facts.kind === 'chatgpt' ? 'chatgpt' : 'unknown';
        credentialStatus = facts.loggedIn ? 'present' : 'unknown';
        account = facts.accountFingerprint; // no email, token or refresh-chain fingerprint
      }
    } catch { credentialStatus = 'unreadable'; }
  }
  const provider = obj(obj(config.model_providers)[selected ?? '']);
  if (provider.requires_openai_auth !== true && typeof provider.env_key === 'string') {
    authKind = 'api_key'; credentialStatus = 'unknown'; account = null;
    // env_key is a reference, NOT evidence the launch process has its value.
  }
  return { config_status: configStatus, configured_provider: selected, configured_model: identifier(config.model),
    provider_ids: providers, auth_kind: authKind, credential_status: credentialStatus,
    account_fingerprint: account, verification: 'not_checked', effective_state: 'not_checked' };
}

/** Local registry resolution shared by discovery/application; no remote path. */
export function resolveDaemonProviderTarget(nodesDir: string, target: { node_id: string; alias: string }, networkId: string, readOnly = false) {
  if (!name(target.alias) || !identifier(target.node_id)) throw Error('invalid_target');
  const root = dirname(dirname(nodesDir));
  const registry = obj(JSON.parse(read(join(root, '.anet', 'child-workdirs.json'), false, readOnly) ?? '{}'));
  const entry = Object.hasOwn(registry, target.alias) ? registry[target.alias] : undefined;
  let candidates: string[];
  if (entry && typeof entry === 'object' && entry.adopted === true) {
    if (entry.node_id !== target.node_id || typeof entry.nodeDir !== 'string' || !isAbsolute(entry.nodeDir)) throw Error('identity_mismatch');
    candidates = [entry.nodeDir];
  } else {
    if (entry !== undefined && (typeof entry !== 'string' || !isAbsolute(entry))) throw Error('invalid_registry');
    const localRoot = entry ? join(entry, '.anet', 'nodes') : nodesDir;
    directory(localRoot, readOnly);
    const names = readdirSync(localRoot).filter(name);
    if (names.length > 1000) throw Error('registry_limit');
    candidates = names.map(n => join(localRoot, n));
  }
  const matches: { dir: string; config: Record<string, any> }[] = [];
  for (const dir of candidates) {
    try {
      const config = obj(JSON.parse(read(join(dir, 'config.json'), false, readOnly) ?? '{}'));
      if (config.node_id === target.node_id && (config.alias ?? config.node_name) === target.alias
        && (!config.network_id || config.network_id === networkId)) matches.push({ dir, config });
    } catch { /* inaccessible unrelated node is never read further */ }
  }
  if (matches.length !== 1) throw Error('target_unavailable');
  return matches[0];
}

export function scanDaemonCodex(nodesDir: string, targets: unknown, networkId: string, hostHome = homedir(), discoverLocal = false) {
  if (!Array.isArray(targets) || targets.length > 200 || targets.some(t => !name(t?.alias) || !identifier(t?.node_id)
    || Object.keys(t).some(k => !['node_id', 'alias'].includes(k)))
    || new Set(targets.map(t => t.node_id)).size !== targets.length) throw Error('invalid_scan_targets');
  const rows = targets.map(target => {
    const base = { node_id: target.node_id, alias: target.alias };
    try {
      const { dir, config } = resolveDaemonProviderTarget(nodesDir, target, networkId, true);
      if (!isCodexNodeConfig(config)) return { ...base, status: 'not_codex' };
      const resolved = resolveNodeCodexHome({ nodeDir: dir, config });
      const home = resolved.codexHome ?? join(hostHome, '.codex');
      // An opaque reference distinguishes homes without disclosing machine paths.
      const homeRef = createHash('sha256').update(resolve(home)).digest('hex').slice(0, 16);
      let configRevision: string | null = null;
      if (config.network_id === networkId && config.runtime === 'codex-app-server' && resolved.codexHome === resolve(dir, 'codex-home')) {
        try { resolveDaemonProviderTarget(nodesDir, target, networkId); configRevision = providerNodeRevision(dir); } catch { /* scan remains useful; mutation unavailable */ }
      }
      return { ...base, status: 'observed', runtime: identifier(config.runtime), home_ref: homeRef,
        home_source: resolved.source === 'none' ? 'host_default' : resolved.source,
        ...homeFacts(home), node_configured_model: identifier(config.model), config_revision: configRevision };
    } catch { return { ...base, status: 'unavailable' }; }
  });
  const inventory = { observed_at: Date.now(), scope: 'hub_bound_nodes', rows };
  if (!discoverLocal) return inventory;
  return { ...inventory, local_discovery: discoverLocalCodex(nodesDir, targets, networkId, hostHome) };
}

/** Same local workspace/registered child workdirs only. No adoption or mutation. */
function discoverLocalCodex(nodesDir: string, bound: { node_id: string; alias: string }[], networkId: string, hostHome: string) {
  try {
    const registry = obj(JSON.parse(read(join(dirname(nodesDir), 'child-workdirs.json'), false, true) ?? '{}'));
    const roots = new Set([nodesDir]);
    const direct: string[] = [];
    for (const entry of Object.values(registry)) {
      if (typeof entry === 'string' && isAbsolute(entry)) roots.add(join(entry, '.anet', 'nodes'));
      else if (entry && typeof entry === 'object' && entry.adopted === true && typeof entry.nodeDir === 'string' && isAbsolute(entry.nodeDir)) direct.push(entry.nodeDir);
    }
    const candidates = new Set(direct);
    for (const root of roots) {
      directory(root, true);
      const names = readdirSync(root).filter(name);
      if (names.length > 1000 || candidates.size + names.length > 1000) return { status: 'limit', rows: [] };
      for (const alias of names) candidates.add(join(root, alias));
    }
    const seen = new Set(bound.map(t => t.node_id));
    const found: any[] = [];
    for (const dir of candidates) {
      let config: Record<string, any>;
      try { config = obj(JSON.parse(read(join(dir, 'config.json'), false, true) ?? '{}')); } catch { continue; }
      const alias = config.alias ?? config.node_name;
      if (config.network_id !== networkId || !identifier(config.node_id) || !name(alias)
        || config.role === 'host_supervisor' || !isCodexNodeConfig(config) || seen.has(config.node_id)) continue;
      seen.add(config.node_id);
      const resolved = resolveNodeCodexHome({ nodeDir: dir, config });
      const home = resolved.codexHome ?? join(hostHome, '.codex');
      found.push({ node_id: config.node_id, alias, status: 'observed', runtime: identifier(config.runtime),
        home_ref: createHash('sha256').update(resolve(home)).digest('hex').slice(0, 16),
        home_source: resolved.source === 'none' ? 'host_default' : resolved.source,
        ...homeFacts(home), node_configured_model: identifier(config.model), config_revision: null });
      if (found.length > 200) return { status: 'limit', rows: [] };
    }
    return { status: 'observed', rows: found };
  } catch { return { status: 'unavailable', rows: [] }; }
}
