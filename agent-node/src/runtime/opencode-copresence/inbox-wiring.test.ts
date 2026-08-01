import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const cli = readFileSync(join(import.meta.dir, "..", "..", "cli.ts"), "utf8");

describe("OpenCode copresence CommHub message wiring", () => {
  test("work and informational drains are independent lanes", () => {
    expect(cli).toContain("const workInboxDrain = createInboxDrainLane(");
    expect(cli).toContain("const informationalInboxDrain = createInboxDrainLane(");
    expect(cli).not.toContain("const informationalInboxDrain = workInboxDrain");
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
    expect(branch).toContain('runtime.notify(`[${from}] ${content}`)');
    expect(branch).toContain("await ackMessage(msg.id)");
    expect(branch).not.toContain("processTask(");
    expect(branch).not.toContain("sendReply(");
  });

  test("the task drain does not claim OpenCode copresence messages", () => {
    const workStart = cli.indexOf("async function processInbox()");
    const fastStart = cli.indexOf("async function processOpencodeCopresenceMessages()", workStart);
    const work = cli.slice(workStart, fastStart);
    expect(work).toContain('(msg.type || "task") === "message"');
    expect(work).toContain("continue;");
  });

  test("startup and SSE reconnect both recover pending informational messages", () => {
    const connected = cli.indexOf('if (ev.type === "connected")');
    const connectedEnd = cli.indexOf("continue;", connected);
    expect(cli.slice(connected, connectedEnd)).toContain("scheduleInformationalInboxDrain()");

    const registered = cli.indexOf('log("已注册到 CommHub")');
    expect(cli.slice(registered, registered + 300)).toContain("scheduleInformationalInboxDrain()");
  });
});
