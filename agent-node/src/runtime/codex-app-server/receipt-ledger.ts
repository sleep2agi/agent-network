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

export function receiptQueuedExpired(entry: TurnReceiptEntry, now = Date.now()): boolean {
  return entry.state === "receipt_queued"
    && now - (entry.receiptQueuedAt ?? entry.startedAt) >= TURN_RECEIPT_MAX_WATCH_MS;
}

function validString(value: unknown, max = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\0\r\n]/u.test(value);
}

function sanitizeEntry(value: unknown): TurnReceiptEntry | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<TurnReceiptEntry>;
  if (row.version !== 1 || !validString(row.taskId) || !validString(row.inboxId) ||
      !validString(row.replyTo) || !validString(row.threadId) || !validString(row.turnId) ||
      !Number.isFinite(row.startedAt) || Number(row.startedAt) <= 0 ||
      (row.state !== "watching" && row.state !== "receipt_queued")) return null;
  return {
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
}

/** Crash-safe, 0600 ledger. It stores routing and turn identity, never prompt/result text. */
export class TurnReceiptLedger {
  constructor(private readonly filePath: string) {}

  load(): TurnReceiptEntry[] {
    if (!existsSync(this.filePath)) return [];
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(this.filePath, "utf8")); }
    catch { this.save([]); return []; }
    const rows = Array.isArray(parsed)
      ? parsed.map(sanitizeEntry).filter((row): row is TurnReceiptEntry => row !== null)
      : [];
    if (!Array.isArray(parsed) || rows.length !== parsed.length) this.save(rows);
    else chmodSync(this.filePath, 0o600);
    return rows;
  }

  save(rows: TurnReceiptEntry[]): void {
    const tmp = `${this.filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(tmp, "wx", 0o600);
      fchmodSync(fd, 0o600);
      writeFileSync(fd, JSON.stringify(rows, null, 2), "utf8");
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
    const rows = this.load().filter((row) => row.taskId !== entry.taskId);
    rows.push({ version: 1, state: "watching", ...entry });
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
  | { state: "completed"; text: string }
  | { state: "interrupted" | "failed"; error?: string; completedAt?: number }
  | { state: "missing" };

export type RecoveredReceipt = {
  entry: TurnReceiptEntry;
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
  rows: TurnReceiptEntry[];
  inspect: (threadId: string, turnId: string) => Promise<PersistedTurnResult>;
  now?: number;
}): Promise<{ receipts: RecoveredReceipt[]; watching: TurnReceiptEntry[]; expiredQueued: TurnReceiptEntry[]; queryErrors: number }> {
  const now = args.now ?? Date.now();
  const receipts: RecoveredReceipt[] = [];
  const watching: TurnReceiptEntry[] = [];
  const expiredQueued: TurnReceiptEntry[] = [];
  let queryErrors = 0;
  for (const entry of args.rows) {
    if (receiptQueuedExpired(entry, now)) {
      expiredQueued.push(entry);
      continue;
    }
    if (entry.state === "watching" && now - entry.startedAt >= TURN_RECEIPT_MAX_WATCH_MS) {
      receipts.push({ entry, failed: true, reason: "expired", text: "超过 48 小时未能确认" });
      continue;
    }
    try {
      const result = await args.inspect(entry.threadId, entry.turnId);
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
  return { receipts, watching, expiredQueued, queryErrors };
}
