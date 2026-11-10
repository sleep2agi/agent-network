// Independent node secrets for the claude-code channel-server.
//
// `node-server.ts` is the only long-lived process a `claude-code-cli` node owns;
// the agent-node chain (`agent-node/src/runtime/node-secrets.ts`) cannot reach
// it. This file copies that module's semantics **verbatim** (parity is pinned by
// `node-server-secrets-parity.test.ts`) and only swaps the transport plumbing:
//
//   hub SSE `node_secrets` doorbell
//     → `pull_daemon_provider_snapshots {accept_node_secrets:true}` (nsk_*)
//     → read/modify/write `<node dir>/node-secrets.json`
//     → `ack_daemon_provider_snapshot {request_id, snapshot}` (or `failed:true`)
//
// 🔴 Safety boundary (same as agent-node):
//   * the node directory is fixed by the caller (`dirname(configPath)`), never
//     taken from a request — hub requests carry no path field;
//   * values are never logged, echoed in errors, or returned by `list`;
//   * every identity/action/revision check fails closed with a stable code.
import { closeSync, existsSync, openSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { scopedSecretJson, readIndependentNodeEnv } from "./shared/scoped-secret-env";
import { validScopedSecretKey } from "./shared/scoped-secret-contract";
import { atomicWritePrivateJson } from "./private-state";
import { readNodeSecretKeys } from "./node-secret-file";

/** Hub's node-secret request id. `nsk_` distinguishes it from `dsk_` daemon scope. */
export const NODE_SECRET_REQUEST_RE = /^nsk_[a-f0-9-]{36}$/;

export type NodeSecretAction = "list" | "put" | "delete";

/** Fixed local identity of the node this process serves. */
export interface NodeSecretScope {
  nodeDir: string;
  nodeId: string;
  networkId: string;
}

/**
 * Resolve the node dir/ids from the config file node-server already reports.
 * Returns null (⇒ capability omitted, requests ignored) on any unsafe/unreadable
 * config — never guesses a directory.
 */
export function resolveNodeSecretScope(configPath: string | undefined | null): NodeSecretScope | null {
  if (!configPath) return null;
  try {
    const config = scopedSecretJson(configPath);
    if (typeof config.node_id !== "string" || !config.node_id
      || typeof config.network_id !== "string" || !config.network_id) return null;
    return { nodeDir: dirname(configPath), nodeId: config.node_id, networkId: config.network_id };
  } catch {
    return null;
  }
}

const project = (config: any, state: any) => ({
  network_id: config.network_id,
  daemon_node_id: null,
  node_id: config.node_id,
  revision: state.revision,
  activation: "next_start",
  keys: Object.keys(state.values).sort().map((key) => ({ key, source: "node" })),
});

/** list/put/delete over the node's private store, mirroring agent-node's `operateNodeSecrets`. */
export function operateNodeSecrets(nodeDir: string, input: any) {
  const config = scopedSecretJson(join(nodeDir, "config.json"));
  if (!config.node_id || !config.network_id || input?.node_id !== config.node_id || input.network_id !== config.network_id
    || input.daemon_node_id !== null || !NODE_SECRET_REQUEST_RE.test(input.request_id)
    || !["list", "put", "delete"].includes(input.action)) throw Error("invalid_secret_request");
  const path = join(nodeDir, "node-secrets.json");
  const read = () => {
    // Validate real permissions, durable identity and values before any write.
    const values = readIndependentNodeEnv(nodeDir);
    return existsSync(path) ? { ...scopedSecretJson(path), values } : { schema: 1,
      node_id: config.node_id, network_id: config.network_id, revision: 0, values };
  };
  if (input.action === "list") return project(config, read());
  if (!validScopedSecretKey(input.key) || !Number.isSafeInteger(input.revision) || input.revision < 0
    // `"\\0"` (literal backslash-zero) is intentionally byte-for-byte what
    // agent-node checks — parity matters more than "fixing" it here. The Hub
    // rejects a real NUL in `requestNodeSecrets` before a request is queued.
    || (input.action === "put" && (typeof input.value !== "string" || !input.value || Buffer.byteLength(input.value) > 8192 || input.value.includes("\\0")))) throw Error("invalid_secret_input");
  const lock = join(nodeDir, ".node-secrets.lock");
  const fd = openSync(lock, "wx", 0o600);
  try {
    const s = read();
    const digest = createHash("sha256").update(JSON.stringify([input.action, input.key, input.value ?? null, input.revision])).digest("hex");
    if (s.last?.request_id === input.request_id) {
      if (s.last.digest !== digest) throw Error("secret_replay_conflict");
      return project(config, s);
    }
    if (s.revision !== input.revision || s.revision === Number.MAX_SAFE_INTEGER) throw Error("secret_revision_conflict");
    if (input.action === "put") s.values[input.key] = input.value; else delete s.values[input.key];
    if (Object.keys(s.values).length > 128) throw Error("secret_store_limit");
    s.revision++; s.last = { request_id: input.request_id, digest };
    atomicWritePrivateJson(path, s);
    return project(config, read());
  } finally { closeSync(fd); unlinkSync(lock); }
}

export interface NodeSecretsDoorbellDeps {
  callCommHub: (method: string, params: Record<string, unknown>) => Promise<any>;
  /** null ⇒ this process has no stable node dir/identity; requests are ignored. */
  scope: NodeSecretScope | null;
  log: (msg: string) => void;
  warn: (msg: string) => void;
}

/** Pull pending node-secret requests and acknowledge each one. */
const running = new Map<string, { again: boolean; promise: Promise<void> }>();

export function reconcileNodeSecrets(deps: NodeSecretsDoorbellDeps): Promise<void> {
  const scope = deps.scope;
  if (!scope) return Promise.resolve();
  const key = JSON.stringify([scope.networkId, scope.nodeId]);
  const old = running.get(key);
  if (old) { old.again = true; return old.promise; }
  const state = { again: false, promise: Promise.resolve() };
  state.promise = (async () => {
    do {
      state.again = false;
      const pending = await deps.callCommHub("pull_daemon_provider_snapshots", { accept_node_secrets: true });
      if (!pending?.ok || !Array.isArray(pending.requests)) return;
      for (const r of pending.requests.slice(0, 20)) {
        if (!NODE_SECRET_REQUEST_RE.test(r.request_id) || r.network_id !== scope.networkId
          || r.node_id !== scope.nodeId || r.daemon_node_id !== null || r.expires_at <= Date.now()) continue;
        let snapshot;
        try {
          snapshot = operateNodeSecrets(scope.nodeDir, r);
        } catch (e: any) {
          deps.warn(`[node-secrets] ${String(r.action)} rejected (${r.request_id}): ${String(e?.message || e).slice(0, 200)}`);
          await deps.callCommHub("ack_daemon_provider_snapshot", { request_id: r.request_id, failed: true });
          continue;
        }
        await deps.callCommHub("ack_daemon_provider_snapshot", { request_id: r.request_id, snapshot });
        // Names/counts only — the request may carry a value.
        deps.log(`[node-secrets] ${String(r.action)} revision=${snapshot.revision} keys=${snapshot.keys.length} (${r.request_id})`);
      }
    } while (state.again);
  })().catch(() => deps.warn("[node-secrets] management request unconfirmed"))
    .finally(() => running.delete(key));
  running.set(key, state);
  return state.promise;
}

/** SSE dispatch: consume a `node_secrets` doorbell, return true; everything else returns false. */
export async function handleNodeSecretsEvent(event: { type?: unknown } | null | undefined, deps: NodeSecretsDoorbellDeps): Promise<boolean> {
  if (!event || event.type !== "node_secrets") return false;
  if (!deps.scope) {
    deps.warn("[node-secrets] doorbell ignored: node dir/config identity unavailable");
    return true;
  }
  deps.log("[node-secrets] doorbell received");
  await drainNodeSecrets(deps, "doorbell");
  return true;
}

/** Connect/reconnect catch-up: a request pushed while SSE was down is still pending on the hub. */
export async function drainNodeSecrets(deps: NodeSecretsDoorbellDeps, why: string): Promise<void> {
  try {
    await reconcileNodeSecrets(deps);
  } catch (e: any) {
    deps.warn(`[node-secrets] ${why} handler failed: ${String(e?.message || e).slice(0, 200)}`);
  }
}

/** Hub report_status accepts at most 50 names, each matching `/^[A-Z_][A-Z0-9_]{0,63}$/`. */
export const REPORTED_SECRET_KEYS_MAX = 50;
const REPORTED_SECRET_KEY_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;

/**
 * Names of the env keys this node will load on next start. Values are parsed
 * and dropped: `readIndependentNodeEnv` returns a map, but only `Object.keys`
 * leaves this function.
 */
export function collectReportedSecretKeys(nodeDir: string): string[] {
  let independent: string[] = [];
  try { independent = Object.keys(readIndependentNodeEnv(nodeDir)); } catch { /* fail closed: report no names */ }
  const legacy = readNodeSecretKeys(nodeDir);
  const envKeys = legacy.kind === "ok" ? legacy.keys : [];
  return [...new Set([...independent, ...envKeys])]
    .filter((key) => REPORTED_SECRET_KEY_RE.test(key))
    .sort()
    .slice(0, REPORTED_SECRET_KEYS_MAX);
}

/**
 * Fields to merge into `report_status`. The capability is advertised from the
 * durable config (same condition as agent-node), independent of whether a
 * secrets file exists yet — otherwise the UI could never offer the first write.
 */
export function nodeSecretsReportFields(scope: NodeSecretScope | null): {
  config_snapshot?: { node_secrets_capable: true };
  secret_keys?: string[];
} {
  if (!scope) return {};
  let secret_keys: string[] = [];
  try { secret_keys = collectReportedSecretKeys(scope.nodeDir); } catch { /* omit names, keep capability */ }
  return { config_snapshot: { node_secrets_capable: true }, secret_keys };
}
