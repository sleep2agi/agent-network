#!/usr/bin/env bash
set -euo pipefail

ART=/src/docs/tests
REPORT="$ART/report-test1241-feishu-commhub-routing.txt"
mkdir -p "$ART"

{
  echo "# test1241 Feishu CommHub routing"
  echo
  echo "Date: $(date -u +%FT%TZ)"
  echo "HEAD: ${SOURCE_COMMIT:-unknown}"
  echo
} > "$REPORT"

cd /src/agent-network

echo "[1] witnessed-red fixture: legacy IPC + CommHub reply paths send twice when both are active" | tee -a "$REPORT"
cat > /tmp/feishu-commhub-witnessed-red.mjs <<'JSEOF'
import { createCommHubEventHandler, createIPCEventHandler } from "/src/agent-network/src/im/feishu/bridge.ts";
import { JsonIMCorrelationStore } from "/src/agent-network/src/im/correlation-store.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "feishu-witnessed-red-"));
const oldSend = process.send;
const event = {
  platform: "feishu",
  connectionId: "node-a#feishu",
  conversation: { platform: "feishu", conversationId: "oc_test", conversationType: "group", threadRootId: "om_root" },
  sender: { id: "ou_sender" },
  messageId: "om_source",
  mentioned: true,
  content: { text: "hello" },
  receivedAt: Date.now(),
  idempotencyKey: "feishu:node-a#feishu:om_source",
};
const messages = [
  { id: "reply_commhub", type: "reply", content: "final from commhub", from_session: "node-a", in_reply_to: "task_commhub" },
];
const client = {
  async sendTask() { return { taskId: "task_commhub" }; },
  async getInbox() { return messages; },
  async ackInbox(_alias, id) {
    const idx = messages.findIndex((m) => m.id === id);
    if (idx >= 0) messages.splice(idx, 1);
  },
};
let sendCount = 0;
const adapter = {
  connectionName: "node-a",
  send: async () => {
    sendCount++;
    return { messageId: `om_${sendCount}` };
  },
};

try {
  process.send = () => true;
  const store = new JsonIMCorrelationStore(join(scratch, "state.json"));
  const ipc = createIPCEventHandler(adapter, 60000, false, store);
  const commhub = createCommHubEventHandler("node-a", adapter, 60000, false, store, client, 5);

  await ipc(event);
  await commhub(event);
  process.emit("message", { type: "reply", eventKey: event.idempotencyKey, text: "final from ipc" });
  await new Promise((resolve) => setTimeout(resolve, 50));

  console.log(JSON.stringify({ sendCount }));
  if (sendCount !== 2) throw new Error(`expected witnessed-red sendCount:2, got ${sendCount}`);
} finally {
  if (oldSend === undefined) delete process.send;
  else process.send = oldSend;
  rmSync(scratch, { recursive: true, force: true });
}
JSEOF
bun run /tmp/feishu-commhub-witnessed-red.mjs 2>&1 | tee -a "$REPORT"

echo "[2] unit route tests: CommHub task dispatch, duplicate reply guard, orphan reply ack" | tee -a "$REPORT"
bun test src/im/feishu/bridge-commhub-routing.test.ts 2>&1 | tee -a "$REPORT"

echo "[3] docker-only file dispatch: valid /work marker sends exactly one file despite duplicate replies" | tee -a "$REPORT"
cat > /tmp/feishu-commhub-file-dispatch.mjs <<'JSEOF'
import { createCommHubEventHandler } from "/src/agent-network/src/im/feishu/bridge.ts";
import { JsonIMCorrelationStore } from "/src/agent-network/src/im/correlation-store.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "feishu-file-dispatch-"));
const filePath = "/work/feishu-attachments/node-a/oc_test/report.pdf";
mkdirSync("/work/feishu-attachments/node-a/oc_test", { recursive: true });
writeFileSync(filePath, "%PDF-1.7\n");

const messages = [
  { id: "reply_a", type: "reply", content: `ready\n[[send-file:${filePath}]]`, from_session: "node-a", in_reply_to: "task_file" },
  { id: "reply_b", type: "reply", content: `ready\n[[send-file:${filePath}]]`, from_session: "node-a", in_reply_to: "task_file" },
];
const acked = [];
const sent = [];
const client = {
  async sendTask() { return { taskId: "task_file" }; },
  async getInbox() { return messages; },
  async ackInbox(_alias, id) {
    acked.push(id);
    const idx = messages.findIndex((m) => m.id === id);
    if (idx >= 0) messages.splice(idx, 1);
  },
};
const adapter = {
  connectionName: "node-a",
  send: async (message) => {
    sent.push(message);
    return { messageId: `om_${sent.length}` };
  },
};
const event = {
  platform: "feishu",
  connectionId: "node-a#feishu",
  conversation: { platform: "feishu", conversationId: "oc_test", conversationType: "group", threadRootId: "om_root" },
  sender: { id: "ou_sender" },
  messageId: "om_source",
  mentioned: true,
  content: { text: "hello" },
  receivedAt: Date.now(),
  idempotencyKey: "feishu:node-a#feishu:om_source",
};

try {
  const store = new JsonIMCorrelationStore(join(scratch, "state.json"));
  const handler = createCommHubEventHandler("node-a", adapter, 60000, false, store, client, 5);
  await handler(event);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const fileSends = sent.filter((message) => message.files?.[0]?.path === filePath);
  if (sent.length !== 2) throw new Error(`expected text+file sends once, got ${sent.length}`);
  if (sent[0].text !== "ready") throw new Error(`expected text first, got ${JSON.stringify(sent[0])}`);
  if (fileSends.length !== 1) throw new Error(`expected one file send, got ${fileSends.length}`);
  if (acked.join(",") !== "reply_a,reply_b") throw new Error(`expected both replies acked, got ${acked.join(",")}`);
  console.log(JSON.stringify({ ok: true, sent: sent.map((m) => ({ text: m.text, files: m.files })) }));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
JSEOF
bun run /tmp/feishu-commhub-file-dispatch.mjs 2>&1 | tee -a "$REPORT"

echo "PASS test1241" | tee -a "$REPORT"
