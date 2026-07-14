// RFC-030 Stage 2 — spawn-only owner for the production Codex app-server.
//
// This module intentionally does not import/open CodexAppServerClient,
// CodexAppServerBridge, or the legacy direct runtime. It gates the exact
// binary/profile, spawns one isolated process group, waits for its loopback
// listener, and exposes bounded graceful/force teardown primitives.

import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, createServer } from "node:net";
import {
  CODEX_BINARY_IDENTITY_MISMATCH,
  assertCodexBinaryIdentity,
  resolveCodexBinaryIdentity,
  type CodexBinaryIdentity,
} from "./codex-binary";
import { assertPhase1Profile, PHASE1_PROFILE } from "./policy";
import { assertCodexBaseline } from "./version-gate";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_TERM_TIMEOUT_MS = 1_250;
// Final A bounds abort at one second, so the provider's force wait stays
// comfortably below that outer lifecycle bound.
const DEFAULT_KILL_TIMEOUT_MS = 500;
const READY_POLL_MS = 25;
const TCP_PROBE_TIMEOUT_MS = 150;

export const OWNED_CODEX_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "CODEX_HOME",
]);

type ProviderErrorCode =
  | "owned_upstream_port_failed"
  | "owned_upstream_binary_identity_failed"
  | "owned_upstream_baseline_failed"
  | "owned_upstream_spawn_throw"
  | "owned_upstream_spawn_failed"
  | "owned_upstream_start_timeout"
  | "owned_upstream_term_failed"
  | "owned_upstream_kill_failed"
  | "owned_upstream_kill_timeout";

type ProviderDiagnosticCode =
  | "owned_upstream_gate_begin"
  | "owned_upstream_gate_passed"
  | "owned_upstream_spawned"
  | "owned_upstream_ready"
  | "owned_upstream_exit"
  | "owned_upstream_exit_callback_failed"
  | "owned_upstream_term_sent"
  | "owned_upstream_kill_sent";

class OwnedCodexUpstreamError extends Error {
  readonly code: ProviderErrorCode;

  constructor(code: ProviderErrorCode) {
    super(code);
    this.name = "OwnedCodexUpstreamError";
    this.code = code;
  }
}

export interface OwnedCodexUpstreamExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface SpawnOwnedCodexUpstreamOptions {
  readonly binary?: string;
  /** Isolated workspace used both for relative resolution and the child. */
  readonly cwd?: string;
  /** Stable diagnostics only: code + locally generated correlation. */
  readonly log?: (message: string) => void;
  readonly onExit?: (info: OwnedCodexUpstreamExit) => void;
  readonly startupTimeoutMs?: number;
  readonly termTimeoutMs?: number;
  readonly killTimeoutMs?: number;
  /**
   * Tests may inject an equivalent gate around a fake executable. Production
   * assembly never supplies this seam and always executes assertCodexBaseline.
   */
  readonly baselineGate?: (binary: string) => Promise<unknown>;
  /** Tests may provide a source env; output is still exact-allowlisted. */
  readonly env?: NodeJS.ProcessEnv;
}

export interface OwnedCodexUpstream {
  readonly url: string;
  /** Canonical executable actually gated and spawned; path is inside it. */
  readonly identity: CodexBinaryIdentity;
  shutdown: () => Promise<void>;
  abort: () => Promise<void>;
}

function stableError(code: ProviderErrorCode): OwnedCodexUpstreamError {
  return new OwnedCodexUpstreamError(code);
}

function buildOwnedCodexArgs(url: string): string[] {
  return [
    "app-server",
    "-c",
    `approval_policy=${PHASE1_PROFILE.approvalPolicy}`,
    "-c",
    `sandbox_mode=${PHASE1_PROFILE.sandboxMode}`,
    "--listen",
    url,
  ];
}

function buildOwnedCodexEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = Object.create(null);
  for (const key of OWNED_CODEX_ENV_ALLOWLIST) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor === undefined || !("value" in descriptor)) continue;
    const value = descriptor.value;
    if (typeof value !== "string") continue;
    // Even an allowlisted slot cannot smuggle a CommHub bearer under an
    // innocuous key. Both current and backward-compatible token prefixes are
    // kept out of Codex.
    if (/(?:^|[^0-9A-Za-z])(?:ntok|atok)_[0-9A-Za-z]/.test(value)) continue;
    output[key] = value;
  }
  return output;
}

async function allocateLoopbackPort(): Promise<number> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, LOOPBACK_HOST, () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw stableError("owned_upstream_port_failed");
    }
    return address.port;
  } catch (error) {
    if (error instanceof OwnedCodexUpstreamError) throw error;
    throw stableError("owned_upstream_port_failed");
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}

async function tcpProbe(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: LOOPBACK_HOST, port });
    let settled = false;
    const finish = (ready: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(TCP_PROBE_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function groupExists(pid: number): boolean {
  if (process.platform === "win32") return true;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

function processGroupGone(child: ChildProcess, terminalObserved: () => boolean): boolean {
  const pid = child.pid;
  if (pid === undefined || process.platform === "win32") return terminalObserved();
  return !groupExists(pid);
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) throw stableError(
    signal === "SIGTERM" ? "owned_upstream_term_failed" : "owned_upstream_kill_failed",
  );
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ESRCH") return;
    throw stableError(
      signal === "SIGTERM" ? "owned_upstream_term_failed" : "owned_upstream_kill_failed",
    );
  }
}

async function waitForProcessGroup(
  child: ChildProcess,
  terminalObserved: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const pid = child.pid;
  if (pid === undefined) return terminalObserved();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (process.platform === "win32") {
      if (terminalObserved()) return true;
    } else if (terminalObserved() && !groupExists(pid)) {
      return true;
    }
    await delay(Math.min(READY_POLL_MS, Math.max(1, deadline - Date.now())));
  }
  return process.platform === "win32"
    ? terminalObserved()
    : terminalObserved() && !groupExists(pid);
}

/**
 * Gate and spawn the one owned Codex upstream. The outer native async
 * function guarantees a same-realm base Promise at the public boundary.
 */
export async function spawnOwnedCodexUpstream(
  opts: SpawnOwnedCodexUpstreamOptions = {},
): Promise<OwnedCodexUpstream> {
  const binary = opts.binary ?? "codex";
  const log = opts.log ?? (() => {});
  let diagnosticSequence = 0;
  const report = (code: ProviderDiagnosticCode): void => {
    const correlation = `provider-${++diagnosticSequence}`;
    try {
      log(`code=${code} correlation=${correlation}`);
    } catch {
      // Observational diagnostics never influence ownership or teardown.
    }
  };

  // Both gates run before port allocation, spawn, or any listener probe.
  assertPhase1Profile(PHASE1_PROFILE);
  const env = buildOwnedCodexEnv(opts.env ?? process.env);
  let identity: CodexBinaryIdentity;
  try {
    identity = resolveCodexBinaryIdentity(binary, { env, cwd: opts.cwd });
  } catch {
    throw stableError("owned_upstream_binary_identity_failed");
  }
  report("owned_upstream_gate_begin");
  try {
    if (opts.baselineGate !== undefined) {
      await opts.baselineGate(identity.path);
    } else {
      await assertCodexBaseline(identity.path, {
        binaryIdentity: identity,
        env,
      });
    }
  } catch (error) {
    if ((error as { code?: unknown })?.code === CODEX_BINARY_IDENTITY_MISMATCH) {
      throw stableError("owned_upstream_binary_identity_failed");
    }
    throw stableError("owned_upstream_baseline_failed");
  }
  report("owned_upstream_gate_passed");

  const port = await allocateLoopbackPort();
  const url = `ws://${LOOPBACK_HOST}:${port}`;
  const args = buildOwnedCodexArgs(url);

  try {
    // Re-stat immediately before spawn.  Spawn receives only the canonical
    // absolute path, never a second PATH lookup.
    assertCodexBinaryIdentity(identity);
  } catch {
    throw stableError("owned_upstream_binary_identity_failed");
  }

  let child: ChildProcess;
  try {
    child = spawn(identity.path, args, {
      cwd: opts.cwd,
      detached: process.platform !== "win32",
      env,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    throw stableError("owned_upstream_spawn_throw");
  }

  let terminal = false;
  let spawnError = false;
  const terminalObserved = (): boolean => terminal;
  child.once("error", () => {
    spawnError = true;
    terminal = true;
  });
  child.once("exit", (code, signal) => {
    terminal = true;
    report("owned_upstream_exit");
    try {
      opts.onExit?.({ code, signal });
    } catch {
      report("owned_upstream_exit_callback_failed");
    }
  });
  report("owned_upstream_spawned");

  const killTimeoutMs = opts.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS;
  const forceStop = async (): Promise<void> => {
    if (terminal && child.pid === undefined) return;
    signalProcessGroup(child, "SIGKILL");
    report("owned_upstream_kill_sent");
    if (!(await waitForProcessGroup(child, terminalObserved, killTimeoutMs))) {
      throw stableError("owned_upstream_kill_timeout");
    }
  };

  const startupTimeoutMs = opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const startupDeadline = Date.now() + startupTimeoutMs;
  let ready = false;
  while (!terminal && Date.now() < startupDeadline) {
    if (await tcpProbe(port)) {
      if (terminal) break;
      ready = true;
      break;
    }
    await delay(Math.min(READY_POLL_MS, Math.max(1, startupDeadline - Date.now())));
  }
  if (!ready) {
    try {
      if (!terminal || !processGroupGone(child, terminalObserved)) await forceStop();
    } catch {
      // Startup failure remains primary and the outer caller still fails
      // closed. The force operation itself is bounded.
    }
    throw stableError(spawnError ? "owned_upstream_spawn_failed" : "owned_upstream_start_timeout");
  }
  report("owned_upstream_ready");

  let shutdownOperation: Promise<void> | null = null;
  let abortOperation: Promise<void> | null = null;

  const shutdown = async (): Promise<void> => {
    if (shutdownOperation === null) {
      shutdownOperation = (async (): Promise<void> => {
        // The group, not only its leader, is the owned resource. A leader can
        // exit while a same-group descendant remains alive.
        if (terminal && processGroupGone(child, terminalObserved)) return;
        signalProcessGroup(child, "SIGTERM");
        report("owned_upstream_term_sent");
        const termTimeoutMs = opts.termTimeoutMs ?? DEFAULT_TERM_TIMEOUT_MS;
        if (await waitForProcessGroup(child, terminalObserved, termTimeoutMs)) return;
        await forceStop();
      })();
    }
    await shutdownOperation;
  };

  const abort = async (): Promise<void> => {
    if (abortOperation === null) {
      abortOperation = (async (): Promise<void> => {
        if (terminal && processGroupGone(child, terminalObserved)) return;
        await forceStop();
      })();
    }
    await abortOperation;
  };

  return { url, identity, shutdown, abort };
}

export const __test = {
  buildOwnedCodexArgs,
  buildOwnedCodexEnv,
  groupExists,
};
