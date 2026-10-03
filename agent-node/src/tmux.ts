// #505 — the one place this package runs the `tmux` binary.
//
// Incident: a sub-agent ran `TMUX_TMPDIR=$d tmux kill-server` from inside a
// tmux pane. The pane's inherited `$TMUX` (`/tmp/tmux-1000/default,<pid>,<n>`)
// takes precedence over `TMUX_TMPDIR` when tmux picks its socket, so the
// "private" kill-server went to the user's DEFAULT server and took down 71
// nodes. `TMUX_TMPDIR` alone isolates nothing while `$TMUX` is set.
//
// Rules this helper enforces at every call site:
//
//   1. Isolation requested (`ANET_TMUX_SOCKET` or `TMUX_TMPDIR` set) ⇒ pass an
//      explicit `-S <socket>` and drop an inherited `TMUX` / `TMUX_PANE` that
//      points at a DIFFERENT server. `-S` wins over `$TMUX` for socket choice;
//      dropping `TMUX_PANE` stops a pane id from the other server (`%12`) being
//      used as the implicit target. When `$TMUX` already names the same socket
//      (the process lives inside the isolated server) both are kept, so
//      `display-message -p '#S'` still answers "which session am I in".
//   2. Neither variable set ⇒ argv and env are passed through untouched. The
//      default server is what production nodes use; that must not change.
//   3. `kill-server` is refused in every mode. Nothing in the product needs it,
//      and the only time it has ever run here it hit the wrong server.
//
// No package-local imports: agent-node/src/tmux.ts is a byte-identical copy
// (the two packages cannot import each other), pinned by agent-network/src/tmux-ratchet.test.ts.

import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcess,
  type ExecFileSyncOptions,
  type ExecFileSyncOptionsWithBufferEncoding,
  type ExecFileSyncOptionsWithStringEncoding,
  type SpawnOptions,
  type SpawnSyncOptions,
  type SpawnSyncReturns,
} from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type TmuxEnv = Record<string, string | undefined>;

export interface TmuxIsolation {
  /** Socket path passed to tmux as `-S`. */
  socket: string;
  /** Which variable asked for isolation. */
  source: "ANET_TMUX_SOCKET" | "TMUX_TMPDIR";
}

export class TmuxKillServerRefused extends Error {
  constructor(args: readonly string[]) {
    super(
      `refusing to run \`tmux ${args.join(" ")}\`: kill-server is never issued by anet (#505). ` +
      "Kill the sessions you created with `kill-session -t =<name>` instead.",
    );
    this.name = "TmuxKillServerRefused";
  }
}

/**
 * Where tmux should talk to, or null for "today's default behaviour".
 * `TMUX_TMPDIR` resolves the same way tmux itself does: `$TMUX_TMPDIR/tmux-<uid>/default`.
 */
export function resolveTmuxIsolation(
  env: TmuxEnv = process.env,
  uid: number = typeof process.getuid === "function" ? process.getuid() : 0,
): TmuxIsolation | null {
  const explicit = env.ANET_TMUX_SOCKET?.trim();
  if (explicit) return { socket: explicit, source: "ANET_TMUX_SOCKET" };
  const tmpdir = env.TMUX_TMPDIR?.trim();
  if (tmpdir) return { socket: join(tmpdir, `tmux-${uid}`, "default"), source: "TMUX_TMPDIR" };
  return null;
}

/** The socket path inside `$TMUX` (`<socket>,<server pid>,<session idx>`), or null. */
export function socketOfTmuxVar(value: string | undefined): string | null {
  if (!value) return null;
  const comma = value.indexOf(",");
  const path = (comma < 0 ? value : value.slice(0, comma)).trim();
  return path || null;
}

/**
 * True when argv asks tmux to kill its server, including `a ; kill-server`
 * chains and the unambiguous prefixes tmux accepts (`kill-ser`, `kill-serv`, …).
 */
export function isKillServer(args: readonly string[]): boolean {
  return args.some((a) => a.length >= "kill-ser".length && "kill-server".startsWith(a));
}

export interface TmuxInvocation {
  file: "tmux";
  args: string[];
  /** undefined ⇒ inherit the caller's env exactly as before (no isolation requested). */
  env: TmuxEnv | undefined;
  isolation: TmuxIsolation | null;
}

/**
 * Pure argv/env builder. Throws TmuxKillServerRefused for kill-server.
 * `env` is the env the child would otherwise get (the caller's `options.env`,
 * else process.env); isolation is decided from it.
 */
export function buildTmuxInvocation(
  args: readonly string[],
  env?: TmuxEnv,
  uid?: number,
): TmuxInvocation {
  if (isKillServer(args)) throw new TmuxKillServerRefused(args);
  const base = env ?? process.env;
  const isolation = resolveTmuxIsolation(base, uid);
  if (!isolation) return { file: "tmux", args: [...args], env, isolation: null };
  const childEnv: TmuxEnv = { ...base };
  if (socketOfTmuxVar(base.TMUX) !== isolation.socket) {
    delete childEnv.TMUX;
    delete childEnv.TMUX_PANE;
  }
  return { file: "tmux", args: ["-S", isolation.socket, ...args], env: childEnv, isolation };
}

/**
 * tmux refuses to start a server whose socket directory is missing or not
 * private; `-S` (unlike TMUX_TMPDIR) does not create it.
 */
function ensureSocketDir(inv: TmuxInvocation): void {
  if (inv.isolation?.source !== "TMUX_TMPDIR") return;
  try { mkdirSync(dirname(inv.isolation.socket), { recursive: true, mode: 0o700 }); } catch { /* tmux reports it */ }
}

function prepare<T extends { env?: NodeJS.ProcessEnv }>(args: readonly string[], options?: T) {
  const inv = buildTmuxInvocation(args, options?.env);
  ensureSocketDir(inv);
  const opts = (inv.env === undefined ? options : { ...(options ?? {}), env: inv.env }) as T | undefined;
  return { inv, opts };
}

/** `execFileSync("tmux", args, options)` through the #505 rules. */
export function execTmux(args: readonly string[], options: ExecFileSyncOptionsWithStringEncoding): string;
export function execTmux(args: readonly string[], options?: ExecFileSyncOptionsWithBufferEncoding): Buffer;
export function execTmux(args: readonly string[], options?: ExecFileSyncOptions): string | Buffer;
export function execTmux(args: readonly string[], options?: ExecFileSyncOptions): string | Buffer {
  const { inv, opts } = prepare(args, options);
  return execFileSync(inv.file, inv.args, opts);
}

/** `spawnSync("tmux", args, options)` through the #505 rules. */
export function spawnSyncTmux(args: readonly string[], options?: SpawnSyncOptions): SpawnSyncReturns<string | Buffer> {
  const { inv, opts } = prepare(args, options);
  return spawnSync(inv.file, inv.args, opts ?? {});
}

/** `spawn("tmux", args, options)` through the #505 rules. */
export function spawnTmux(args: readonly string[], options?: SpawnOptions): ChildProcess {
  const { inv, opts } = prepare(args, options);
  return spawn(inv.file, inv.args, opts ?? {});
}
