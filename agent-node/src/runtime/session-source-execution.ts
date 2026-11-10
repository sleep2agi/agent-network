import { constants, openSync, closeSync, fstatSync, fsyncSync, lstatSync, realpathSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isSourceExecutionTask, isSourceExecutionResult, type SourceExecutionTask, type SourceExecutionResult } from "../../../contracts/session-source-execution";
import type { createSessionSourceEvidenceReader } from "./session-source-evidence";

/** Explicit execution-journal directory, NOT a node profile. Caller creates it
 * privately. Persistent O_EXCL claim before API; no uncertain claim is retried. */
export function createSessionSourceExecutor(reader: ReturnType<typeof createSessionSourceEvidenceReader>, journalDirectory: string) {
  return createSingleClaimSourceOperation<SourceExecutionTask, SourceExecutionResult>({ journalDirectory,
    key: t => t.admission_request_id, validTask: isSourceExecutionTask, validResult: isSourceExecutionResult,
    fallback: t => ({ execution_id: t.execution_id, admission_request_id: t.admission_request_id, status: "unknown", bridge: "not_created" }),
    run: t => reader.execute(t) });
}

/** Shared durable one-claim mechanism, not source evidence. New-project create
 * reuses it without constructing a fictitious SourceExecutionTask/grant. */
export function createSingleClaimSourceOperation<T, R>(options: { journalDirectory: string; key: (t: T) => string;
  validTask: (t: any) => boolean; validResult: (r: any, t: T) => boolean; fallback: (t: T) => R; run: (t: T) => Promise<R> }) {
  const { journalDirectory } = options;
  const safe = () => {
    const st = lstatSync(journalDirectory);
    if (!st.isDirectory() || st.isSymbolicLink() || realpathSync(journalDirectory) !== journalDirectory
      || st.uid !== process.getuid!() || (st.mode & 0o077)) throw Error("source_journal_unsafe");
  };
  const path = (task: T) => { const k = options.key(task); if (!/^[A-Za-z0-9_-]{1,200}$/.test(k)) throw Error("source_journal_key_invalid"); return join(journalDirectory, `${k}.json`); };
  const syncDirectory = () => { const fd = openSync(journalDirectory, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } };
  const fallback = options.fallback;
  const recover = (t: T): R => {
    safe(); const fd = openSync(path(t), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid!() || (st.mode & 0o077) || st.size > 32768) throw Error("unsafe_journal");
      const v = JSON.parse(readFileSync(fd, "utf8"));
      return options.validResult(v, t) ? v : fallback(t);
    } finally { closeSync(fd); }
  };
  return {
    async execute(t: T): Promise<R> {
      if (!options.validTask(t)) throw Error("source_task_invalid");
      safe();
      try {
        const fd = openSync(path(t), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try { writeFileSync(fd, JSON.stringify(fallback(t))); fsyncSync(fd); } finally { closeSync(fd); }
        syncDirectory();
      } catch (e: any) {
        if (e.code === "EEXIST") return recover(t);
        throw e;
      }
      const result = await options.run(t), tmp = `${path(t)}.${randomUUID()}.tmp`;
      try {
        const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { writeFileSync(fd, JSON.stringify(result)); fsyncSync(fd); } finally { closeSync(fd); }
        renameSync(tmp, path(t)); syncDirectory();
      }
      finally { try { unlinkSync(tmp); } catch { /* already renamed */ } }
      return result;
    },
    recover(t: T) { if (!options.validTask(t)) throw Error("source_task_invalid"); return recover(t); },
  };
}

/** No retry or fallback. A lost ACK can be re-sent from local read-only recovery,
 * but never by taking the task again or posting another fork. */
export async function handleSessionSourceExecution(id: string, deps: {
  take: (id: string) => Promise<SourceExecutionTask | null>;
  ack: (value: SourceExecutionResult) => Promise<boolean>;
  executor: ReturnType<typeof createSessionSourceExecutor>;
}): Promise<boolean> {
  try {
    const t = await deps.take(id);
    if (!t || t.execution_id !== id) return false;
    return await deps.ack(await deps.executor.execute(t));
  } catch { return false; }
}
