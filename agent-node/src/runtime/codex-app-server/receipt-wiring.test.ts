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

  test("an app-level Hub rejection settles the ledger instead of retrying forever", () => {
    const direct = cli.slice(cli.indexOf("async function deliverReplyReliably("), cli.indexOf("// ── Telegram"));
    const rejected = direct.slice(
      direct.indexOf("if (e instanceof CommHubError && e.appLevel)"),
      direct.indexOf("// Transient", direct.indexOf("if (e instanceof CommHubError && e.appLevel)")),
    );
    expect(rejected).toContain("clearPendingReply(target, taskId)");
    expect(rejected).toContain("turnReceiptLedger?.remove(taskId)");
    expect(rejected.indexOf("turnReceiptLedger?.remove(taskId)")).toBeLessThan(rejected.indexOf('return "rejected"'));
  });

  test("terminal peer replies enter the runtime without creating a reply ledger row", () => {
    const process = cli.slice(cli.indexOf("async function processTask("), cli.indexOf("async function processInbox()"));
    expect(process).toContain("receiptExpected = true");
    expect(process).toContain("runtimeEvidence, receiptExpected");
    const appServer = cli.slice(cli.indexOf("async function processWithCodexAppServer("), cli.indexOf("async function processWithGrok("));
    expect(appServer).toContain("trackReceipt = true");
    expect(appServer).toContain("if (trackReceipt && taskId && inboxId && turnReceiptLedger)");
    const inbox = cli.slice(cli.indexOf("const inboxTurn = await runInboxTurnByReplyPolicy("), cli.indexOf('if (inboxTurn.kind === "terminal_peer_reply")'));
    expect(inbox).toContain("deliveryPolicy.replyExpected");
  });

  test("startup recovery is read-only against Codex and is retried periodically", () => {
    expect(cli).toContain("session.bridge.inspectPersistedTurn(threadId, turnId)");
    expect(cli).toContain("if (turnReceiptLedger?.load().length) void recoverCodexTurnReceipts()");
    const recovery = cli.slice(cli.indexOf("async function recoverCodexTurnReceipts"), cli.indexOf("let sideThreadNodeRuntime"));
    expect(recovery).not.toContain("startTaskTurn");
    expect(recovery).not.toContain("processTask(");
    expect(recovery).toContain("for (const expired of recovery.expiredQueued)");
    expect(recovery).toContain("turnReceiptLedger.load().filter((row) => receiptQueuedExpired(row))");
    expect(recovery).toContain("clearPendingReply(expired.replyTo, expired.taskId)");
    expect(recovery).toContain("turnReceiptLedger.remove(expired.taskId)");
    expect(recovery).toContain("dropping receipt_queued");
  });
});
