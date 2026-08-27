import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonIMCorrelationStore } from "../correlation-store";
import type { NormalizedIMEvent, NormalizedIMMessage } from "../types";
import {
  createCommHubEventHandler,
  type IMBridgeCommHubClient,
  type IMBridgeCommHubInboxMessage,
} from "./bridge";

function event(overrides: Partial<NormalizedIMEvent> = {}): NormalizedIMEvent {
  return {
    platform: "feishu",
    connectionId: "node-a#feishu",
    conversation: {
      platform: "feishu",
      conversationId: "oc_test",
      conversationType: "group",
      threadRootId: "om_root",
    },
    sender: { id: "ou_sender" },
    messageId: "om_source",
    mentioned: true,
    content: { text: "hello" },
    receivedAt: Date.now(),
    idempotencyKey: "feishu:node-a#feishu:om_source",
    ...overrides,
  };
}

function fakeCommHub(messages: IMBridgeCommHubInboxMessage[] = []) {
  const sentTasks: any[] = [];
  const acked: string[] = [];
  const client: IMBridgeCommHubClient = {
    async sendTask(args) {
      sentTasks.push(args);
      return { taskId: "task_commhub_1" };
    },
    async getInbox() {
      return messages;
    },
    async ackInbox(_alias, messageId) {
      acked.push(messageId);
      const index = messages.findIndex((message) => message.id === messageId);
      if (index >= 0) messages.splice(index, 1);
    },
  };
  return { client, sentTasks, acked };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Feishu bridge CommHub route", () => {
  test("dispatches inbound IM as a CommHub task and routes one final text reply", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "anet-feishu-commhub-"));
    const store = new JsonIMCorrelationStore(join(scratch, "state.json"));
    const messages: IMBridgeCommHubInboxMessage[] = [];
    const hub = fakeCommHub(messages);
    const sent: NormalizedIMMessage[] = [];
    const handler = createCommHubEventHandler(
      "node-a",
      {
        connectionName: "node-a",
        send: async (message: NormalizedIMMessage) => {
          sent.push(message);
          return { messageId: `om_${sent.length}` };
        },
      } as any,
      60_000,
      false,
      store,
      hub.client,
      5,
    );

    try {
      await handler(event());
      messages.push({
        id: "reply_1",
        type: "reply",
        content: "final answer",
        from_session: "node-a",
        in_reply_to: "task_commhub_1",
      });
      await sleep(30);

      expect(hub.sentTasks).toHaveLength(1);
      expect(hub.sentTasks[0].alias).toBe("node-a");
      expect((hub.sentTasks[0].meta as any).im.bridge).toBe("feishu");
      expect(sent.map((message) => message.text)).toEqual(["final answer"]);
      expect(hub.acked).toEqual(["reply_1"]);
      expect((await store.getCorrelation("task_commhub_1"))?.status).toBe("completed");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("deduplicates repeated CommHub replies for the same task across marker-fallback dispatch", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "anet-feishu-commhub-file-"));
    const store = new JsonIMCorrelationStore(join(scratch, "state.json"));
    const filePath = "/tmp/not-under-feishu-outbound/report.pdf";
    const messages: IMBridgeCommHubInboxMessage[] = [
      {
        id: "reply_1",
        type: "reply",
        content: `see attached\n[[send-file:${filePath}]]`,
        from_session: "node-a",
        in_reply_to: "task_commhub_1",
      },
      {
        id: "reply_2",
        type: "reply",
        content: `see attached\n[[send-file:${filePath}]]`,
        from_session: "node-a",
        in_reply_to: "task_commhub_1",
      },
    ];
    const hub = fakeCommHub(messages);
    const sent: NormalizedIMMessage[] = [];
    const handler = createCommHubEventHandler(
      "node-a",
      {
        connectionName: "node-a",
        send: async (message: NormalizedIMMessage) => {
          sent.push(message);
          return { messageId: `om_${sent.length}` };
        },
      } as any,
      60_000,
      false,
      store,
      hub.client,
      5,
    );

    try {
      await handler(event());
      await sleep(50);

      expect(sent).toHaveLength(1);
      expect(sent[0].text).toBe("see attached");
      expect(hub.acked).toEqual(["reply_1", "reply_2"]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("acks orphan replies after correlation gc instead of silently leaving them unread", async () => {
    const messages: IMBridgeCommHubInboxMessage[] = [
      {
        id: "reply_orphan",
        type: "reply",
        content: "late answer",
        from_session: "node-a",
        in_reply_to: "missing-task",
      },
    ];
    const hub = fakeCommHub(messages);
    const sent: NormalizedIMMessage[] = [];
    createCommHubEventHandler(
      "node-a",
      {
        connectionName: "node-a",
        send: async (message: NormalizedIMMessage) => {
          sent.push(message);
          return { messageId: `om_${sent.length}` };
        },
      } as any,
      60_000,
      false,
      undefined,
      hub.client,
      5,
    );

    await sleep(30);

    expect(sent).toEqual([]);
    expect(hub.acked).toEqual(["reply_orphan"]);
  });
});
