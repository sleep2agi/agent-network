// #906 existing CLI lifecycle adapter. No shell, arbitrary remote paths or PID kills.
import { basename, dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { providerNodeRevision, readProviderNodeConfig, readProviderNodeToml, type ProviderApplicationLifecycle, type ProviderApplicationRequest } from './daemon-provider-application';
import { DaemonProviderError } from './daemon-provider-store';
import { receiptVerdict } from './codex-lifecycle-receipt';
import { verifyChatgptAppserver } from './daemon-provider-account-readback';

export type ProviderCliRunner = (argv: string[], cwd: string, timeout: number) => Promise<string>;
export function providerCliRunner(binary: string, script: string, env: NodeJS.ProcessEnv): ProviderCliRunner {
  // The caller supplies the already pinned executable, not a Hub-provided path.
  const clean = { ...env };
  for (const key of ['CODEX_HOME', 'ANET_NODE_MARKER', 'ANET_COPRESENCE_BRIDGE', 'TMUX', 'TMUX_PANE', 'NODE_OPTIONS',
    'OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL']) delete clean[key];
  return (argv, cwd, timeout) => new Promise((ok, bad) => {
    execFile(binary, [script, ...argv], { cwd, env: clean, timeout, maxBuffer: 1024 * 1024, encoding: 'utf8', windowsHide: true },
      (error, stdout) => error ? bad(new DaemonProviderError('node_lifecycle_failed')) : ok(stdout));
  });
}

export function providerApplicationLifecycle(nodeDir: string, request: ProviderApplicationRequest,
  run: ProviderCliRunner, authorizeIdle: () => Promise<void>): ProviderApplicationLifecycle {
  const nodes = dirname(nodeDir), workdir = dirname(dirname(nodes));
  if (basename(nodes) !== 'nodes' || basename(dirname(nodes)) !== '.anet') throw new DaemonProviderError('unsupported_node_layout');
  const initial = readProviderNodeConfig(nodeDir);
  const toml = readProviderNodeToml(nodeDir);
  const oldProvider = initial.codexModelProvider ?? toml.model_provider ?? 'openai';
  const oldModel = initial.model ?? toml.model;
  if (typeof oldProvider !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(oldProvider)
    || typeof oldModel !== 'string' || !oldModel.trim()) throw new DaemonProviderError('original_runtime_selection_unknown');
  // Keep the current session and launch permissions. Never turn an unrelated
  // runtime or external/shared app-server into a managed co-presence node.
  if (initial.node_id !== request.nodeId || initial.network_id !== request.networkId
    || (initial.alias ?? initial.node_name) !== request.alias || initial.runtime !== 'codex-app-server'
    || initial.codexCopresence !== true || typeof initial.codexThreadId !== 'string' || !initial.codexThreadId
    || (initial.codexProjectDir && resolve(initial.codexProjectDir) !== resolve(workdir))) {
    throw new DaemonProviderError('unsupported_node_lifecycle');
  }
  const verify = async (startedAt: number) => {
    const raw = await run(['node', 'codex', 'verify', request.nodeId, '--json'], workdir, 45_000);
    let receipt: any;
    try { receipt = JSON.parse(raw); } catch { throw new DaemonProviderError('node_verification_failed'); }
    if (receipt?.format !== 'anet-codex-lifecycle-receipt/1' || receipt.verb !== 'verify'
      || receipt.nodeId !== request.nodeId || receipt.alias !== request.alias || receipt.verdict !== 'PASS'
      || !Array.isArray(receipt.checks) || receiptVerdict('verify', receipt.checks).verdict !== 'PASS'
      || !Number.isFinite(Date.parse(receipt.startedAt)) || Date.parse(receipt.startedAt) < startedAt) {
      throw new DaemonProviderError('node_verification_failed');
    }
    const config = readProviderNodeConfig(nodeDir), verification = config.codexRecoveryVerification;
    if (config.node_id !== request.nodeId || config.network_id !== request.networkId
      || config.codexThreadId !== initial.codexThreadId || verification?.threadId !== initial.codexThreadId
      || verification.method !== 'thread/resume' || !Number.isFinite(Date.parse(verification.verifiedAt))
      || Date.parse(verification.verifiedAt) < startedAt) throw new DaemonProviderError('runtime_application_unconfirmed');
    return { config, verification };
  };
  const start = async (restore = false) => {
    const startedAt = Date.now();
    const argv = ['node', 'start', request.nodeId, '--copresence', '--tui-first', '--no-inherit-codex-home'];
    // Resuming a thread can retain its new provider even after old TOML is
    // restored. Explicit, non-persisted overrides restore the original pair.
    if (restore) argv.push('--codex-model-provider', oldProvider, '--model', oldModel);
    if (initial.codexCopresenceFullAccess === true) argv.push('--dangerously-allow-full-access', '--yes-danger-full-access');
    await run(argv, workdir, 240_000);
    return verify(startedAt);
  };
  return {
    preflight: authorizeIdle,
    stopVerified: async () => { await run(['node', 'stop', request.nodeId], workdir, 60_000); },
    activate: async () => {
      const { config, verification } = await start();
      return { nodeId: config.node_id, model: verification.model, runtimeProvider: verification.modelProvider,
        nodeRevision: providerNodeRevision(nodeDir) };
    },
    verifyChatgpt: async () => {
      const config = readProviderNodeConfig(nodeDir);
      if (config.node_id !== request.nodeId || config.network_id !== request.networkId
        || !Number.isSafeInteger(config.codexAppServerPort) || config.codexAppServerPort < 1 || config.codexAppServerPort > 65535) {
        throw new DaemonProviderError('runtime_account_unconfirmed');
      }
      await verifyChatgptAppserver(`ws://127.0.0.1:${config.codexAppServerPort}`);
    },
    restore: async () => {
      const { verification } = await start(true);
      if (verification.modelProvider !== oldProvider || verification.model !== oldModel) {
        throw new DaemonProviderError('runtime_restore_unconfirmed');
      }
    },
  };
}
