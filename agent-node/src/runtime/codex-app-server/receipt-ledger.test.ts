import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  recoverTurnReceipts,
  TURN_RECEIPT_MAX_WATCH_MS,
  TurnReceiptLedger,
  type PersistedTurnResult,
  type TurnReceiptEntry,
} from "./receipt-ledger";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function row(overrides: Partial<TurnReceiptEntry> = {}): TurnReceiptEntry {
  return {
    version: 1,
    taskId: "task-public-fixture",
    inboxId: "inbox-public-fixture",
    replyTo: "sender-fixture",
    threadId: "thread-public-fixture",
    turnId: "turn-public-fixture",
    startedAt: 1_000,
    state: "watching",
    ...overrides,
  };
}

describe("#703 Codex turn receipt ledger", () => {
  test("atomic private ledger records no prompt or result and removes delivered receipt", () => {
    const root = mkdtempSync(join(tmpdir(), "receipt-ledger-"));
    roots.push(root);
    const path = join(root, "ledger.json");
    const ledger = new TurnReceiptLedger(path);
    const { version: _version, state: _state, receiptQueuedAt: _queued, ...watch } = row();
    ledger.watch(watch);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).not.toContain("prompt");
    ledger.markReceiptQueued(row().taskId, 2_000);
    expect(ledger.load()[0]).toMatchObject({ state: "receipt_queued", receiptQueuedAt: 2_000 });
    ledger.remove(row().taskId);
    expect(ledger.load()).toEqual([]);
  });

  test("A completed turn supplements its exact final result", async () => {
    const result = await recoverTurnReceipts({
      rows: [row()], now: 2_000,
      inspect: async () => ({ state: "completed", text: "final result" }),
    });
    expect(result.receipts).toEqual([{ entry: row(), text: "final result", failed: false, reason: "completed" }]);
  });

  test("B running turn stays watching without a receipt", async () => {
    const result = await recoverTurnReceipts({ rows: [row()], now: 2_000, inspect: async () => ({ state: "running" }) });
    expect(result.receipts).toEqual([]);
    expect(result.watching).toEqual([row()]);
  });

  test("C interrupted turn fails with an observable local minute", async () => {
    const now = new Date("2026-10-07T08:09:00+08:00").getTime();
    const result = await recoverTurnReceipts({
      rows: [row({ startedAt: now - 1_000 })], now,
      inspect: async () => ({ state: "interrupted" }),
    });
    expect(result.receipts[0]?.failed).toBe(true);
    expect(result.receipts[0]?.text).toMatch(/turn 中断于 \d{2}:\d{2}/u);
  });

  test("watchdog stop+start interruption is failed and never converted to a rerun", async () => {
    const now = Date.now();
    let inspections = 0;
    const result = await recoverTurnReceipts({
      rows: [row({ startedAt: now - 5_000 })], now,
      inspect: async () => { inspections++; return { state: "interrupted", error: "watchdog stop+start" }; },
    });
    expect(inspections).toBe(1);
    expect(result.receipts[0]).toMatchObject({ failed: true, reason: "interrupted" });
    expect(result.receipts[0]?.text).toContain("turn 中断于");
  });

  test("D exact turn missing fails instead of silently rerunning", async () => {
    const result = await recoverTurnReceipts({ rows: [row()], now: 2_000, inspect: async () => ({ state: "missing" }) });
    expect(result.receipts[0]).toMatchObject({ failed: true, reason: "missing" });
    expect(result.receipts[0]?.text).toContain("未找到原 turn");
  });

  test("E query failure retains the row and emits no receipt", async () => {
    const result = await recoverTurnReceipts({
      rows: [row()], now: 2_000,
      inspect: async (): Promise<PersistedTurnResult> => { throw new Error("transport unavailable"); },
    });
    expect(result).toMatchObject({ receipts: [], watching: [row()], queryErrors: 1 });
  });

  test("F receipt_queued remains recoverable until Hub really accepts it", async () => {
    const queued = row({ state: "receipt_queued", receiptQueuedAt: 1_500 });
    const result = await recoverTurnReceipts({
      rows: [queued], now: 2_000,
      inspect: async () => ({ state: "completed", text: "durable result" }),
    });
    expect(result.receipts[0]).toMatchObject({ entry: queued, text: "durable result", failed: false });
  });

  test("G unresolved watching entry expires after 48 hours with explicit reason", async () => {
    let inspected = 0;
    const result = await recoverTurnReceipts({
      rows: [row()], now: 1_000 + TURN_RECEIPT_MAX_WATCH_MS,
      inspect: async () => { inspected++; return { state: "running" }; },
    });
    expect(inspected).toBe(0);
    expect(result.receipts[0]).toMatchObject({ failed: true, reason: "expired", text: "超过 48 小时未能确认" });
  });
});
