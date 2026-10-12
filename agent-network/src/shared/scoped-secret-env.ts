// Private environment source consumed at process startup, never a public API.
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { validScopedSecretKey } from './scoped-secret-contract';
export function scopedSecretJson(path: string): any {
  const before = lstatSync(path), fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || before.isSymbolicLink() || s.nlink !== 1 || s.dev !== before.dev || s.ino !== before.ino
      || s.size > 4 * 1024 * 1024 || (process.getuid && s.uid !== process.getuid())
      || (process.platform !== 'win32' && (s.mode & 0o077))) throw Error('unsafe_secret_file');
    try { return JSON.parse(readFileSync(fd, 'utf8')); } catch { throw Error('invalid_secret_state'); }
  } finally { closeSync(fd); }
}
export function readScopedNodeEnv(nodeDir: string): Record<string, string> {
  const marker = join(nodeDir, 'secrets-source.json');
  if (!existsSync(marker)) return {};
  const ref = scopedSecretJson(marker), config = scopedSecretJson(join(nodeDir, 'config.json'));
  if (ref.schema !== 1 || typeof ref.daemon_dir !== 'string' || !ref.node_id || !ref.network_id
    || config.node_id !== ref.node_id || config.network_id !== ref.network_id) throw Error('secret_scope_mismatch');
  const dir = lstatSync(ref.daemon_dir);
  if (!dir.isDirectory() || realpathSync(ref.daemon_dir) !== resolve(ref.daemon_dir)
    || (process.getuid && dir.uid !== process.getuid()) || (process.platform !== 'win32' && (dir.mode & 0o022))) throw Error('unsafe_secret_directory');
  const daemon = scopedSecretJson(join(ref.daemon_dir, 'config.json'));
  if (daemon.role !== 'host_supervisor' || daemon.network_id !== ref.network_id
    || daemon.node_id !== ref.daemon_node_id) throw Error('secret_scope_mismatch');
  if (ref.adopted_request_id) {
    const registry = scopedSecretJson(join(dirname(dirname(ref.daemon_dir)), 'child-workdirs.json'));
    const entry = Object.hasOwn(registry, ref.alias) ? registry[ref.alias] : null;
    if (entry?.adopted !== true || entry.node_id !== ref.node_id || entry.request_id !== ref.adopted_request_id
      || resolve(entry.nodeDir) !== resolve(nodeDir)) throw Error('secret_binding_revoked');
  }
  const path = join(ref.daemon_dir, 'scoped-secrets.json');
  if (!existsSync(path)) return {};
  const s = scopedSecretJson(path);
  if (s.schema !== 1 || s.network_id !== ref.network_id || s.daemon_node_id !== ref.daemon_node_id
    || !Number.isSafeInteger(s.revision) || s.revision < 0
    || !s.defaults || !s.nodes || Array.isArray(s.defaults) || Array.isArray(s.nodes)) throw Error('invalid_secret_state');
  const env = { ...s.defaults, ...(s.nodes[ref.node_id] ?? {}) };
  if (Object.entries(env).some(([k,v]) => !validScopedSecretKey(k)
    || typeof v !== 'string' || !v || Buffer.byteLength(v) > 8192 || v.includes('\0'))) throw Error('invalid_secret_state');
  return env;
}
