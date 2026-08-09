#!/usr/bin/env bun
import { strict as assert } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const sentEnvelopes: unknown[] = [];
// @ts-expect-error test IPC stub
process.send = (message: unknown) => {
  sentEnvelopes.push(message);
  return true;
};

const { createIPCEventHandler } = await import("../src/im/feishu/bridge.js");

const connectionName = "p336-binding";
const conversationId = "oc_p336_conversation";
const senderId = "ou_p336_sender_must_not_be_used";
const expectedDir = `/work/feishu-attachments/${connectionName}/${conversationId}/`;
const filePath = `${expectedDir}wire-proof.pdf`;

rmSync(`/work/feishu-attachments/${connectionName}`, { recursive: true, force: true });
mkdirSync(expectedDir, { recursive: true });
writeFileSync(filePath, "%PDF-1.7\nwire proof\n");

const sendCalls: any[] = [];
const adapter = {
  connectionName,
  async send(message: unknown) {
    sendCalls.push(message);
    return { messageId: `sent-${sendCalls.length}` };
  },
};
const event = {
  platform: "feishu",
  connectionId: "wrong-connection#feishu",
  conversation: {
    platform: "feishu",
    conversationId,
    conversationType: "dm",
  },
  sender: { id: senderId },
  messageId: "om_p336",
  mentioned: false,
  content: { text: "make a report" },
  receivedAt: 1,
  idempotencyKey: "feishu:p336:om_p336",
};

try {
  const onEvent = createIPCEventHandler(adapter as any, 25, false);
  await onEvent(event as any);

  assert.equal(sentEnvelopes.length, 1);
  const envelope = sentEnvelopes[0] as any;
  assert.equal(envelope.type, "event");
  assert.equal(envelope.event, event);
  assert.equal(envelope.outboundDir, expectedDir);
  assert.ok(!envelope.outboundDir.includes(senderId), "sender id must not select the directory");
  assert.ok(!envelope.outboundDir.includes("wrong-connection"), "connectionId must not select the directory");

  process.emit("message", {
    type: "reply",
    eventKey: event.idempotencyKey,
    text: `report ready\n[[send-file:${filePath}]]`,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sendCalls.length, 2, "caption and file must both dispatch");
  assert.equal(sendCalls[0].text, "report ready");
  assert.equal(sendCalls[0].forceTextOnly, true);
  assert.deepEqual(sendCalls[0].target, event.conversation);
  assert.deepEqual(sendCalls[1].files, [{ path: filePath, name: "wire-proof.pdf" }]);
  assert.deepEqual(sendCalls[1].target, event.conversation);
  assert.equal(sendCalls[1].replyToMessageId, event.messageId);

  // Let the short pending timer drain so the test leaves no live handles.
  await new Promise((resolve) => setTimeout(resolve, 35));
  console.log("PASS feishu bridge IPC outbound directory + file dispatch");
} finally {
  process.removeAllListeners("message");
  rmSync(`/work/feishu-attachments/${connectionName}`, { recursive: true, force: true });
}
