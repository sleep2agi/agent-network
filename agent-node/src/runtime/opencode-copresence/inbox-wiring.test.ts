import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const cli = readFileSync(join(import.meta.dir, "..", "..", "cli.ts"), "utf8");

describe("OpenCode copresence CommHub message wiring", () => {
  test("work and informational drains are independent lanes", () => {
    expect(cli).toContain("const workInboxDrain = createInboxDrainLane(");
    expect(cli).toContain("const informationalInboxDrain = createInboxDrainLane(");
    expect(cli).not.toContain("const informationalInboxDrain = workInboxDrain");
    expect(cli).toContain("}, INBOX_RETRY)");
  });

  test("new_message SSE uses a non-blocking informational lane", () => {
    const branchStart = cli.indexOf('if (ev.type === "new_message" && RUNTIME === "opencode"');
    const branchEnd = cli.indexOf('} else if (["new_task", "new_message", "broadcast"]', branchStart);
    expect(branchStart).toBeGreaterThan(-1);
    expect(branchEnd).toBeGreaterThan(branchStart);
    const branch = cli.slice(branchStart, branchEnd);
    expect(branch).toContain("scheduleInformationalInboxDrain()");
    expect(branch).not.toContain("await processInbox()");
  });

  test("message is displayed as a non-replying TUI notification in the fast drain", () => {
    const display = cli.indexOf("async function processOpencodeCopresenceMessages()");
    const skip = cli.indexOf("function scheduleWorkInboxDrain()", display);
    expect(display).toBeGreaterThan(-1);
    expect(skip).toBeGreaterThan(display);
    const branch = cli.slice(display, skip);
    expect(branch).toContain("await drainInboxBatch(messages");
    expect(branch).toContain("runtime.notify(content, undefined, from)");
    expect(branch).toContain("await ackMessage(msg.id)");
    expect(branch).toContain("displayedInformationalMessageIds.add(msg.id)");
    expect(branch).toContain("displayedInformationalMessageIds.delete(msg.id)");
    expect(branch).not.toContain("ack failed for message");
    expect(branch).not.toContain("processTask(");
    expect(branch).not.toContain("sendReply(");
  });

  test("the task drain does not claim OpenCode copresence messages", () => {
    const workStart = cli.indexOf("async function processInbox()");
    const fastStart = cli.indexOf("async function processOpencodeCopresenceMessages()", workStart);
    const work = cli.slice(workStart, fastStart);
    expect(work).toContain('(msg.type || "task") === "message"');
    expect(work).toContain("return;");
  });

  test("network tasks pass their authenticated sender into the shared TUI turn", () => {
    const start = cli.indexOf("async function processWithOpencode(");
    const end = cli.indexOf("async function ensureOpencodeCopresenceRuntime()", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const branch = cli.slice(start, end);
    expect(branch).toContain("runtime.submit(task, undefined, _from)");
    expect(branch).not.toContain("runtime.submit(task);");
  });

  test("startup and SSE reconnect both recover pending informational messages", () => {
    const connected = cli.indexOf('if (ev.type === "connected")');
    const connectedEnd = cli.indexOf("continue;", connected);
    expect(cli.slice(connected, connectedEnd)).toContain("scheduleInformationalInboxDrain()");

    const registered = cli.indexOf('log("已注册到 CommHub")');
    expect(cli.slice(registered, registered + 300)).toContain("scheduleInformationalInboxDrain()");
  });

  test("runtime startup is single-flight and shutdown waits for an in-flight open", () => {
    const ensureStart = cli.indexOf("async function ensureOpencodeCopresenceRuntime()");
    const closeStart = cli.indexOf("async function closeOpencodeRuntime", ensureStart);
    const ensure = cli.slice(ensureStart, closeStart);
    expect(ensure).toContain("return opencodeCopresenceOpening.run(async () =>");

    const closeEnd = cli.indexOf("// RFC-030", closeStart);
    const close = cli.slice(closeStart, closeEnd);
    expect(close).toContain("const opening = opencodeCopresenceOpening.pending()");
    expect(close).toContain("await opening.catch(");
  });

  test("tmux SIGHUP enters the same cleanup path as SIGTERM", () => {
    expect(cli).toContain('process.on("SIGTERM", shutdown)');
    expect(cli).toContain('process.on("SIGHUP", shutdown)');
  });
});
