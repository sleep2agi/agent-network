// #1313 / parent #1302 — Linux OBSERVATION PROVIDER for the host-shared OpenCode
// server: REAL PROCESS EVIDENCE, and nothing more.
//
// Scope split agreed with 通信牛 (2026-10-16): this module answers only "what
// process is really behind this loopback URL", read-only; generation BINDING and
// the reuse decision belong to #1302. An exact argv match, the executable path, a
// file named `opencode` and the caller's expectation are all *diagnostics* — none
// proves a generation — so no proven generation field exists here, and the argv
// shape is reported under `diagnostics` with a note saying what it does not prove.
//
// ONE chain, from ONE process, then re-verified:
//   /proc/net/tcp LISTEN inode for 127.0.0.1:<port>
//     → /proc/<pid>/fd/* "socket:[inode]"   (EVERY process is a candidate)
//     → /proc/<pid> uid (the HOLDER's own) | /proc/<pid>/stat start ticks
//     → /proc/<pid>/cmdline (diagnostic, never an attestation)
//   then inode/pid/uid/startTicks are read AGAIN and must be identical. Any drift,
//   permission wall or multi-candidate answer is an explicit failure (a stale
//   success is never returned; this module never throws), and a denial anywhere
//   means "unique holder" is unproven. No daemon wiring, no second registry, no
//   credential read, no `close` lifecycle: the types below are local.

import { readFileSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { basename } from "node:path";
import { opencodeBackendFor } from "./opencode-backend.js";
import { readLiveProcess } from "./opencode-copresence/launcher-health.js";

/** Why an observation could not be produced (every value is a refusal). */
export type HostSharedObserveReason =
  | "unsupported_platform"
  | "url_not_supported"
  | "no_listener"
  | "ambiguous_listener"
  | "socket_owner_not_found"
  | "permission_denied"
  | "identity_mismatch";

/**
 * DIAGNOSTIC ONLY. `argvContract` records which serve-argv shape was seen. It is
 * **not** proof of a generation: any process can be launched with any argv. A
 * consumer that needs a proven generation must bind it itself and refuse reuse
 * when it cannot (#1302) — never promote this field into a proven generation.
 */
export interface HostSharedServeDiagnostics {
  /** Executable behind the process when read from /proc/<pid>/exe, else null. */
  executable: string | null;
  /** `argv0` is caller-controlled and mutable: never the observed binary. */
  executableSource: "proc_exe" | "argv0" | null;
  /** Socket CREATOR uid (/proc/net/tcp) — NOT the holder's (inherited fds). */
  socketUid: number | null;
  /** argv from its `serve` token onward (empty when there is no `serve`). */
  argvTail: string[];
  /** Which serve-argv shape was seen. Diagnostic; never proves a generation. */
  argvContract: "v1" | "v2" | "none" | "ambiguous";
  /** Why `argvContract` is evidence of nothing on its own. */
  argvContractNote: string;
}

/** What the OS can prove about the process behind a loopback URL. */
export interface HostSharedProcessEvidence {
  /** The validated literal loopback URL this evidence is about. */
  url: string;
  /** 127.0.0.1 only: borrowing must never target a routable address. */
  host: "127.0.0.1";
  port: number;
  /** LISTEN socket inode the pid was bound through (identical in both reads). */
  listenInode: string;
  /** The single process holding that socket. */
  pid: number;
  /** uid owning /proc/<pid>. */
  uid: number;
  /** /proc/<pid>/stat start ticks — the defense against PID reuse. */
  startTicks: number;
  diagnostics: HostSharedServeDiagnostics;
}

export type HostSharedObserveResult =
  | { ok: true; processEvidence: HostSharedProcessEvidence }
  | { ok: false; reason: HostSharedObserveReason };

export interface LiveProc {
  pid: number;
  ticks: string;
  state: string;
}

/** Injectable /proc surface: defaults read the real filesystem. */
export interface HostSharedObserverDeps {
  platform?: NodeJS.Platform;
  readProcFile?: (path: string) => string;
  readDir?: (path: string) => string[];
  readLink?: (path: string) => string;
  procUid?: (pid: number) => number | undefined;
  liveProcess?: (pid: number) => LiveProc | undefined;
  /** The repo's single-source serve argv for a generation (diagnostics only). */
  serveArgsFor?: (generation: "v1" | "v2", host: string, port: number) => readonly string[];
  /** Executable basename accepted next to the argv block (a filter, not proof). */
  executableBasename?: string;
}

const LOOPBACK_HOST = "127.0.0.1";
const OPENCODE_BASENAME = "opencode";
const TCP_LISTEN = "0A";              // LISTEN state in /proc/net/tcp
const LOOPBACK_HEX = "0100007F";      // 127.0.0.1 little-endian, the only form observed
const CONTRACT_NOTE = "argv shape is a launch-argument diagnostic only: it cannot "
  + "prove a process's OpenCode generation — never promote it into one.";

function errCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function defaultDeps(): Required<HostSharedObserverDeps> {
  return {
    platform: process.platform,
    readProcFile: (path) => readFileSync(path, "utf8"),
    readDir: (path) => readdirSync(path),
    readLink: (path) => readlinkSync(path),
    procUid: (pid) => statSync(`/proc/${pid}`).uid,
    liveProcess: (pid) => {
      // Same /proc/<pid>/stat reader the launcher health uses (undefined if gone).
      const proc = readLiveProcess(pid);
      return proc ? { pid: proc.pid, ticks: proc.ticks, state: proc.state } : undefined;
    },
    serveArgsFor: (generation, host, port) =>
      opencodeBackendFor(generation).serveArgs({ hostname: host, port }),
    executableBasename: OPENCODE_BASENAME,
  };
}

function argvTailOf(argv: readonly string[]): string[] {
  const serveIndex = argv.lastIndexOf("serve");
  return serveIndex < 0 ? [] : argv.slice(serveIndex);
}

function argvContractOf(
  deps: Required<HostSharedObserverDeps>,
  argv: readonly string[],
  port: number,
): "v1" | "v2" | "none" | "ambiguous" {
  const serveIndex = argv.lastIndexOf("serve");
  if (serveIndex < 1) return "none";
  if (basename(argv[serveIndex - 1]) !== deps.executableBasename) return "none";
  const tail = argv.slice(serveIndex);
  const matches: Array<"v1" | "v2"> = [];
  for (const generation of ["v1", "v2"] as const) {
    const expected = deps.serveArgsFor(generation, LOOPBACK_HOST, port);
    if (tail.length === expected.length && tail.every((arg, i) => arg === expected[i])) {
      matches.push(generation);
    }
  }
  if (matches.length === 1) return matches[0];
  // 0 matches: unknown shape. 2: the contract no longer distinguishes them.
  return matches.length === 0 ? "none" : "ambiguous";
}

/** LISTEN socket inodes on 127.0.0.1:<port> (plus the kernel's uid for that socket,
 *  reported as a diagnostic only — see `socketUid` below). */
function listenInodes(
  readProcFile: (p: string) => string,
  port: number,
): string[] | "permission_denied" {
  let table: string;
  try {
    table = readProcFile("/proc/net/tcp");
  } catch (error) {
    return errCode(error) === "EACCES" || errCode(error) === "EPERM" ? "permission_denied" : [];
  }
  const wanted = `${LOOPBACK_HEX}:${port.toString(16).toUpperCase().padStart(4, "0")}`;
  const inodes = new Set<string>();
  for (const line of table.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) continue;
    if (fields[1] !== wanted || fields[3] !== TCP_LISTEN) continue;
    if (/^\d+$/.test(fields[9])) inodes.add(fields[9]);
  }
  return [...inodes];
}

/** The LISTEN socket's kernel uid (null if unreadable). Diagnostic only: it is the
 *  *creator's* uid, not the holder's (fds are inherited / passed via SCM_RIGHTS). */
function socketUidFor(readProcFile: (p: string) => string, port: number): number | null {
  let table: string;
  try {
    table = readProcFile("/proc/net/tcp");
  } catch {
    return null;
  }
  const wanted = `${LOOPBACK_HEX}:${port.toString(16).toUpperCase().padStart(4, "0")}`;
  for (const line of table.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) continue;
    if (fields[1] !== wanted || fields[3] !== TCP_LISTEN) continue;
    if (/^\d+$/.test(fields[7])) return Number(fields[7]);
  }
  return null;
}

/**
 * Every pid whose fd table holds `socket:[inode]`, plus how many fd tables we
 * could not read at all.
 *
 * NO uid filter and NO pid floor (#2784 review, 通信牛): a child of another uid can
 * inherit a listening fd (or receive it via SCM_RIGHTS), and in a container PID 1
 * can hold one — so filtering by uid silently misses the real holder.
 *
 * #1676: unreadable fd tables are **not** a refusal by themselves. On every normal
 * host there are processes whose `/proc/<pid>/fd` is EACCES — root/system daemons
 * (other uid) *and* same-uid daemons that set `PR_SET_DUMPABLE=0` (user systemd
 * units, agents). Treating any of them as "the holder might be hidden" made this
 * observation fail 100% of the time (`reason=observe_permission_denied`), so every
 * daemon-created node fell back to a private server without provider credentials.
 *
 * The ambiguity #2784 guarded against is kept where it actually matters: if **no**
 * readable holder is found while some fd tables were unreadable, we still refuse
 * (`permission_denied`) instead of guessing. Once exactly one readable holder is
 * found, that process demonstrably holds the socket; an unreadable process could
 * only hold the *same* socket (same server), and `locate()` still reads the
 * holder's uid / start ticks / argv from its own `/proc` entry.
 */
function socketOwnerPids(
  deps: Required<HostSharedObserverDeps>,
  inode: string,
): { owners: number[]; unreadable: number } | "permission_denied" {
  const target = `socket:[${inode}]`;
  let pids: string[];
  try {
    pids = deps.readDir("/proc");
  } catch {
    return "permission_denied";
  }
  const owners: number[] = [];
  const unreadable = new Set<number>();
  for (const entry of pids) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    // PID 1 is scanned too (#2784 review, 通信牛): in a container PID 1 can hold a
    // listening fd, and if it does, skipping it would report a wrong "unique
    // holder". Only pid 0 (not a real process) is out of scope.
    if (pid <= 0) continue;
    let fds: string[];
    try {
      fds = deps.readDir(`/proc/${pid}/fd`);
    } catch (error) {
      // The process is gone (its /proc entry vanished mid-scan) — nothing to read.
      if (errCode(error) !== "ENOENT") unreadable.add(pid);
      continue;
    }
    for (const fd of fds) {
      try {
        if (deps.readLink(`/proc/${pid}/fd/${fd}`) === target) {
          // One pid, one entry: a duplicate would fake a second holder.
          if (!owners.includes(pid)) owners.push(pid);
          break;
        }
      } catch (error) {
        if (errCode(error) !== "ENOENT") unreadable.add(pid);
      }
    }
  }
  return { owners, unreadable: unreadable.size };
}

interface Snapshot {
  inode: string;
  pid: number;
  uid: number;
  ticks: string;
}

/** One full locate pass. */
function locate(
  deps: Required<HostSharedObserverDeps>,
  port: number,
): { ok: true; snapshot: Snapshot } | { ok: false; reason: HostSharedObserveReason } {
  const inodes = listenInodes(deps.readProcFile, port);
  if (inodes === "permission_denied") return { ok: false, reason: "permission_denied" };
  if (inodes.length === 0) return { ok: false, reason: "no_listener" };
  // Two LISTEN inodes on one loopback port: guessing which is meant is not allowed.
  if (inodes.length > 1) return { ok: false, reason: "ambiguous_listener" };
  const inode = inodes[0];
  const scan = socketOwnerPids(deps, inode);
  if (scan === "permission_denied") return { ok: false, reason: "permission_denied" };
  // No readable holder but fd tables we could not read: refuse instead of guessing.
  if (scan.owners.length === 0) {
    return { ok: false, reason: scan.unreadable > 0 ? "permission_denied" : "socket_owner_not_found" };
  }
  if (scan.owners.length > 1) return { ok: false, reason: "ambiguous_listener" };
  const pid = scan.owners[0];
  // The holder's uid comes from its own process, never from the socket: an fd can
  // be inherited or passed, so the socket's creator uid is not the holder's.
  const uid = deps.procUid(pid);
  if (uid === undefined) return { ok: false, reason: "identity_mismatch" };
  const proc = deps.liveProcess(pid);
  if (!proc) return { ok: false, reason: "identity_mismatch" };
  return { ok: true, snapshot: { inode, pid, uid, ticks: proc.ticks } };
}

/**
 * Observe the real process behind a validated literal loopback URL.
 *
 * Read-only, never throws: every failure is a `reason`. Identity is read twice
 * and must be identical, so a process that died, was replaced, or whose PID was
 * reused is a failure rather than a stale success. Argv/executable are
 * diagnostics, never a proven generation.
 */
export function observeHostSharedServe(
  url: string,
  overrides: HostSharedObserverDeps = {},
): HostSharedObserveResult {
  const deps = { ...defaultDeps(), ...overrides };
  try {
    if (deps.platform !== "linux") return { ok: false, reason: "unsupported_platform" };
    const parsed = parseLoopbackUrl(url);
    if (!parsed) return { ok: false, reason: "url_not_supported" };
    const { port } = parsed;

    const first = locate(deps, port);
    if (!first.ok) return first;

    let argv: string[] = [];
    let argvReadable = true;
    try {
      argv = deps.readProcFile(`/proc/${first.snapshot.pid}/cmdline`).split("\0").filter((a) => a !== "");
    } catch (error) {
      const code = errCode(error);
      if (code === "EACCES" || code === "EPERM") return { ok: false, reason: "permission_denied" };
      argvReadable = false;
    }
    let executable: string | null = null;
    let executableSource: "proc_exe" | "argv0" | null = null;
    try {
      executable = deps.readLink(`/proc/${first.snapshot.pid}/exe`);
      executableSource = "proc_exe";
    } catch {
      // argv[0] is caller-controlled: keep it as a labelled fallback so later
      // binding can never mistake it for the observed binary.
      if (argvReadable && argv.length > 0) {
        executable = argv[0];
        executableSource = "argv0";
      }
    }

    // Re-verify the SAME process before returning: inode, pid, uid and start
    // ticks must all still be the ones we located.
    const second = locate(deps, port);
    if (!second.ok) return second;
    const a = first.snapshot, b = second.snapshot;
    if (a.inode !== b.inode || a.pid !== b.pid || a.uid !== b.uid || a.ticks !== b.ticks) {
      return { ok: false, reason: "identity_mismatch" };
    }

    return {
      ok: true,
      processEvidence: {
        url,
        host: LOOPBACK_HOST,
        port,
        listenInode: a.inode,
        pid: a.pid,
        uid: a.uid,
        startTicks: Number(a.ticks),
        diagnostics: {
          executable,
          executableSource,
          /** The socket's creator uid from /proc/net/tcp — diagnostic only; it is
           *  NOT necessarily the holder's uid (inherited / SCM_RIGHTS fds). */
          socketUid: socketUidFor(deps.readProcFile, port),
          argvTail: argvTailOf(argv),
          argvContract: argvReadable ? argvContractOf(deps, argv, port) : "none",
          argvContractNote: CONTRACT_NOTE,
        },
      },
    };
  } catch {
    // A pure observation must never escape as a throw.
    return { ok: false, reason: "identity_mismatch" };
  }
}

/** Literal `http://127.0.0.1:<port>` only — the sole shape this provider observes.
 *
 * Matching the RAW string is deliberate (#2784 review, 通信牛): `new URL()` would
 * normalize `127.1`, integer/hex addresses and path/query/fragment into
 * `127.0.0.1`, accepting spellings the host registry never writes. It also refuses
 * a leading-zero port and anything beyond 65535, and pins lowercase http.
 */
const LOOPBACK_URL_RE = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/;

export function parseLoopbackUrl(url: unknown): { port: number } | undefined {
  if (typeof url !== "string") return undefined;
  const match = LOOPBACK_URL_RE.exec(url);
  if (!match) return undefined;
  const port = Number(match[1]);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) return undefined;
  return { port };
}

/** Real liveness re-check bound to the exact pid+startTicks pair, so PID reuse
 *  cannot pass. Exported so no consumer re-implements it. */
export function makeHostSharedAliveProbe(
  overrides: HostSharedObserverDeps = {},
): (pid: number, startTicks: number) => boolean {
  const deps = { ...defaultDeps(), ...overrides };
  return (pid, startTicks) => {
    // PID 1's liveness/admission policy stays as it was (通信牛: keep it separate
    // from the holder scan) — only the fd-holder scan must include PID 1.
    if (!Number.isSafeInteger(pid) || pid <= 1) return false;
    if (typeof startTicks !== "number" || !Number.isFinite(startTicks)) return false;
    try {
      const proc = deps.liveProcess(pid);
      return !!proc && proc.ticks === String(startTicks);
    } catch {
      return false;
    }
  };
}
