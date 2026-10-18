import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { randomBytes } from "crypto";

export const TURN_RECEIPT_MAX_WATCH_MS = 48 * 60 * 60 * 1000;

export type TurnReceiptEntry = {
  version: 1;
  taskId: string;
  inboxId: string;
  replyTo: string;
  threadId: string;
  turnId: string;
  startedAt: number;
  state: "watching" | "receipt_queued";
  receiptQueuedAt?: number;
};

export type OwnedFollowUpReceiptEntry = Omit<TurnReceiptEntry, "version"> & {
  version: 2;
  mode: "owned_followup";
  ownerTaskId: string;
  ownerTurnId: string;
  nonce: string;
  inputSha256: string;
  phase: "intent" | "accepted" | "answer_intent" | "answering";
  answerClientUserMessageId?: string;
};

export type AnyTurnReceiptEntry = TurnReceiptEntry | OwnedFollowUpReceiptEntry;

export function receiptQueuedExpired(entry: AnyTurnReceiptEntry, now = Date.now()): boolean {
  return entry.state === "receipt_queued"
    && now - (entry.receiptQueuedAt ?? entry.startedAt) >= TURN_RECEIPT_MAX_WATCH_MS;
}

function validString(value: unknown, max = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\0\r\n]/u.test(value);
}

export class IncompatibleTurnReceiptError extends Error {
  constructor() { super("Unsupported or invalid follow-up receipt format; original ledger preserved. Use a compatible runtime before recovery or writes."); }
}

function sanitizeEntry(value: unknown): AnyTurnReceiptEntry | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Omit<Partial<OwnedFollowUpReceiptEntry>, "version"> & { version?: unknown };
  if (row.version !== undefined && row.version !== 1 && row.version !== 2) throw new IncompatibleTurnReceiptError();
  if ((row.version === 1 && row.mode !== undefined) || (row.version === 2 && row.mode !== "owned_followup")) throw new IncompatibleTurnReceiptError();
  if ((row.version !== 1 && row.version !== 2) || !validString(row.taskId) || !validString(row.inboxId) ||
      !validString(row.replyTo) || !validString(row.threadId) || !validString(row.turnId) ||
      !Number.isFinite(row.startedAt) || Number(row.startedAt) <= 0 ||
      (row.state !== "watching" && row.state !== "receipt_queued")) {
    if (row.version === 2) throw new IncompatibleTurnReceiptError();
    return null;
  }
  const common: TurnReceiptEntry = {
    version: 1,
    taskId: row.taskId,
    inboxId: row.inboxId,
    replyTo: row.replyTo,
    threadId: row.threadId,
    turnId: row.turnId,
    startedAt: Number(row.startedAt),
    state: row.state,
    ...(Number.isFinite(row.receiptQueuedAt) ? { receiptQueuedAt: Number(row.receiptQueuedAt) } : {}),
  };
  if (row.version === 1) return common;
  if (!validString(row.ownerTaskId) || row.ownerTaskId === row.taskId || !validString(row.ownerTurnId) ||
      typeof row.nonce !== "string" || !/^[a-f0-9]{32}$/.test(row.nonce) ||
      typeof row.inputSha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.inputSha256) ||
      !["intent", "accepted", "answer_intent", "answering"].includes(row.phase ?? "") ||
      (row.phase === "answering"
        ? row.turnId === row.ownerTurnId || row.answerClientUserMessageId !== `anet:${row.taskId}`
        : row.turnId !== row.ownerTurnId || (row.phase === "answer_intent"
          ? row.answerClientUserMessageId !== `anet:${row.taskId}`
          : row.answerClientUserMessageId !== undefined))) throw new IncompatibleTurnReceiptError();
  return { ...common, version: 2, mode: "owned_followup", ownerTaskId: row.ownerTaskId,
    ownerTurnId: row.ownerTurnId, nonce: row.nonce, inputSha256: row.inputSha256,
    phase: row.phase!, ...(["answer_intent", "answering"].includes(row.phase!) ? { answerClientUserMessageId: row.answerClientUserMessageId } : {}) };
}

/** Crash-safe, 0600 ledger. It stores routing and turn identity, never prompt/result text. */
export class TurnReceiptLedger {
  constructor(private readonly filePath: string) {}

  load(): AnyTurnReceiptEntry[] {
    if (!existsSync(this.filePath)) return [];
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(this.filePath, "utf8")); }
    catch { this.save([]); return []; }
    if (!Array.isArray(parsed) && parsed && typeof parsed === "object" && "version" in parsed) throw new IncompatibleTurnReceiptError();
    const rows = Array.isArray(parsed)
      ? parsed.map(sanitizeEntry).filter((row): row is AnyTurnReceiptEntry => row !== null)
      : [];
    if (!Array.isArray(parsed) || rows.length !== parsed.length) this.save(rows);
    else chmodSync(this.filePath, 0o600);
    return rows;
  }

  save(rows: AnyTurnReceiptEntry[]): void {
    // Validate every newer row before touching the filesystem. Unknown versions
    // must not be erased when another task updates its known V1 entry.
    const canonicalRows = rows.map(row => {
      const clean = sanitizeEntry(row);
      return row.version === 2 ? clean! : row;
    });
    if (existsSync(this.filePath)) {
      let existing: unknown;
      try { existing = JSON.parse(readFileSync(this.filePath, "utf8")); }
      catch { existing = undefined; }
      if (Array.isArray(existing)) existing.forEach(sanitizeEntry);
      else if (existing && typeof existing === "object" && "version" in existing) throw new IncompatibleTurnReceiptError();
    }
    const tmp = `${this.filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(tmp, "wx", 0o600);
      fchmodSync(fd, 0o600);
      writeFileSync(fd, JSON.stringify(canonicalRows, null, 2), "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tmp, this.filePath);
      chmodSync(this.filePath, 0o600);
    } catch (error) {
      if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
      try { unlinkSync(tmp); } catch { /* ignore */ }
      throw error;
    }
  }

  watch(entry: Omit<TurnReceiptEntry, "version" | "state">): void {
    const current = this.load();
    if (current.some(row => row.taskId === entry.taskId && row.version === 2)) throw new IncompatibleTurnReceiptError();
    const rows = current.filter((row) => row.taskId !== entry.taskId);
    rows.push({ version: 1, state: "watching", ...entry });
    this.save(rows);
  }

  prepareFollowUp(entry: Omit<OwnedFollowUpReceiptEntry, "version" | "mode" | "phase" | "state" | "turnId" | "answerClientUserMessageId" | "receiptQueuedAt">): void {
    const rows = this.load();
    if (rows.some(row => row.taskId === entry.taskId)) throw new Error("Receipt identity already exists; reconcile before resubmission");
    const row: OwnedFollowUpReceiptEntry = { ...entry, version: 2, mode: "owned_followup", phase: "intent", state: "watching", turnId: entry.ownerTurnId };
    sanitizeEntry(row);
    rows.push(row);
    this.save(rows);
  }

  acceptFollowUp(taskId: string, proof: { ownerTurnId: string; nonce: string }): void {
    const rows = this.load();
    const row = rows.find(item => item.taskId === taskId);
    if (row?.version !== 2 || row.state !== "watching" || !["intent", "accepted"].includes(row.phase) ||
        proof.ownerTurnId !== row.ownerTurnId || proof.nonce !== row.nonce) throw new Error("Follow-up acceptance requires its own pending intent");
    row.phase = "accepted";
    this.save(rows);
  }

  prepareFollowUpAnswer(taskId: string): void {
    const rows = this.load(), row = rows.find(item => item.taskId === taskId);
    if (row?.version !== 2 || row.phase !== "accepted" || row.state !== "watching") throw new Error("Answer submission requires a previously accepted follow-up");
    row.phase = "answer_intent";
    row.answerClientUserMessageId = `anet:${taskId}`;
    this.save(rows);
  }

  bindFollowUpAnswer(taskId: string, context: { threadId: string; turnId: string; clientUserMessageId: string; identityConfirmed?: boolean }): void {
    const rows = this.load();
    const row = rows.find(item => item.taskId === taskId);
    if (row?.version === 2 && row.phase === "answering" && row.threadId === context.threadId &&
        row.turnId === context.turnId && row.answerClientUserMessageId === context.clientUserMessageId) return;
    if (row?.version !== 2 || row.state !== "watching" ||
        (!["accepted", "answer_intent"].includes(row.phase) && !(row.phase === "answering" && context.identityConfirmed === true)) ||
        context.threadId !== row.threadId || context.turnId === row.ownerTurnId || !validString(context.turnId) ||
        context.clientUserMessageId !== `anet:${row.taskId}`) throw new Error("Follow-up answer requires its exact independent user-message identity");
    row.turnId = context.turnId;
    row.phase = "answering";
    row.answerClientUserMessageId = context.clientUserMessageId;
    this.save(rows);
  }

  markReceiptQueued(taskId: string, now = Date.now()): void {
    const rows = this.load();
    const row = rows.find((candidate) => candidate.taskId === taskId);
    if (!row) return;
    row.state = "receipt_queued";
    row.receiptQueuedAt = now;
    this.save(rows);
  }

  remove(taskId: string): void {
    const rows = this.load();
    const next = rows.filter((row) => row.taskId !== taskId);
    if (next.length !== rows.length) this.save(next);
  }
}

export type PersistedTurnResult =
  | { state: "running" }
  | { state: "completed"; text: string; replyIdentityConfirmed?: true }
  | { state: "interrupted" | "failed"; error?: string; completedAt?: number; replyIdentityConfirmed?: true }
  | { state: "identity_unconfirmed" }
  | { state: "missing" };

export type RecoveredReceipt = {
  entry: AnyTurnReceiptEntry;
  text: string;
  failed: boolean;
  reason: "completed" | "interrupted" | "missing" | "expired";
};

function hhmm(now: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Shanghai",
  }).format(new Date(now));
}

function codexTimestampMs(value: number | undefined): number | null {
  if (!Number.isFinite(value) || Number(value) <= 0) return null;
  // Codex Turn.completedAt is Unix seconds. Tolerate milliseconds so a wire
  // migration cannot silently move the interruption time into 1970.
  return Number(value) < 10_000_000_000 ? Number(value) * 1_000 : Number(value);
}

/** Pure recovery decision. Query errors are represented by throwing and retain the row. */
export async function recoverTurnReceipts(args: {
  rows: AnyTurnReceiptEntry[];
  inspect: (threadId: string, turnId: string, expectedClientUserMessageId?: string) => Promise<PersistedTurnResult>;
  now?: number;
}): Promise<{ receipts: RecoveredReceipt[]; watching: AnyTurnReceiptEntry[]; expiredQueued: AnyTurnReceiptEntry[]; followUpsAwaitingReply: OwnedFollowUpReceiptEntry[]; queryErrors: number }> {
  const now = args.now ?? Date.now();
  const receipts: RecoveredReceipt[] = [];
  const watching: AnyTurnReceiptEntry[] = [];
  const expiredQueued: AnyTurnReceiptEntry[] = [];
  const followUpsAwaitingReply: OwnedFollowUpReceiptEntry[] = [];
  let queryErrors = 0;
  for (const entry of args.rows) {
    sanitizeEntry(entry);
    if (receiptQueuedExpired(entry, now)) {
      expiredQueued.push(entry);
      continue;
    }
    if (entry.state === "watching" && now - entry.startedAt >= TURN_RECEIPT_MAX_WATCH_MS) {
      receipts.push({ entry, failed: true, reason: "expired", text: "超过 48 小时未能确认" });
      continue;
    }
    if (entry.version === 2 && entry.phase !== "answering") {
      // A shared owner's terminal answer is never a follow-up's own result.
      // The later admission adapter may reconcile this metadata with Hub;
      // recovery itself remains read-only and starts no model action/turn.
      watching.push(entry);
      followUpsAwaitingReply.push(entry);
      continue;
    }
    try {
      const result = await args.inspect(entry.threadId, entry.turnId, entry.version === 2 ? entry.answerClientUserMessageId : undefined);
      if (result.state === "identity_unconfirmed" || (entry.version === 2 &&
          (result.state === "missing" || (result.state !== "running" && result.replyIdentityConfirmed !== true) ||
            (result.state === "completed" && result.text.trim().length === 0)))) {
        watching.push(entry);
        continue;
      }
      if (result.state === "running") {
        watching.push(entry);
      } else if (result.state === "completed") {
        receipts.push({ entry, failed: false, reason: "completed", text: result.text });
      } else {
        const completedAt = result.state === "missing" ? null : codexTimestampMs(result.completedAt);
        const observed = hhmm(completedAt ?? now);
        const detail = result.state === "missing" ? "未找到原 turn" : result.error?.trim();
        receipts.push({
          entry,
          failed: true,
          reason: result.state === "missing" ? "missing" : "interrupted",
          text: `${detail ? `${detail}；` : ""}${completedAt
            ? `turn 中断于 ${observed}（东八区）`
            : `最晚于 ${observed}（东八区）判定中断`}`,
        });
      }
    } catch {
      queryErrors++;
      watching.push(entry);
    }
  }
  return { receipts, watching, expiredQueued, followUpsAwaitingReply, queryErrors };
}
