/**
 * RFC-020 §3.1 — Feishu (Lark) adapter for the IM compatibility layer.
 *
 * Uses `@larksuiteoapi/node-sdk` in WebSocket long-connection mode (WSClient).
 * No public IP / no domain verification / no webhook signature decryption —
 * the three biggest 飞书 接入 risks all live in the HTTP event-callback path,
 * not in WSClient mode.
 *
 * Milestones:
 *   M1: contract scaffold.
 *   M2 (this file): WSClient init + EventDispatcher for `im.message.receive_v1`
 *                   + event normalization + access whitelist gate + audit log.
 *   M3: outbound `im.message.create` (text), edit support (≤20/msg).
 *   M5: image upload / download (`im.image.create` / `im.messageResource.get`)
 *       + group @bot detection refined to match the bot's own open_id.
 */
import * as lark from "@larksuiteoapi/node-sdk";

import type {
  IMAdapter,
  IMAdapterHealth,
  IMChannelConfig,
  IMConversationRef,
  IMIngressMode,
  NormalizedIMEvent,
  NormalizedIMMessage,
} from "../types.js";
import type { FeishuAccessList, FeishuChannelConfig } from "./config.js";

type OnEventHandler = (event: NormalizedIMEvent) => Promise<void>;

export class FeishuAdapter implements IMAdapter {
  readonly platform = "feishu";
  readonly ingressMode: IMIngressMode = "socket";

  private feishuConfig: FeishuChannelConfig | null = null;
  private connectionName = "";
  private client: lark.Client | null = null;
  private wsClient: lark.WSClient | null = null;

  private health_: IMAdapterHealth = {
    connected: false,
    lastEventAt: null,
    lastError: null,
  };

  async init(config: IMChannelConfig): Promise<void> {
    if (config.platform !== "feishu") {
      throw new Error(
        `FeishuAdapter.init: expected platform "feishu", got "${config.platform}"`,
      );
    }
    const fc = config.platformConfig as Partial<FeishuChannelConfig> | undefined;
    if (!fc?.appId || !fc?.appSecret) {
      throw new Error(
        "FeishuAdapter.init: appId / appSecret missing in platformConfig",
      );
    }
    this.feishuConfig = fc as FeishuChannelConfig;
    this.connectionName = config.connectionName;
    this.client = new lark.Client({
      appId: fc.appId,
      appSecret: fc.appSecret,
      disableTokenCache: false,
    });
  }

  async start(onEvent: OnEventHandler): Promise<void> {
    if (!this.feishuConfig || !this.client) {
      throw new Error("FeishuAdapter.start: call init() first");
    }
    const { appId, appSecret, access } = this.feishuConfig;
    const connectionName = this.connectionName;

    const dispatcher = new lark.EventDispatcher({});
    dispatcher.register({
      "im.message.receive_v1": async (rawEvent: unknown): Promise<unknown> => {
        try {
          this.health_ = { ...this.health_, lastEventAt: Date.now() };
          const normalized = normalizeMessageEvent(rawEvent, connectionName);
          if (!normalized) return; // unsupported message_type
          if (!isAccessAllowed(normalized, access)) {
            auditLog("deny", normalized, "not in allowFrom / allowChats");
            return;
          }
          await onEvent(normalized);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.health_ = { ...this.health_, lastError: msg };
          auditLog("error", null, msg);
        }
      },
    });

    this.wsClient = new lark.WSClient({
      appId,
      appSecret,
      loggerLevel: lark.LoggerLevel.warn,
    });

    await this.wsClient.start({ eventDispatcher: dispatcher });
    this.health_ = { ...this.health_, connected: true, lastError: null };
  }

  async stop(): Promise<void> {
    // Lark SDK does not expose a public close on WSClient (as of 1.42); allow
    // GC + mark health for callers. Worker process exit drops the connection.
    this.health_ = { ...this.health_, connected: false };
    this.wsClient = null;
    this.client = null;
    this.feishuConfig = null;
  }

  async send(message: NormalizedIMMessage): Promise<{ messageId: string }> {
    if (!this.client) {
      throw new Error("FeishuAdapter.send: call init() first");
    }
    const text = message.text ?? message.markdown;
    if (!text) {
      // M5 will add image / file / card variants.
      throw new Error(
        "FeishuAdapter.send: M3 supports text only (image/card land in M5)",
      );
    }
    const content = JSON.stringify({ text });

    // Threaded reply when the message references an upstream message_id.
    // im.message.reply preserves the thread context (Feishu root_id).
    const replyTo = message.replyToMessageId ?? message.target.threadRootId;
    if (replyTo) {
      const resp = await this.client.im.message.reply({
        path: { message_id: replyTo },
        data: { msg_type: "text", content },
      });
      const messageId = resp?.data?.message_id;
      if (!messageId) {
        throw new Error("FeishuAdapter.send: reply returned no message_id");
      }
      return { messageId };
    }

    const receive_id_type =
      message.target.conversationType === "dm" ? "open_id" : "chat_id";
    const resp = await this.client.im.message.create({
      params: { receive_id_type },
      data: {
        receive_id: message.target.conversationId,
        msg_type: "text",
        content,
      },
    });
    const messageId = resp?.data?.message_id;
    if (!messageId) {
      throw new Error("FeishuAdapter.send: create returned no message_id");
    }
    return { messageId };
  }

  async edit(
    _target: IMConversationRef,
    messageId: string,
    message: NormalizedIMMessage,
  ): Promise<void> {
    if (!this.client) {
      throw new Error("FeishuAdapter.edit: call init() first");
    }
    const text = message.text ?? message.markdown;
    if (!text) {
      throw new Error("FeishuAdapter.edit: M3 supports text only");
    }
    // Feishu allows up to 20 edits per message — caller is responsible for
    // budgeting. Used to promote a "⏳ 处理中…" placeholder into the final reply.
    await this.client.im.message.update({
      path: { message_id: messageId },
      data: {
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    });
  }

  health(): IMAdapterHealth {
    return { ...this.health_ };
  }
}

// ── Internals: event normalization (RFC-020 §2.3) ────────────────────────

interface FeishuRawMessage {
  message_id: string;
  message_type: string;
  content: string;
  chat_id: string;
  chat_type: "p2p" | "group";
  mentions?: Array<{ key: string; id: { open_id: string }; name: string }>;
  root_id?: string;
  create_time?: string;
}

interface FeishuRawSender {
  sender_id?: { open_id?: string; union_id?: string; user_id?: string };
  sender_type?: string;
  tenant_key?: string;
}

interface FeishuRawEvent {
  message?: FeishuRawMessage;
  sender?: FeishuRawSender;
}

/**
 * Translate raw `im.message.receive_v1` payload into NormalizedIMEvent.
 * Returns null for unsupported message types so the caller skips them.
 *
 * `mentioned` is detected naively in M2 as `mentions.length > 0`. M5 refines
 * by comparing each mention's `id.open_id` against the bot's own open_id
 * (requires an API round-trip at init time to resolve the bot identity).
 */
function normalizeMessageEvent(
  raw: unknown,
  connectionName: string,
): NormalizedIMEvent | null {
  const event = raw as FeishuRawEvent | undefined;
  const message = event?.message;
  const sender = event?.sender;
  const openId = sender?.sender_id?.open_id;
  if (!message || !openId) return null;

  let text: string | undefined;
  if (message.message_type === "text") {
    try {
      text = (JSON.parse(message.content) as { text?: string }).text;
    } catch {
      text = message.content;
    }
  } else if (message.message_type === "file") {
    try {
      const parsed = JSON.parse(message.content) as { file_name?: string };
      text = `[文件: ${parsed.file_name ?? "unknown"}]`;
    } catch {
      text = "[文件]";
    }
  } else if (message.message_type === "sticker") {
    text = "[表情]";
  } else if (message.message_type === "image") {
    // M5: download via im.messageResource.get + populate content.images.
    text = undefined;
  } else {
    // unsupported types (audio / video / post / share_chat / ...) — skip
    return null;
  }

  const conversationType: "dm" | "group" =
    message.chat_type === "group" ? "group" : "dm";
  const mentioned =
    Array.isArray(message.mentions) && message.mentions.length > 0;
  const connectionId = `${connectionName}#feishu`;

  return {
    platform: "feishu",
    connectionId,
    tenantId: sender?.tenant_key,
    conversation: {
      platform: "feishu",
      conversationId: message.chat_id,
      conversationType,
      threadRootId: message.root_id,
    },
    sender: { id: openId },
    messageId: message.message_id,
    mentioned,
    content: text ? { text } : {},
    receivedAt: Date.now(),
    // RFC-020 §4.4: `${platform}:${connectionId}:${messageId}`
    idempotencyKey: `feishu:${connectionId}:${message.message_id}`,
  };
}

// ── Internals: access whitelist (RFC-020 §4.1 / §5.1) ────────────────────

function isAccessAllowed(
  event: NormalizedIMEvent,
  access: FeishuAccessList,
): boolean {
  if (access.allowFrom.includes(event.sender.id)) return true;
  if (
    event.conversation.conversationType === "group" &&
    access.allowChats.includes(event.conversation.conversationId)
  ) {
    return true;
  }
  return false;
}

function auditLog(
  verdict: "allow" | "deny" | "error",
  event: NormalizedIMEvent | null,
  reason: string,
): void {
  const ts = new Date().toISOString();
  const conv = event
    ? `${event.conversation.conversationType}:${event.conversation.conversationId}`
    : "?";
  const from = event ? event.sender.id : "?";
  process.stderr.write(
    `[${ts}] [feishu:audit] ${verdict} from=${from} conv=${conv} — ${reason}\n`,
  );
}
