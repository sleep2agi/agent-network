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
import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";

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
import { resolveFeishuAccess } from "../access-resolve.js";

type OnEventHandler = (event: NormalizedIMEvent) => Promise<void>;

export class FeishuAdapter implements IMAdapter {
  readonly platform = "feishu";
  readonly ingressMode: IMIngressMode = "socket";

  private feishuConfig: FeishuChannelConfig | null = null;
  private connectionName = "";
  private client: lark.Client | null = null;
  private wsClient: lark.WSClient | null = null;
  /**
   * The bot's own open_id, resolved at init() via /open-apis/bot/v3/info.
   * Used to detect real @bot mentions (vs any mention) in group messages.
   * Falls back to null on lookup failure — `mentioned` then degrades to the
   * naive `mentions.length > 0` check.
   */
  private botOpenId: string | null = null;
  /** Where to persist downloaded inbound media (M5c). */
  private mediaDir: string | null = null;

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
    // Resolve bot identity so group @ detection compares against the real
    // open_id. Failure degrades the check to naive `mentions.length > 0`
    // — we still want the bridge to start.
    this.botOpenId = await fetchBotOpenId(this.client);
    // Configure the media drop-zone for inbound image downloads.
    //
    // 2026-06-29 (Vincent path-based simplification, RFC-020 §11):
    // Default to `/work/feishu-attachments/<connectionName>/` — explicitly
    // OUTSIDE `/work/.anet/**` so the hardening file-read denylist (which
    // protects secrets, tokens, and channel config) does not block the
    // agent's Read tool from picking the image up. `ANET_FEISHU_MEDIA_DIR`
    // env override lets operators redirect (e.g. to a tmpfs); when the
    // override is unset AND `channelDir` is unset (legacy in-memory test
    // paths), downloads are disabled.
    const overrideBase = process.env.ANET_FEISHU_MEDIA_DIR?.trim();
    if (overrideBase) {
      this.mediaDir = join(overrideBase, this.connectionName);
    } else if (fc.channelDir) {
      this.mediaDir = `/work/feishu-attachments/${this.connectionName}`;
    } else {
      this.mediaDir = null;
    }
  }

  async start(onEvent: OnEventHandler): Promise<void> {
    if (!this.feishuConfig || !this.client) {
      throw new Error("FeishuAdapter.start: call init() first");
    }
    const { appId, appSecret, access, groupPolicy } = this.feishuConfig;
    const connectionName = this.connectionName;
    const botOpenId = this.botOpenId;
    const mediaDir = this.mediaDir;
    const client = this.client;

    const dispatcher = new lark.EventDispatcher({});
    dispatcher.register({
      "im.message.receive_v1": async (rawEvent: unknown): Promise<unknown> => {
        try {
          this.health_ = { ...this.health_, lastEventAt: Date.now() };
          const normalized = normalizeMessageEvent(rawEvent, connectionName, botOpenId);
          if (!normalized) return; // unsupported message_type

          // M5c: attach downloaded image paths for image-type messages.
          // Failure-tolerant — text flow proceeds even when download fails.
          await maybeAttachImages(rawEvent, normalized, client, mediaDir);

          const verdict = checkAccess(normalized, access, groupPolicy);
          if (!verdict.allow) {
            auditLog("deny", normalized, verdict.reason);
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

    // Decide payload — image takes precedence when imagePath is provided
    // (caller's choice), otherwise text/markdown.
    let msgType: "text" | "image";
    let content: string;
    if (message.imagePath) {
      const imageKey = await uploadImage(this.client, message.imagePath);
      if (!imageKey) {
        throw new Error(
          `FeishuAdapter.send: image upload failed for ${message.imagePath}`,
        );
      }
      msgType = "image";
      content = JSON.stringify({ image_key: imageKey });
    } else {
      const text = message.text ?? message.markdown;
      if (!text) {
        throw new Error(
          "FeishuAdapter.send: requires text, markdown, or imagePath",
        );
      }
      msgType = "text";
      content = JSON.stringify({ text });
    }

    // Threaded reply when the message references an upstream message_id.
    // im.message.reply preserves the thread context (Feishu root_id).
    const replyTo = message.replyToMessageId ?? message.target.threadRootId;
    if (replyTo) {
      const resp = await this.client.im.message.reply({
        path: { message_id: replyTo },
        data: { msg_type: msgType, content },
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
        msg_type: msgType,
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
 * `mentioned` precision: when `botOpenId` is non-null (resolved at init via
 * /open-apis/bot/v3/info, M5b) the function compares mentions[].id.open_id
 * to the bot's actual open_id. When null (init lookup failed), it falls back
 * to the M2 naive check `mentions.length > 0` so the bridge still functions.
 */
function normalizeMessageEvent(
  raw: unknown,
  connectionName: string,
  botOpenId: string | null,
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
  const mentions = Array.isArray(message.mentions) ? message.mentions : [];
  const mentioned = botOpenId
    ? mentions.some((m) => m?.id?.open_id === botOpenId)
    : mentions.length > 0;
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

// ── Internals: image up/down (RFC-020 §3.1 / #179 M5c) ──────────────────

/**
 * Best-effort: when the inbound message is an image, download it via
 * `im.messageResource.get` and attach the local file path to `event.content
 * .images`. Failure is non-fatal — the text flow proceeds and the event
 * carries an empty images array.
 *
 * `mediaDir` of null disables downloads (e.g. when the channel config didn't
 * carry a channelDir). `client` of null does the same.
 */
async function maybeAttachImages(
  rawEvent: unknown,
  normalized: NormalizedIMEvent,
  client: lark.Client | null,
  mediaDir: string | null,
): Promise<void> {
  if (!client || !mediaDir) return;
  const raw = rawEvent as FeishuRawEvent | undefined;
  const message = raw?.message;
  if (!message || message.message_type !== "image") return;
  let imageKey: string | undefined;
  try {
    imageKey = (JSON.parse(message.content) as { image_key?: string }).image_key;
  } catch {
    return;
  }
  if (!imageKey || !message.message_id) return;
  const localPath = await downloadImage(
    client,
    message.message_id,
    imageKey,
    mediaDir,
    normalized.conversation?.conversationId,
  );
  if (localPath) {
    normalized.content = { ...normalized.content, images: [localPath] };
  }
}

/**
 * Detect the MIME type of an image buffer from its magic bytes. Returns
 * `null` if the buffer doesn't match a supported image format — caller
 * MUST refuse to save and surface a non-image to the agent.
 *
 * Whitelist: PNG, JPEG, WebP, GIF — the four formats Feishu officially
 * supports for `im.image` messages. Magic-byte check (not just MIME header
 * from HTTP) defends against a server claiming `image/png` while shipping
 * an executable / archive payload.
 */
function detectImageMime(buf: Buffer): { mime: string; ext: string } | null {
  if (buf.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return { mime: "image/png", ext: "png" };
  }
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  // GIF: 47 49 46 38 (37|39) 61  ("GIF87a" / "GIF89a")
  if (
    buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61
  ) {
    return { mime: "image/gif", ext: "gif" };
  }
  // WebP: 52 49 46 46 ?? ?? ?? ?? 57 45 42 50  ("RIFF...WEBP")
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return { mime: "image/webp", ext: "webp" };
  }
  return null;
}

async function downloadImage(
  client: lark.Client,
  messageId: string,
  imageKey: string,
  mediaDir: string,
  conversationId?: string,
): Promise<string | null> {
  try {
    const resp = await client.im.messageResource.get({
      path: { message_id: messageId, file_key: imageKey },
      params: { type: "image" },
    });
    if (!resp) return null;
    const stream = resp as unknown as Readable;
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      stream.on("end", () => resolve());
      stream.on("error", (err: Error) => reject(err));
    });
    const body = Buffer.concat(chunks);
    // Magic-byte mime whitelist — reject non-image payloads even if the
    // server marked them as images. Defends against extension confusion +
    // accidental binary delivery.
    const detected = detectImageMime(body);
    if (!detected) return null;
    // Path layout: `<mediaDir>/<conversationId-or-_>/<msg_id>.<ext>` —
    // conversationId subdir keeps a chat's attachments together (easier
    // for an operator to spot-check + GC). msg_id is unique enough across
    // a single conversation; the random suffix in the filename is dropped
    // because msg_id IS the dedup key (idempotencyKey). Collision-safe.
    const subdir = conversationId
      ? join(mediaDir, conversationId.replace(/[^a-zA-Z0-9_-]/g, "_"))
      : mediaDir;
    mkdirSync(subdir, { recursive: true });
    const safeMsgId = messageId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filepath = join(subdir, `${safeMsgId}.${detected.ext}`);
    writeFileSync(filepath, body);
    return filepath;
  } catch {
    return null;
  }
}

async function uploadImage(
  client: lark.Client,
  imagePath: string,
): Promise<string | null> {
  try {
    if (!existsSync(imagePath)) return null;
    const buf = readFileSync(imagePath);
    const stream = Readable.from(buf);
    const resp = await client.im.image.create({
      data: {
        image_type: "message",
        // lark's typing wants a Readable but the runtime accepts any Readable.
        image: stream as unknown as never,
      },
    });
    return resp?.image_key ?? null;
  } catch {
    return null;
  }
}

// ── Internals: bot identity resolution (RFC-020 §4.3 / #179 M5b) ────────

/**
 * Resolve the bot's own open_id via the Feishu /open-apis/bot/v3/info endpoint.
 * Returns null on failure so the adapter can degrade to naive mention
 * detection rather than refusing to start.
 */
async function fetchBotOpenId(client: lark.Client): Promise<string | null> {
  try {
    const resp = (await client.request({
      method: "GET",
      url: "/open-apis/bot/v3/info",
    })) as unknown;
    // Lark's untyped request envelope; bot info lives at .bot.open_id.
    const r = resp as { bot?: { open_id?: string }; data?: { bot?: { open_id?: string } } };
    return r?.bot?.open_id ?? r?.data?.bot?.open_id ?? null;
  } catch {
    return null;
  }
}

// ── Internals: access whitelist (RFC-020 §4.1 / §4.3 / §5.1) ─────────────

/**
 * Two-stage access check (RFC-020 §4.3 — 通信牛 review 必改1):
 *   1. Whitelist gate: sender or chat must be in the configured allowlist.
 *   2. Group policy gate: in non-DM conversations, the configured groupPolicy
 *      decides whether to trigger even when whitelisted.
 *        - "all"      → trigger on every whitelisted-chat message
 *        - "mention"  → require event.mentioned (default; M5b real bot open_id match)
 *        - "command"  → reserved for slash-prefix triggers; behaves as "mention"
 *                       until a command parser lands. TODO post-M5.
 *        - "observe"  → never trigger (chat is whitelisted for sidecar visibility
 *                       only — keeps the door open for future audit / Dashboard)
 *
 * Returns { allow, reason } so the audit log surfaces *why* a message was denied
 * (helps Vincent triage "I sent a message and got nothing" cases).
 */
function checkAccess(
  event: NormalizedIMEvent,
  access: FeishuAccessList,
  groupPolicy: FeishuChannelConfig["groupPolicy"],
): { allow: boolean; reason: string } {
  // v0.11 — delegate the whitelist + group-policy decision to the shared
  // resolver so telegram + feishu have one fail-mode contract (mirror at
  // src/im/access-resolve.ts; canonical at agent-node/src/util/access-
  // resolve.ts). Mention-gate logic stays here because it depends on
  // event.mentioned, which is a feishu-specific concept the generic
  // resolver does not model.
  const decision = resolveFeishuAccess({
    conversationType: event.conversation.conversationType,
    allowFrom: access.allowFrom,
    allowChats: access.allowChats,
    senderId: event.sender.id,
    conversationId: event.conversation.conversationId,
    groupPolicy: groupPolicy === "command" ? "mention" : groupPolicy,
  });

  // DM, observe, fail-closed cases are fully decided by the resolver.
  if (event.conversation.conversationType === "dm") return { allow: decision.allow, reason: decision.reason };
  if (!decision.allow) return { allow: false, reason: decision.reason };
  if (groupPolicy === "all") return { allow: true, reason: "" };

  // groupPolicy = "mention" | "command" — resolver said chat is allowed,
  // but trigger needs the bot to actually be @-mentioned in the message.
  if (event.mentioned) return { allow: true, reason: "" };
  return {
    allow: false,
    reason: `groupPolicy=${groupPolicy} requires @bot mention (not mentioned)`,
  };
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
