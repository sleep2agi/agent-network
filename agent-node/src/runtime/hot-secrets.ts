// #5675 PR-3 — In-memory hot secret activation for agent-node.
//
// Design invariants (per ANet负责人 review):
// 1. Four explicit activation states:
//      - 'hot_applied'       : env updated in memory right now; any owned resident child
//                              exited cleanly so the next turn uses the new value immediately.
//      - 'hot_pending_idle'  : node is currently executing a turn; update queued and applied
//                              automatically as soon as the active turn finishes (without
//                              killing or interrupting the in-flight turn).
//      - 'shadowed'          : key is overridden by startup outer process.env, legacy
//                              secrets.env, or config.json `env` (plain string or different-name
//                              _envRef). Editing the secrets store cannot take effect even
//                              after restart, so surface 'shadowed' instead of 'next_start'.
//      - 'next_start'        : runtime does not support hot secret activation (e.g. OpenCode V2
//                              copresence/shared serve, claude-code-cli, shared codex-app-server,
//                              grok-build-cli, or host_supervisor daemon).
// 2. Phase-1 hot-activation capability (`secrets_hot_capable`) is advertised ONLY for the 5
//    agent-node-spawned runtimes:
//      claude-agent-sdk, codex-sdk, codex-app-server (owned subprocess only),
//      grok-acp (not grok-build-cli), antigravity-acp.
// 3. Daemon (host_supervisor) NEVER mutates its own process.env (zero cross-child key leakage).
// 4. Deletion ONLY removes keys tracked in `managedSecretKeys` — never deletes outer/system env.
// 5. Secret values NEVER enter logs, warnings, errors, or Hub reports (key names only).

import type { ChildProcess } from 'node:child_process';
import { readScopedNodeEnv } from '../shared/scoped-secret-env.js';

export const SECRET_ACTIVATION_STATES = [
  'next_start',
  'hot_applied',
  'hot_pending_idle',
  'shadowed',
] as const;

export type SecretActivation = (typeof SECRET_ACTIVATION_STATES)[number];

export function isValidSecretActivation(v: unknown): v is SecretActivation {
  return typeof v === 'string' && (SECRET_ACTIVATION_STATES as readonly string[]).includes(v);
}

export interface HotSecretCapabilityInput {
  role?: string | null;
  runtime: string;
  grokExecutionMode?: 'acp' | 'cli';
  /** Non-empty when codex-app-server attaches to an external/shared server rather than owning a child. */
  codexAppServerUrl?: string | null;
  hasNodeSecretsDir: boolean;
  hasNodeIdentity: boolean;
}

/**
 * Determine whether this node advertises `secrets_hot_capable: true`.
 * Explicitly excludes:
 * - host_supervisor daemon (must never modify its own process.env)
 * - opencode (V2 copresence / shared serve holds model credentials outside agent-node)
 * - claude-code-cli (TUI copresence runs outside agent-node; never reaches here, also false)
 * - shared/external codex-app-server (`codexAppServerUrl` set)
 * - grok-build-cli (CLI / PTY copresence)
 */
export function isHotSecretActivationSupported(input: HotSecretCapabilityInput): boolean {
  if (!input.hasNodeSecretsDir || !input.hasNodeIdentity) return false;
  if (input.role === 'host_supervisor') return false;
  switch (input.runtime) {
    case 'claude': // claude-agent-sdk
      return true;
    case 'codex': // codex-sdk (and owned codex-stdio)
      return true;
    case 'codex-app-server': // owned subprocess only
      return !input.codexAppServerUrl;
    case 'grok': // grok-acp only (exclude grok-build-cli / TUI copresence)
      return input.grokExecutionMode !== 'cli';
    case 'antigravity': // antigravity-acp
      return true;
    case 'opencode':
    default:
      return false;
  }
}

/**
 * Compute the immutable set of keys that shadow the node/daemon secret store at startup:
 * - Any key already present in `initialEnvKeys` (outer shell / systemd / legacy secrets.env)
 * - Any key explicitly set in `config.json` `env` as a plain string, OR as `{ _envRef: OTHER }`
 *   where `OTHER !== key`.
 *   Note: same-name `{ _envRef: key }` intentionally consumes the scoped/node secret store
 *   (covered by test1053 / test1075), so it is NOT shadowed.
 */
export function computeBootShadowedKeys(opts: {
  initialEnvKeys: Iterable<string>;
  configEnv?: Record<string, unknown> | null;
}): Set<string> {
  const shadowed = new Set<string>(opts.initialEnvKeys);
  if (opts.configEnv && typeof opts.configEnv === 'object' && !Array.isArray(opts.configEnv)) {
    for (const [k, v] of Object.entries(opts.configEnv)) {
      if (typeof v === 'string') {
        shadowed.add(k);
      } else if (v && typeof v === 'object' && typeof (v as any)._envRef === 'string') {
        if ((v as any)._envRef !== k) shadowed.add(k);
      }
    }
  }
  return shadowed;
}

/**
 * Gracefully stop an owned resident child process and wait for it to actually exit,
 * so the old process cannot serve future turns with stale credentials.
 */
export async function terminateOwnedChildProcess(
  proc: ChildProcess | null | undefined,
  graceMs = 2000,
): Promise<void> {
  if (!proc) return;
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let hardTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (hardTimer) clearTimeout(hardTimer);
      proc.removeListener('exit', finish);
      proc.removeListener('close', finish);
      resolve();
    };
    proc.once('exit', finish);
    proc.once('close', finish);
    try {
      proc.kill('SIGTERM');
    } catch {
      finish();
      return;
    }
    killTimer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
      hardTimer = setTimeout(finish, 500);
      hardTimer.unref?.();
    }, graceMs);
    killTimer.unref?.();
  });
}

export interface HotSecretApplyRequest {
  action: 'put' | 'delete' | 'reload';
  key?: string;
}

export interface HotSecretControllerDeps {
  nodeDir: string;
  env: NodeJS.ProcessEnv;
  shadowedKeys: ReadonlySet<string>;
  initialManagedKeys: Iterable<string>;
  hotCapable: boolean;
  isBusy: () => boolean;
  /** Defaults to readScopedNodeEnv(nodeDir) — reads real persisted 0600 store from disk. */
  readMergedEnv?: (nodeDir: string) => Record<string, string>;
  /**
   * Invoked after managed env keys changed while idle (or when flushing pending updates on idle):
   * - Reset cached SDK clients / close owned resident subprocesses while preserving session/thread IDs.
   * Receives changed key NAMES only (never values).
   */
  onEnvApplied?: (changedKeys: readonly string[]) => Promise<void> | void;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
}

export interface HotSecretController {
  applyAfterPersist(req: HotSecretApplyRequest): Promise<SecretActivation>;
  flushPendingOnIdle(): Promise<boolean>;
  hasPending(): boolean;
  isShadowed(key: string): boolean;
  managedKeysSnapshot(): string[];
}

export function createHotSecretController(deps: HotSecretControllerDeps): HotSecretController {
  const managedKeys = new Set<string>(deps.initialManagedKeys);
  const readMerged = deps.readMergedEnv ?? readScopedNodeEnv;
  const log = deps.log ?? (() => {});
  const warn = deps.warn ?? (() => {});

  let pendingApply = false;
  let syncChain: Promise<void> = Promise.resolve();

  const syncEnvNow = (): Promise<void> => {
    const run = syncChain.then(async () => {
      const merged = readMerged(deps.nodeDir);
      const changed: string[] = [];

      // 1. Apply added/updated keys that are NOT shadowed by startup env/config.
      for (const [k, v] of Object.entries(merged)) {
        if (deps.shadowedKeys.has(k)) continue;
        if (deps.env[k] !== v) {
          deps.env[k] = v;
          changed.push(k);
        }
        managedKeys.add(k);
      }

      // 2. Delete ONLY keys that belong to `managedKeys` and are no longer in the merged store.
      //    Outer / system / config.json env keys are NEVER touched.
      for (const k of [...managedKeys]) {
        if (!Object.prototype.hasOwnProperty.call(merged, k)) {
          if (!deps.shadowedKeys.has(k) && Object.prototype.hasOwnProperty.call(deps.env, k)) {
            delete deps.env[k];
            changed.push(k);
          }
          managedKeys.delete(k);
        }
      }

      pendingApply = false;

      if (changed.length > 0 && deps.onEnvApplied) {
        await deps.onEnvApplied(changed);
      }
      if (changed.length > 0) {
        log(`[hot-secrets] applied keys=[${changed.sort().join(',')}]`);
      }
    });
    // Never let a rejected sync poison subsequent syncs, and never leak secret values in warnings.
    syncChain = run.catch(() => {
      warn('[hot-secrets] sync failed; falling back to next_start');
    });
    return run;
  };

  return {
    async applyAfterPersist(req: HotSecretApplyRequest): Promise<SecretActivation> {
      // 1. Shadowed check FIRST: even after a full restart, startup env/config would still win.
      if (req.key && deps.shadowedKeys.has(req.key)) {
        log(`[hot-secrets] key=${req.key} shadowed by startup env/config`);
        return 'shadowed';
      }
      // 2. Runtime capability gate.
      if (!deps.hotCapable) {
        return 'next_start';
      }
      // 3. Busy gate: defer without disturbing the in-flight turn.
      if (deps.isBusy()) {
        pendingApply = true;
        log(`[hot-secrets] deferred until idle${req.key ? ` key=${req.key}` : ''}`);
        return 'hot_pending_idle';
      }
      // 4. Idle: apply immediately in-process + cycle any owned resident child.
      try {
        await syncEnvNow();
        return 'hot_applied';
      } catch {
        warn('[hot-secrets] hot apply failed; fallback to next_start');
        return 'next_start';
      }
    },

    async flushPendingOnIdle(): Promise<boolean> {
      if (!pendingApply || !deps.hotCapable || deps.isBusy()) return false;
      try {
        await syncEnvNow();
        return true;
      } catch {
        warn('[hot-secrets] deferred hot apply failed; fallback to next_start');
        return false;
      }
    },

    hasPending(): boolean {
      return pendingApply;
    },

    isShadowed(key: string): boolean {
      return deps.shadowedKeys.has(key);
    },

    managedKeysSnapshot(): string[] {
      return [...managedKeys].sort();
    },
  };
}
