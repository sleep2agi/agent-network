import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";

const cli = readFileSync(new URL("../../cli.ts", import.meta.url), "utf8");

describe("#703 production receipt wiring", () => {
  test("exact consumed turn is recorded before durable evidence", () => {
    const start = cli.indexOf("onConsumed: (event) => {");
    const end = cli.indexOf("onCapacityRetry:", start);
    const branch = cli.slice(start, end);
    expect(start).toBeGreaterThan(0);
    expect(branch.indexOf("turnReceiptLedger.watch({")).toBeGreaterThan(0);
    expect(branch.indexOf("turnId: event.turnId")).toBeGreaterThan(branch.indexOf("turnReceiptLedger.watch({"));
    expect(branch.indexOf("evidence?.consumed({ threadId, turnId: event.turnId })"))
      .toBeGreaterThan(branch.indexOf("turnReceiptLedger.watch({"));
  });

  test("normal and queued delivery remove the ledger only after sendReply succeeds", () => {
    const direct = cli.slice(cli.indexOf("async function deliverReplyReliably("), cli.indexOf("// ── Telegram"));
    expect(direct.indexOf("await sendReply(target, safeBody, taskId, failed)")).toBeGreaterThan(0);
    expect(direct.indexOf("turnReceiptLedger?.remove(taskId)")).toBeGreaterThan(
      direct.indexOf("await sendReply(target, safeBody, taskId, failed)"),
    );
    const drain = cli.slice(cli.indexOf("async function drainPendingReplies"), cli.indexOf("// #168 inflight guard"));
    expect(drain.indexOf("turnReceiptLedger?.remove(entry.taskId)")).toBeGreaterThan(
      drain.indexOf("await sendReply(entry.to, entry.text, entry.taskId, entry.failed)"),
    );
  });

  test("startup recovery is read-only against Codex and is retried periodically", () => {
    expect(cli).toContain("session.bridge.inspectPersistedTurn(threadId, turnId)");
    expect(cli).toContain("if (turnReceiptLedger?.load().length) void recoverCodexTurnReceipts()");
    const recovery = cli.slice(cli.indexOf("async function recoverCodexTurnReceipts"), cli.indexOf("let sideThreadNodeRuntime"));
    expect(recovery).not.toContain("startTaskTurn");
    expect(recovery).not.toContain("processTask(");
  });
});
