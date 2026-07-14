// RFC-030 Stage 2 — production Codex TUI launcher.
//
// The TUI is an actual `codex --remote` process running behind a PTY
// (`util-linux script`).  The bearer is passed only through the pinned
// environment slot; it never appears in argv or logs.  Child environment
// inheritance is deny-by-construction: the caller must supply the frozen
// record produced by buildAllowlistEnv, and this module re-validates the
// exact five-key allowlist before spawning.

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import type { Writable } from "node:stream";
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

interface LinuxProcessIdentity {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly sid: number;
  readonly startTime: string;
}

interface OwnedProcessGroup {
  readonly pgid: number;
  readonly sid: number;
  readonly members: Map<string, LinuxProcessIdentity>;
}

function parseLinuxProcessStat(stat: string): LinuxProcessIdentity | null {
  const open = stat.indexOf("(");
  const close = stat.lastIndexOf(")");
  if (open <= 0 || close <= open) return null;
  const pid = Number(stat.slice(0, open).trim());
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  // fields starts at proc(5) field 3 (state); starttime is field 22.
  const ppid = Number(fields[1]);
  const pgid = Number(fields[2]);
  const sid = Number(fields[3]);
  const startTime = fields[19];
  if (
    !Number.isSafeInteger(pid) || pid <= 1 ||
    !Number.isSafeInteger(ppid) || ppid < 0 ||
    !Number.isSafeInteger(pgid) || pgid <= 1 ||
    !Number.isSafeInteger(sid) || sid <= 1 ||
    typeof startTime !== "string" || !/^\d+$/.test(startTime)
  ) {
    return null;
  }
  return { pid, ppid, pgid, sid, startTime };
}

function readLinuxProcessIdentity(pid: number): LinuxProcessIdentity | null {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid <= 1) {
    return null;
  }
  try {
    const identity = parseLinuxProcessStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
    return identity?.pid === pid ? identity : null;
  } catch {
    return null;
  }
}

function sameProcessIdentity(
  expected: LinuxProcessIdentity,
  actual: LinuxProcessIdentity | null,
): boolean {
  return actual !== null &&
    actual.pid === expected.pid &&
    actual.startTime === expected.startTime;
}

function isLinuxDescendantOf(
  candidate: LinuxProcessIdentity,
  ancestor: LinuxProcessIdentity,
): boolean {
  let current: LinuxProcessIdentity | null = candidate;
  const visited = new Set<number>();
  while (current !== null && !visited.has(current.pid)) {
    if (sameProcessIdentity(ancestor, current)) return true;
    visited.add(current.pid);
    if (current.ppid <= 1) return false;
    current = readLinuxProcessIdentity(current.ppid);
  }
  return false;
}

function validateLinuxOwnershipHandshake(
  statLine: string,
  wrapper: LinuxProcessIdentity,
): LinuxProcessIdentity {
  const reported = parseLinuxProcessStat(statLine);
  if (reported === null || reported.pid === wrapper.pid) {
    throw stableLauncherError("tui_codex_identity_invalid");
  }
  const current = readLinuxProcessIdentity(reported.pid);
  if (
    current === null ||
    !sameProcessIdentity(reported, current) ||
    current.ppid !== reported.ppid ||
    current.pgid !== reported.pgid ||
    current.sid !== reported.sid ||
    current.pgid !== current.pid ||
    current.sid !== current.pid
  ) {
    throw stableLauncherError("tui_codex_identity_changed");
  }
  if (!isLinuxDescendantOf(current, wrapper)) {
    throw stableLauncherError("tui_codex_identity_not_descendant");
  }
  return current;
}

function processIdentityKey(identity: LinuxProcessIdentity): string {
  return `${identity.pid}:${identity.startTime}`;
}

function createOwnedProcessGroup(identity: LinuxProcessIdentity): OwnedProcessGroup {
  return {
    pgid: identity.pgid,
    sid: identity.sid,
    members: new Map([[processIdentityKey(identity), identity]]),
  };
}

function sameOwnedGroupMember(
  expected: LinuxProcessIdentity,
  actual: LinuxProcessIdentity | null,
  group: Pick<OwnedProcessGroup, "pgid" | "sid">,
): boolean {
  return sameProcessIdentity(expected, actual) &&
    actual?.pgid === group.pgid && actual.sid === group.sid;
}

function listLinuxProcessIdentities(): LinuxProcessIdentity[] {
  if (process.platform !== "linux") return [];
  let names: string[];
  try {
    names = readdirSync("/proc");
  } catch {
    return [];
  }
  const identities: LinuxProcessIdentity[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const identity = readLinuxProcessIdentity(Number(name));
    if (identity !== null) identities.push(identity);
  }
  return identities;
}

/**
 * Refresh only while at least one starttime-pinned member is still live.
 * This prevents a recycled PGID/SID from being adopted after the owned group
 * has disappeared, while still capturing every same-group descendant before
 * TERM/KILL is sent.
 */
function refreshOwnedProcessGroup(group: OwnedProcessGroup): boolean {
  const hasPinnedLiveMember = [...group.members.values()].some((member) => {
    const current = readLinuxProcessIdentity(member.pid);
    return sameOwnedGroupMember(member, current, group);
  });
  if (!hasPinnedLiveMember) return false;

  for (const identity of listLinuxProcessIdentities()) {
    if (identity.pgid === group.pgid && identity.sid === group.sid) {
      group.members.set(processIdentityKey(identity), identity);
    }
  }
  return true;
}

function ownedProcessGroupGone(group: OwnedProcessGroup): boolean {
  refreshOwnedProcessGroup(group);
  return ![...group.members.values()].some((member) => {
    const current = readLinuxProcessIdentity(member.pid);
    return sameOwnedGroupMember(member, current, group);
  });
}

function signalOwnedProcessGroup(
  group: OwnedProcessGroup,
  signal: NodeJS.Signals,
): void {
  if (!refreshOwnedProcessGroup(group)) return;
  const failure = signal === "SIGTERM" ? "tui_term_failed" : "tui_kill_failed";
  try {
    process.kill(-group.pgid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ESRCH") return;
    throw stableLauncherError(failure);
  }
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

async function waitUntil(deadline: number, predicate: () => boolean): Promise<boolean> {
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(GROUP_POLL_MS, Math.max(1, deadline - Date.now())));
    });
  }
  return predicate();
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
  private wrapperIdentity: LinuxProcessIdentity | null = null;
  private codexIdentity: LinuxProcessIdentity | null = null;
  private readonly log: (message: string) => void;
  private readonly resolveExited: () => void;
  private readonly rejectExited: (reason: Error) => void;
  private exitedSettled = false;
  private terminalFailure: Error | null = null;

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
      if (process.platform === "linux" && this.wrapperIdentity === null) {
        // Identity acquisition failed before any validated payload exec. Kill
        // only the ChildProcess handle we created; never guess at a PGID.
        try {
          child.kill("SIGTERM");
        } catch {
          throw stableLauncherError("tui_term_failed");
        }
        if (await waitUntil(
          Date.now() + TUI_TERM_GRACE_MS,
          () => this.terminalObserved,
        )) return;
        try {
          child.kill("SIGKILL");
        } catch {
          throw stableLauncherError("tui_kill_failed");
        }
        if (await waitUntil(
          Date.now() + TUI_TERM_GRACE_MS,
          () => this.terminalObserved,
        )) return;
        throw stableLauncherError("tui_kill_timeout");
      }
      if (process.platform !== "linux") {
        if (processGroupGone(child, this.terminalObserved)) return;
        signalProcessGroup(child, "SIGTERM");
        if (await waitForProcessGroupGone(
          child,
          () => this.terminalObserved,
          TUI_TERM_GRACE_MS,
        )) return;
        signalProcessGroup(child, "SIGKILL");
        if (await waitForProcessGroupGone(
          child,
          () => this.terminalObserved,
          TUI_TERM_GRACE_MS,
        )) return;
        throw stableLauncherError("tui_kill_timeout");
      }

      const wrapperGroup = this.wrapperIdentity === null
        ? null
        : createOwnedProcessGroup(this.wrapperIdentity);
      const codexGroup = this.codexIdentity === null
        ? null
        : createOwnedProcessGroup(this.codexIdentity);
      const codexGone = (): boolean => codexGroup === null || ownedProcessGroupGone(codexGroup);
      const wrapperGone = (): boolean =>
        wrapperGroup === null || ownedProcessGroupGone(wrapperGroup);
      const allGone = (): boolean =>
        codexGone() && wrapperGone() && this.terminalObserved;

      // The PTY-side Codex is in a different process group from util-linux
      // `script`.  Always stop that real group first so `script` can reap its
      // child; killing the wrapper first can orphan an unkillable zombie.
      if (codexGroup !== null && !codexGone()) {
        signalOwnedProcessGroup(codexGroup, "SIGTERM");
      }
      let wrapperTermSentAt: number | null = null;
      const termDeadline = Date.now() + TUI_TERM_GRACE_MS;
      if (await waitUntil(termDeadline, () => {
        if (codexGone() && !wrapperGone() && wrapperGroup !== null) {
          if (wrapperTermSentAt === null) {
            signalOwnedProcessGroup(wrapperGroup, "SIGTERM");
            wrapperTermSentAt = Date.now();
          }
        }
        return allGone();
      })) return;

      if (codexGroup !== null && !codexGone()) {
        signalOwnedProcessGroup(codexGroup, "SIGKILL");
      }
      const killDeadline = Date.now() + TUI_TERM_GRACE_MS;
      let wrapperKillSent = false;
      if (await waitUntil(killDeadline, () => {
        if (codexGone() && !wrapperGone() && wrapperGroup !== null) {
          if (wrapperTermSentAt === null) {
            signalOwnedProcessGroup(wrapperGroup, "SIGTERM");
            wrapperTermSentAt = Date.now();
          }
          // Natural util-linux reap is normally immediate. Keep a small
          // bounded window for it, then reserve the rest of phase two for
          // the wrapper's final KILL/reap observation.
          if (
            !wrapperKillSent &&
            Date.now() >= Math.min(wrapperTermSentAt + 100, killDeadline - 250)
          ) {
            signalOwnedProcessGroup(wrapperGroup, "SIGKILL");
            wrapperKillSent = true;
          }
        }
        return allGone();
      })) return;
      throw stableLauncherError("tui_kill_timeout");
    })();
    this.groupCleanupPromise.then(
      () => {
        this.child = null;
        this.settleExited(this.terminalFailure ?? undefined);
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
      // On Linux the PTY shell reports its kernel identity over private fd 3
      // before exec. It uses shell builtins only, then closes the fd and
      // removes its temporary/PWD variables so the Codex env stays exact.
      const ownershipPrefix = process.platform === "linux"
        ? "IFS= read -r ANET_TUI_STAT < \"/proc/$$/stat\" || exit 125; " +
          "printf '%s\\n' \"$ANET_TUI_STAT\" >&3 || exit 125; " +
          "exec 3>&-; IFS= read -r ANET_TUI_GO <&4 || exit 125; " +
          "[ \"$ANET_TUI_GO\" = go ] || exit 125; " +
          "unset ANET_TUI_GO ANET_TUI_STAT PWD; exec 4<&-; "
        : "unset PWD; ";
      const command = `${ownershipPrefix}exec ${
        [identity.path, ...codexArgs].map(shellQuote).join(" ")
      }`;
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
          stdio: ["inherit", "pipe", "pipe", "pipe", "pipe"],
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
      const ownershipStream = child.stdio[3];
      const ownershipAck = child.stdio[4] as Writable | null | undefined;
      let launchSettled = false;
      let handshakeTimer: NodeJS.Timeout | null = null;
      const rejectLaunch = (code: string): void => {
        if (launchSettled) return;
        launchSettled = true;
        if (handshakeTimer !== null) clearTimeout(handshakeTimer);
        ownershipStream?.destroy();
        ownershipAck?.end();
        const error = stableLauncherError(code);
        this.terminalFailure = error;
        reject(error);
        void this.ensureGroupCleanup(child).catch(() => {});
      };
      const resolveLaunch = (): void => {
        if (launchSettled) return;
        launchSettled = true;
        if (handshakeTimer !== null) clearTimeout(handshakeTimer);
        this.log("[gateway] TUI child launched via PTY (approval=never; env allowlist enforced)");
        resolve({ spawned: true });
      };

      if (process.platform === "linux") {
        const wrapperIdentity = child.pid === undefined
          ? null
          : readLinuxProcessIdentity(child.pid);
        if (
          wrapperIdentity === null ||
          wrapperIdentity.pgid !== wrapperIdentity.pid ||
          wrapperIdentity.sid !== wrapperIdentity.pid
        ) {
          rejectLaunch("tui_wrapper_identity_invalid");
        } else {
          this.wrapperIdentity = wrapperIdentity;
          if (ownershipStream == null || ownershipAck == null) {
            rejectLaunch("tui_codex_identity_channel_missing");
          } else {
            let ownershipBytes = Buffer.alloc(0);
            ownershipStream.on("data", (chunk: Buffer | string) => {
              if (launchSettled) return;
              const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              ownershipBytes = Buffer.concat([ownershipBytes, bytes]);
              if (ownershipBytes.length > 1_024) {
                rejectLaunch("tui_codex_identity_oversized");
                return;
              }
              const newline = ownershipBytes.indexOf(0x0a);
              if (newline < 0) return;
              if (ownershipBytes.subarray(newline + 1).some((byte) => byte !== 0x0a)) {
                rejectLaunch("tui_codex_identity_trailing_data");
                return;
              }
              try {
                this.codexIdentity = validateLinuxOwnershipHandshake(
                  ownershipBytes.subarray(0, newline).toString("utf8"),
                  wrapperIdentity,
                );
              } catch (error) {
                rejectLaunch(
                  (error as Error & { code?: string })?.code ?? "tui_codex_identity_invalid",
                );
                return;
              }
              ownershipStream.destroy();
              ownershipBytes.fill(0);
              ownershipAck.end("go\n", () => resolveLaunch());
            });
            ownershipStream.once("error", () => {
              rejectLaunch("tui_codex_identity_channel_failed");
            });
            ownershipAck.once("error", () => {
              rejectLaunch("tui_codex_identity_ack_failed");
            });
            handshakeTimer = setTimeout(() => {
              rejectLaunch("tui_codex_identity_timeout");
            }, TUI_TERM_GRACE_MS);
          }
        }
      }
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
        if (process.platform === "linux" && !launchSettled) {
          rejectLaunch("tui_codex_identity_missing");
        }
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
        if (!launchSettled) rejectLaunch("tui_pty_spawn_error");
        if (child.pid === undefined) {
          this.terminalObserved = true;
          this.child = null;
          if (this.terminalFailure === null) {
            this.terminalFailure = stableLauncherError("tui_pty_spawn_error");
          }
          void this.ensureGroupCleanup(child).catch(() => {});
        }
      });
      child.once("spawn", () => {
        if (process.platform !== "linux") {
          ownershipStream?.destroy();
          ownershipAck?.end();
          resolveLaunch();
        }
      });
    });
  }

  terminate(): Promise<void> {
    if (this.child === null) {
      this.settleExited(this.terminalFailure ?? undefined);
      return new Promise<void>((resolve) => resolve());
    }
    return this.ensureGroupCleanup();
  }
}

export const __test = {
  buildCodexTuiArgs,
  groupExists,
  isLinuxDescendantOf,
  ownedProcessGroupGone,
  parseLinuxProcessStat,
  processGroupGone,
  readLinuxProcessIdentity,
  sameOwnedGroupMember,
  sameProcessIdentity,
  shellQuote,
  validateLaunchRequest,
  validateLinuxOwnershipHandshake,
};
