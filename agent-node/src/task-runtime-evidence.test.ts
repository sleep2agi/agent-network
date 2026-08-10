import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTaskRuntimeEvidenceReporter,
  logicalTaskIdFromInbox,
} from "./task-runtime-evidence";

const sourceDir = dirname(fileURLToPath(import.meta.url));

describe("logicalTaskIdFromInbox", () => {
  test("retry/reassign task rows use stable task_id, not fresh inbox.id", () => {
    expect(logicalTaskIdFromInbox({
      id: "fresh-redelivery-row",
      task_id: "stable-logical-task",
      type: "task",
    })).toBe("stable-logical-task");
  });

  test("legacy task rows and non-task rows retain transport identity", () => {
    expect(logicalTaskIdFromInbox({ id: "legacy-row", type: "task" })).toBe("legacy-row");
    expect(logicalTaskIdFromInbox({
      id: "message-row",
      task_id: "must-not-bind-message",
      type: "message",
    })).toBe("message-row");
  });
});

describe("createTaskRuntimeEvidenceReporter", () => {
  test("construction and process admission report no evidence", async () => {
    const reported: string[] = [];
    createTaskRuntimeEvidenceReporter({
      taskId: "task_exact_520",
      report: async (level, taskId) => { reported.push(`${level}:${taskId}`); },
    });
    await Promise.resolve();
    expect(reported).toEqual([]);
  });

  test("submission and many runtime events produce one exact report per level", async () => {
    const reported: string[] = [];
    const reporter = createTaskRuntimeEvidenceReporter({
      taskId: "task_once_520",
      report: async (level, taskId) => { reported.push(`${level}:${taskId}`); },
    });
    reporter.submitted();
    reporter.submitted();
    reporter.consumed();
    reporter.consumed();
    await Promise.resolve();
    expect(reported).toEqual([
      "submitted:task_once_520",
      "consumed:task_once_520",
    ]);
  });

  test("a consumed-only runtime remains honest and lets the Hub imply submission", async () => {
    const reported: string[] = [];
    const reporter = createTaskRuntimeEvidenceReporter({
      taskId: "task_late_proof_520",
      report: async (level, taskId) => { reported.push(`${level}:${taskId}`); },
    });
    reporter.consumed();
    await Promise.resolve();
    expect(reported).toEqual(["consumed:task_late_proof_520"]);
  });

  test("missing logical task identity is a fail-closed no-op", async () => {
    let calls = 0;
    const reporter = createTaskRuntimeEvidenceReporter({
      taskId: null,
      report: async () => { calls++; },
    });
    reporter.submitted();
    reporter.consumed();
    await Promise.resolve();
    expect(calls).toBe(0);
  });

  test("an old-Hub failure is visible but never breaks the model turn", async () => {
    const logs: string[] = [];
    const reporter = createTaskRuntimeEvidenceReporter({
      taskId: "task_old_hub_520",
      report: async () => { throw new Error("unknown tool"); },
      debug: (message) => logs.push(message),
    });
    expect(() => reporter.submitted()).not.toThrow();
    await Bun.sleep(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("unknown tool");
  });
});

describe("agent-node inbox wiring", () => {
  test("keeps transport ACK separate from stable task evidence and replies", () => {
    const cli = readFileSync(resolve(sourceDir, "cli.ts"), "utf8");
    const start = cli.indexOf("async function processInbox()");
    const end = cli.indexOf("async function processOpencodeCopresenceMessages", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const branch = cli.slice(start, end);

    expect(branch).toContain("const logicalTaskId = logicalTaskIdFromInbox(msg)");
    expect(branch).toContain("processTask(\n        runtimeContent,\n        from,\n        logicalTaskId,");
    expect(branch).toContain("deliverReplyReliably(from, replyBody, logicalTaskId, failed)");
    expect(branch).toContain("ackMessage(msg.id)");
    expect(branch).not.toContain("processTask(\n        runtimeContent,\n        from,\n        msg.id,");
  });

  test("all runtime dispatch families receive the same task-lifetime reporter", () => {
    const cli = readFileSync(resolve(sourceDir, "cli.ts"), "utf8");
    const start = cli.indexOf("function think(");
    const end = cli.indexOf("async function processTask(", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const branch = cli.slice(start, end);

    for (const call of [
      "processWithCodexStdio(task, from, images, evidence)",
      "processWithCodex(task, from, images, evidence)",
      "processWithGrokCopresence(task, from, taskId, images, evidence)",
      "processWithGrokCli(task, from, images, evidence)",
      "processWithGrok(task, from, images, evidence)",
      "processWithOpencode(task, from, images, evidence)",
      "processWithCodexAppServer(task, from, taskId, steerIfExternalTurn, evidence)",
      "processWithClaude(task, from, images, evidence)",
    ]) {
      expect(branch).toContain(call);
    }
  });

  test("SDK and direct-stdio boundaries preserve their distinct evidence semantics", () => {
    const cli = readFileSync(resolve(sourceDir, "cli.ts"), "utf8");
    const section = (from: string, to: string) => {
      const start = cli.indexOf(from);
      const end = cli.indexOf(to, start + from.length);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      return cli.slice(start, end);
    };

    const claude = section("async function processWithClaude(", "const CODEX_CONFIG");
    expect(claude.indexOf("const messages = query({ prompt, options })"))
      .toBeLessThan(claude.indexOf("evidence?.submitted()"));
    expect(claude.indexOf("evidence?.submitted()"))
      .toBeLessThan(claude.indexOf("for await (const message of messages)"));
    expect(claude.indexOf("for await (const message of messages)"))
      .toBeLessThan(claude.indexOf("evidence?.consumed()"));

    const codexSdk = section("async function processWithCodex(", "async function ensureCodexStdio(");
    expect(codexSdk.indexOf("await codexThread.runStreamed(input, { signal })"))
      .toBeLessThan(codexSdk.indexOf("evidence?.submitted()"));
    expect(codexSdk.indexOf("for await (const ev of events)"))
      .toBeLessThan(codexSdk.indexOf("evidence?.consumed()"));

    const codexStdio = section("async function processWithCodexStdio(", "function sanitizeGrokCommhubLeak(");
    expect(codexStdio).toContain("evidence?.submitted()");
    expect(codexStdio).not.toContain("evidence?.consumed()");
    expect(codexStdio).toContain("is not authoritative ownership");
  });
});
