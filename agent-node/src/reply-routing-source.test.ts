import { describe, expect, test } from "bun:test";

const source = await Bun.file(new URL("./cli.ts", import.meta.url)).text();

describe("#698 peer reply runtime wiring", () => {
  test("peer replies negotiate the atomic tool and retain only a terminal legacy fallback", () => {
    expect(source).toContain('sendAtomic: (args) => callCommHub("send_peer_reply", {');
    expect(source).toContain('sendLegacyReply: (args) => callCommHub("send_reply", {');
    expect(source).not.toContain("sendLegacy: async (args) => {");
    expect(source).not.toContain("sendPeerReplyTaskWithTrace({");
    expect(source).not.toContain("REPLY_VIA_SEND_TASK");
  });

  test("every actionable inbox turn crosses the behavior-tested reply-policy seam", () => {
    expect(source).toContain("const inboxTurn = await runInboxTurnByReplyPolicy(");
    expect(source).toContain("if (inboxTurn.kind === \"terminal_peer_reply\") return;");
    expect(source).toContain("const taskOutcome = inboxTurn.result;");
  });

  test("new_reply SSE events wake the actionable work inbox", () => {
    expect(source).toContain("routePeerReplySse(ev, scheduleWorkInboxDrain);");
  });
});
