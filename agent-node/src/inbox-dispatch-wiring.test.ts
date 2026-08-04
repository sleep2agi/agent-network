import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const cli = readFileSync(join(import.meta.dir, "cli.ts"), "utf8");

describe("Codex app-server live inbox kick wiring", () => {
  test("a Codex snapshot releases the serialized fetch lane after submission", () => {
    const start = cli.indexOf("async function processInbox()");
    const end = cli.indexOf("async function processOpencodeCopresenceMessages()", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const processInbox = cli.slice(start, end);

    expect(processInbox).toContain('if (RUNTIME === "codex-app-server")');
    expect(processInbox).toContain("codexInboxDispatcher.submit(messages, processInboxMessage)");
    expect(processInbox).toContain("await dispatchInboxBatch(messages, processInboxMessage)");
  });

  test("Codex detached admission is explicitly bounded and completion wakes the Hub window", () => {
    expect(cli).toContain("const CODEX_INBOX_MAX_CONCURRENT = 20;");
    expect(cli).toContain("maxConcurrent: CODEX_INBOX_MAX_CONCURRENT");
    expect(cli).toContain("onSettled: scheduleWorkInboxDrain");
  });

  test("pending reply drain is fenced while detached Codex rows are active", () => {
    const start = cli.indexOf("async function processInbox()");
    const end = cli.indexOf("const messages = await getInbox()", start);
    const prelude = cli.slice(start, end);
    expect(prelude).toContain("shouldDrainPendingReplies(RUNTIME, inflightMessageIds.size)");
    expect(prelude).toContain("await drainPendingReplies()");
  });
});
