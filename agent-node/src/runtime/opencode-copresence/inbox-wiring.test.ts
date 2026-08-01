import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const cli = readFileSync(join(import.meta.dir, "..", "..", "cli.ts"), "utf8");

describe("OpenCode copresence CommHub message wiring", () => {
  test("new_message SSE wakes the inbox immediately", () => {
    expect(cli).toContain('["new_task", "new_message", "broadcast"].includes(ev.type)');
  });

  test("message is displayed as a non-replying TUI notification before the generic ack-only branch", () => {
    const display = cli.indexOf('msgType === "message" && RUNTIME === "opencode" && opencodeMode === "copresence"');
    const skip = cli.indexOf('if (msgType !== "task" && msgType !== "broadcast")', display);
    expect(display).toBeGreaterThan(-1);
    expect(skip).toBeGreaterThan(display);
    const branch = cli.slice(display, skip);
    expect(branch).toContain('runtime.notify(`[${from}] ${content}`)');
    expect(branch).toContain("await ackMessage(msg.id)");
    expect(branch).not.toContain("processTask(");
    expect(branch).not.toContain("sendReply(");
  });
});
