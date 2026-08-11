import { describe, expect, test } from "bun:test";

const source = await Bun.file(new URL("./cli.ts", import.meta.url)).text();

describe("#698 peer reply runtime wiring", () => {
  test("all runtime replies use Hub send_reply rather than a requires-response task", () => {
    expect(source).toContain('const result = await callCommHub("send_reply", {');
    expect(source).not.toContain("REPLY_VIA_SEND_TASK");
    expect(source).not.toContain("sendPeerReplyTaskWithTrace");
  });

  test("new_reply SSE events wake the actionable work inbox", () => {
    expect(source).toMatch(/if \(ev\.type === "new_reply"\) \{[\s\S]{0,300}scheduleWorkInboxDrain\(\);/);
  });
});
