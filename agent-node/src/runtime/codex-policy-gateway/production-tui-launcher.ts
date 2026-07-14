// RFC-030 Stage 2 — production Codex TUI launcher.
//
// The TUI is an actual `codex --remote` process running behind a PTY
// (`util-linux script`).  The bearer is passed only through the pinned
// environment slot; it never appears in argv or logs.  Child environment
// inheritance is deny-by-construction: the caller must supply the frozen
// record produced by buildAllowlistEnv, and this module re-validates the
// exact five-key allowlist before spawning.

import { spawn, type ChildProcess } from "node:child_process";
import {
  SecretRedactor,
} from "./bearer";
import {
  assertCodexBinaryIdentity,
  resolveCodexBinaryIdentity,
  type CodexBinaryIdentity,
} from "./codex-binary";
import {
  TUI_BEARER_ENV_NAME,
  type LaunchOutcome,
  type LaunchRequest,
  type TuiChildLauncher,
} from "./tui-child-launcher";

export const PRODUCTION_TUI_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "CODEX_HOME",
  TUI_BEARER_ENV_NAME,
]);

export const TUI_TERM_GRACE_MS = 1_000;

export interface ProductionTuiLauncherOptions {
  readonly binary?: string;
  /** Provider-owned identity; when present it is authoritative over binary. */
  readonly identity?: CodexBinaryIdentity;
  readonly threadId?: string;
  readonly cwd?: string;
  readonly ptyBinary?: string;
  readonly log?: (message: string) => void;
  readonly writeStdout?: (chunk: Buffer) => void;
  readonly writeStderr?: (chunk: Buffer) => void;
}

function stableLauncherError(code: string): Error {
  const error = new Error(`codex TUI launcher failed (${code})`);
  (error as Error & { code?: string }).code = code;
  return error;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function validateLaunchRequest(req: LaunchRequest): void {
  const urlMatch = /^ws:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.exec(req.wsUrl);
  const port = urlMatch ? Number(urlMatch[1]) : 0;
  if (urlMatch === null || port > 65_535) {
    throw stableLauncherError("tui_remote_url_not_strict_loopback");
  }
  const keys = Object.keys(req.env);
  for (const key of keys) {
    if (!PRODUCTION_TUI_ENV_ALLOWLIST.has(key)) {
      throw stableLauncherError("tui_env_key_not_allowlisted");
    }
    if (typeof req.env[key] !== "string") {
      throw stableLauncherError("tui_env_value_not_string");
    }
  }
  const bearer = req.env[TUI_BEARER_ENV_NAME];
  if (typeof bearer !== "string" || bearer.length === 0) {
    throw stableLauncherError("tui_bearer_missing");
  }
}

function buildCodexTuiArgs(req: LaunchRequest, threadId?: string): string[] {
  const remote = [
    "--remote",
    req.wsUrl,
    "--remote-auth-token-env",
    TUI_BEARER_ENV_NAME,
    "-c",
    "check_for_update_on_startup=false",
    "-c",
    "approval_policy=never",
    "-c",
    "sandbox_mode=read-only",
  ];
  if (threadId) {
    // Captured Codex 0.144.0 form: `codex resume --remote <url> <thread>`.
    return ["resume", ...remote.slice(0, 2), threadId, ...remote.slice(2)];
  }
  return remote;
}

const GROUP_POLL_MS = 25;

function groupExists(pid: number): boolean {
  if (process.platform === "win32") return true;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

function processGroupGone(child: ChildProcess, terminalObserved: boolean): boolean {
  if (!terminalObserved) return false;
  const pid = child.pid;
  if (pid === undefined || process.platform === "win32") return true;
  return !groupExists(pid);
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  const failure = signal === "SIGTERM" ? "tui_term_failed" : "tui_kill_failed";
  if (pid === undefined) throw stableLauncherError(failure);
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ESRCH") return;
    throw stableLauncherError(failure);
  }
}

async function waitForProcessGroupGone(
  child: ChildProcess,
  terminalObserved: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processGroupGone(child, terminalObserved())) return true;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(GROUP_POLL_MS, Math.max(1, deadline - Date.now())));
    });
  }
  return processGroupGone(child, terminalObserved());
}

/**
 * Real launcher retained by the gateway handle until bounded teardown.
 * `launch` and `terminate` deliberately construct fresh base-realm native
 * Promises rather than returning a dependency-owned thenable.
 */
export class ProductionTuiLauncher implements TuiChildLauncher {
  private child: ChildProcess | null = null;
  private terminalObserved = false;
  private launchStarted = false;
  private groupCleanupPromise: Promise<void> | null = null;
  private readonly log: (message: string) => void;
  private readonly resolveExited: () => void;
  private readonly rejectExited: (reason: Error) => void;
  private exitedSettled = false;

  /**
   * Same-realm terminal fence.  It settles only after the wrapper has exited
   * AND its detached process group is gone (including descendants).
   */
  readonly exited: Promise<void>;

  constructor(private readonly opts: ProductionTuiLauncherOptions = {}) {
    this.log = (message: string): void => {
      try {
        opts.log?.(message);
      } catch {
        // Diagnostics are observational and cannot change ownership state.
      }
    };
    let resolveExited!: () => void;
    let rejectExited!: (reason: Error) => void;
    this.exited = new Promise<void>((resolve, reject) => {
      resolveExited = resolve;
      rejectExited = reject;
    });
    this.resolveExited = resolveExited;
    this.rejectExited = rejectExited;
    // Natural exits start cleanup without an external waiter.  Retain an
    // internal rejection handler so a bounded cleanup failure never becomes
    // an unhandled rejection; external observers still see the rejection.
    void this.exited.catch(() => {});
  }

  private settleExited(error?: Error): void {
    if (this.exitedSettled) return;
    this.exitedSettled = true;
    if (error === undefined) this.resolveExited();
    else this.rejectExited(error);
  }

  private ensureGroupCleanup(child: ChildProcess | null = this.child): Promise<void> {
    if (this.groupCleanupPromise !== null) return this.groupCleanupPromise;
    this.groupCleanupPromise = (async (): Promise<void> => {
      if (child === null || child.pid === undefined) return;
      if (processGroupGone(child, this.terminalObserved)) return;

      signalProcessGroup(child, "SIGTERM");
      if (
        await waitForProcessGroupGone(
          child,
          () => this.terminalObserved,
          TUI_TERM_GRACE_MS,
        )
      ) {
        return;
      }

      signalProcessGroup(child, "SIGKILL");
      if (
        await waitForProcessGroupGone(
          child,
          () => this.terminalObserved,
          TUI_TERM_GRACE_MS,
        )
      ) {
        return;
      }
      throw stableLauncherError("tui_kill_timeout");
    })();
    this.groupCleanupPromise.then(
      () => {
        this.child = null;
        this.settleExited();
      },
      (error) => {
        this.settleExited(
          error instanceof Error ? error : stableLauncherError("tui_group_cleanup_failed"),
        );
      },
    );
    return this.groupCleanupPromise;
  }

  launch(req: LaunchRequest): Promise<LaunchOutcome> {
    return new Promise<LaunchOutcome>((resolve, reject) => {
      if (this.launchStarted || this.child !== null) {
        reject(stableLauncherError("tui_already_launched"));
        return;
      }
      try {
        validateLaunchRequest(req);
      } catch (error) {
        reject(error);
        return;
      }

      const bearer = req.env[TUI_BEARER_ENV_NAME];
      const stdoutRedactor = new SecretRedactor(bearer);
      const stderrRedactor = new SecretRedactor(bearer);
      let identity: CodexBinaryIdentity;
      try {
        identity = assertCodexBinaryIdentity(
          this.opts.identity ?? resolveCodexBinaryIdentity(
            this.opts.binary ?? "codex",
            { env: req.env, cwd: this.opts.cwd },
          ),
        );
      } catch (error) {
        stdoutRedactor.wipe();
        stderrRedactor.wipe();
        reject(error);
        return;
      }
      const codexArgs = buildCodexTuiArgs(req, this.opts.threadId);
      // util-linux `script -c` invokes a shell which synthesizes PWD even
      // when the parent env is exact-allowlisted. Remove it inside that
      // shell before exec so the real Codex child still sees exactly the
      // five frozen keys (the four optional runtime keys + bearer).
      const command = `unset PWD; exec ${[identity.path, ...codexArgs].map(shellQuote).join(" ")}`;
      // The bearer is inherited by the PTY wrapper, so production must not
      // resolve that wrapper through caller-controlled PATH. Tests may inject
      // an explicit fixture; the default is the fixed util-linux location.
      let ptyIdentity: CodexBinaryIdentity;
      try {
        ptyIdentity = resolveCodexBinaryIdentity(
          this.opts.ptyBinary ?? "/usr/bin/script",
          { env: req.env, cwd: this.opts.cwd },
        );
      } catch {
        stdoutRedactor.wipe();
        stderrRedactor.wipe();
        reject(stableLauncherError("tui_pty_identity_failed"));
        return;
      }

      try {
        // Revalidate the provider-selected identity at the last synchronous
        // boundary before the PTY wrapper is spawned.
        identity = assertCodexBinaryIdentity(identity);
        ptyIdentity = assertCodexBinaryIdentity(ptyIdentity);
      } catch (error) {
        stdoutRedactor.wipe();
        stderrRedactor.wipe();
        reject(error);
        return;
      }

      let child: ChildProcess;
      try {
        this.launchStarted = true;
        child = spawn(ptyIdentity.path, ["-qec", command, "/dev/null"], {
          cwd: this.opts.cwd,
          env: { ...req.env },
          detached: true,
          stdio: ["inherit", "pipe", "pipe"],
        });
      } catch {
        stdoutRedactor.wipe();
        stderrRedactor.wipe();
        this.terminalObserved = true;
        this.settleExited();
        reject(stableLauncherError("tui_pty_spawn_throw"));
        return;
      }

      this.child = child;
      const writeOut = this.opts.writeStdout ?? ((chunk: Buffer) => process.stdout.write(chunk));
      const writeErr = this.opts.writeStderr ?? ((chunk: Buffer) => process.stderr.write(chunk));
      child.stdout?.on("data", (chunk: Buffer | string) => {
        writeOut(stdoutRedactor.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        writeErr(stderrRedactor.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      });
      child.once("exit", () => {
        this.terminalObserved = true;
        // The wrapper can exit before a same-group Codex/descendant.  Start
        // the single-flight group cleanup immediately; never equate this
        // event with terminal ownership.
        void this.ensureGroupCleanup(child).catch(() => {});
        const outTail = stdoutRedactor.finish();
        const errTail = stderrRedactor.finish();
        if (outTail.length > 0) writeOut(outTail);
        if (errTail.length > 0) writeErr(errTail);
        stdoutRedactor.wipe();
        stderrRedactor.wipe();
        this.log("[gateway] TUI child exited");
      });
      child.once("error", () => {
        stdoutRedactor.wipe();
        stderrRedactor.wipe();
        if (child.pid === undefined) {
          this.terminalObserved = true;
          this.child = null;
          this.settleExited();
          reject(stableLauncherError("tui_pty_spawn_error"));
        }
      });
      child.once("spawn", () => {
        this.log("[gateway] TUI child launched via PTY (approval=never; env allowlist enforced)");
        resolve({ spawned: true });
      });
    });
  }

  terminate(): Promise<void> {
    if (this.child === null) {
      this.settleExited();
      return new Promise<void>((resolve) => resolve());
    }
    return this.ensureGroupCleanup();
  }
}

export const __test = {
  buildCodexTuiArgs,
  groupExists,
  processGroupGone,
  shellQuote,
  validateLaunchRequest,
};
