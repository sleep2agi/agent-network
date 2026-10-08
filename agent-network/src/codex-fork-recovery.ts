// Board #738 (step 2 of #734) — `anet node start <node> --fork-on-resume-failure`.
//
// When resuming the recorded thread fails with codex's "missing an ordinal" error
// (a rollout written by codex >= 0.145 and then appended to by an older codex; see
// codex-rollout-history-guard.ts), and ONLY then, and ONLY after a human confirms
// (y/N prompt, or `--yes` when there is no terminal), fork the thread with codex
// `thread/fork` and start the node on the new thread.
//
// - The original rollout is never written: a read-only snapshot copy is taken first,
//   and its hash is compared with the original after the fork.
// - The old → new mapping, the snapshot path and the time go to
//   <node dir>/codex-fork-recovery.json, next to config.json.
// - The caller updates config.codexThreadId only after this returns (fork succeeded).
// - Any other resume failure is re-thrown unchanged: no fork.
import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { atomicWritePrivateJson } from "./private-state";
import { BOARD_REF, isMissingOrdinalError, MISSING_ORDINAL_RE, resolveCodexResumeRollout } from "./codex-rollout-history-guard";

export const FORK_RECOVERY_STATE_FILE = "codex-fork-recovery.json";
export const FORK_RECOVERY_SNAPSHOT_DIR = "rollout-snapshots";

export interface ForkRecoveryOptions {
  /** --fork-on-resume-failure was passed. */
  enabled: boolean;
  /** --yes was passed (required when there is no terminal to ask). */
  yes: boolean;
  /** A human can answer a prompt (stdin is a TTY). */
  interactive: boolean;
  /** The recorded thread this start tried to resume. */
  threadId: string | undefined;
  codexHome: string;
  /** <nodes dir>/<node id> — config.json lives here. */
  nodeDir: string;
  /** Display name, for messages. */
  node: string;
  /** Ask a y/N question; resolves true only for an explicit yes. */
  confirm: (prompt: string) => Promise<boolean>;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface ForkMapping {
  oldThreadId: string;
  newThreadId: string;
  originalRollout: string;
  snapshot: string;
  sha256: string;
  at: string;
}

export function sha256OfFile(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(1024 * 1024);
    for (let pos = 0; ;) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      hash.update(buf.subarray(0, n));
      pos += n;
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/** The rollout codex named in the error (when it exists), else the shared resolver's pick. */
export function rolloutForMissingOrdinal(message: string, codexHome: string, threadId: string): string | null {
  const named = MISSING_ORDINAL_RE.exec(message)?.[1];
  if (named && existsSync(named)) return named;
  return resolveCodexResumeRollout(codexHome, threadId);
}

/** Copy (never move) the rollout into <nodeDir>/rollout-snapshots/ and drop every write bit. */
export function snapshotRollout(original: string, nodeDir: string, now: Date): { path: string; sha256: string } {
  const dir = join(nodeDir, FORK_RECOVERY_SNAPSHOT_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `${basename(original)}.${stamp}.snapshot`);
  const before = sha256OfFile(original);
  copyFileSync(original, path, constants.COPYFILE_EXCL);
  chmodSync(path, statSync(path).mode & 0o555);
  const copied = sha256OfFile(path);
  if (copied !== before) throw new Error(`snapshot of ${original} does not match the original (sha256 ${copied} != ${before})`);
  return { path, sha256: before };
}

function readForkMappings(nodeDir: string): ForkMapping[] {
  const path = join(nodeDir, FORK_RECOVERY_STATE_FILE);
  try {
    const prev = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(prev?.forks)) throw new Error("expected a forks array");
    return prev.forks;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`Cannot read fork recovery history ${path}: ${(error as Error).message}. Preserve this file and restore a valid history from backup before retrying; it has not been replaced.`);
  }
}

export function recordForkMapping(nodeDir: string, entry: ForkMapping): string {
  const path = join(nodeDir, FORK_RECOVERY_STATE_FILE);
  const forks = readForkMappings(nodeDir);
  atomicWritePrivateJson(path, { forks: [...forks, entry] });
  return path;
}

export function forkConfirmationText(node: string, threadId: string, original: string): string[] {
  return [
    `--fork-on-resume-failure: thread ${threadId} of ${node} cannot be resumed ("missing an ordinal", ${BOARD_REF}).`,
    `   codex can fork it (thread/fork) into a NEW thread with the same history, and ${node} will start on that new thread.`,
    `   First a read-only snapshot of the original rollout is taken; the original is never modified:`,
    `     ${original}`,
    `   🔴 The new thread still reads its history from that original file: keep it, do not move or delete it.`,
  ];
}

/**
 * Resume as before; on the "missing an ordinal" failure, and only with the flag and a
 * human's yes, fork instead. `start(false)` resumes the recorded thread; `start(true)`
 * forks it and resumes the fork. Every other outcome re-throws the original error.
 */
export async function resumeOrForkOnMissingOrdinal<T extends { threadId: string }>(
  start: (forkFirst: boolean) => Promise<T>,
  o: ForkRecoveryOptions,
): Promise<T> {
  try {
    return await start(false);
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    if (!o.enabled || !o.threadId || !isMissingOrdinalError(message)) throw error;
    const log = o.log ?? ((line: string) => console.error(`[anet] ${line}`));
    const original = rolloutForMissingOrdinal(message, o.codexHome, o.threadId);
    if (!original) {
      log(`--fork-on-resume-failure: no rollout found for thread ${o.threadId}; not forking.`);
      throw error;
    }
    for (const line of forkConfirmationText(o.node, o.threadId, original)) log(line);
    let confirmed = false;
    if (o.yes) confirmed = true;
    else if (o.interactive) confirmed = await o.confirm(`Fork thread ${o.threadId} into a new thread now? [y/N] `);
    else log(`--fork-on-resume-failure: no terminal to ask; a non-interactive fork also needs --yes.`);
    if (!confirmed) {
      log(`Not confirmed: nothing was forked and no file was changed.`);
      throw error;
    }
    // A damaged audit trail must not trigger a new fork or be treated as empty.
    readForkMappings(o.nodeDir);
    const now = (o.now ?? (() => new Date()))();
    const snap = snapshotRollout(original, o.nodeDir, now);
    log(`read-only snapshot: ${snap.path}`);
    const thread = await start(true);
    if (!thread.threadId || thread.threadId === o.threadId) {
      throw new Error(`thread/fork did not produce a new thread (got ${thread.threadId || "none"}); the node keeps thread ${o.threadId}`);
    }
    const after = sha256OfFile(original);
    if (after !== snap.sha256) {
      throw new Error(`the original rollout changed during the fork (${original}); the node keeps thread ${o.threadId}. Snapshot: ${snap.path}`);
    }
    const statePath = recordForkMapping(o.nodeDir, {
      oldThreadId: o.threadId, newThreadId: thread.threadId, originalRollout: original,
      snapshot: snap.path, sha256: snap.sha256, at: now.toISOString(),
    });
    log(`forked thread ${o.threadId} → ${thread.threadId} (recorded in ${statePath}); the original rollout is unchanged.`);
    return thread;
  }
}
