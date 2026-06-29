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
import {
  renderMarkdownToPng,
  shouldRenderAsImage,
  closeBrowser as closeMarkdownBrowser,
} from "./markdown-image-renderer.js";
import { feishuConvKey } from "./outbound-paths.js";

type OnEventHandler = (event: NormalizedIMEvent) => Promise<void>;

export class FeishuAdapter implements IMAdapter {
  readonly platform = "feishu";
  readonly ingressMode: IMIngressMode = "socket";

  private feishuConfig: FeishuChannelConfig | null = null;
  private connectionName_ = "";
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

  /**
   * Snapshot of the current `access.allowFrom` list (from access.json).
   * Used by the bridge's rate-limiter to exempt operator-vouched explicit
   * sender ids from the DM flood limit (2026-06-29: Vincent's multi-turn
   * heavy work was tripping the 3-msg/60s DM limit; explicit-listed
   * users are already operator-trusted via the access whitelist, no
   * need to also flood-limit them). Returns `[]` before `init()`. The
   * wildcard `["*"]` allowlist does NOT count as "explicit" — that's
   * the public-channel shape and still needs flood protection.
   */
  getAllowFrom(): readonly string[] {
    return this.feishuConfig?.access?.allowFrom ?? [];
  }

  /**
   * Read-only accessor used by bridge to resolve per-connection paths
   * (RFC-020 §15 outbound-marker validation needs the connection name
   * to build the allowed per-conversation directory prefix).
   */
  get connectionName(): string {
    return this.connectionName_;
  }

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
    this.connectionName_ = config.connectionName;
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
      this.mediaDir = join(overrideBase, this.connectionName_);
    } else if (fc.channelDir) {
      this.mediaDir = `/work/feishu-attachments/${this.connectionName_}`;
    } else {
      this.mediaDir = null;
    }
  }

  async start(onEvent: OnEventHandler): Promise<void> {
    if (!this.feishuConfig || !this.client) {
      throw new Error("FeishuAdapter.start: call init() first");
    }
    const { appId, appSecret, access, groupPolicy } = this.feishuConfig;
    const connectionName = this.connectionName_;
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
    // Drop the shared chromium for clean shutdown (image-render path).
    await closeMarkdownBrowser().catch(() => {});
  }

  async send(message: NormalizedIMMessage): Promise<{ messageId: string }> {
    if (!this.client) {
      throw new Error("FeishuAdapter.send: call init() first");
    }

    // Hybrid render route (Vincent 2026-06-29 lock, 通信龙 3f70044c):
    //   - explicit imagePath/files → file/image upload paths (existing)
    //   - markdown with heading/table/long → render PNG, send msg_type:image
    //   - markdown without heading/table (short bold/list/link) → schema 1.0 card
    //     `markdown` element (text stays copyable — preview.7 path)
    //   - plain text → msg_type:text (existing)
    let msgType: "text" | "image" | "interactive" | "file";
    let content: string;

    if (message.imagePath) {
      // Caller-supplied image path takes precedence over text/markdown.
      const imageKey = await uploadImage(this.client, message.imagePath);
      if (!imageKey) {
        throw new Error(
          `FeishuAdapter.send: image upload failed for ${message.imagePath}`,
        );
      }
      msgType = "image";
      content = JSON.stringify({ image_key: imageKey });
    } else if (
      message.files &&
      message.files.length > 0 &&
      message.files[0]?.path
    ) {
      // Caller-supplied file path → upload + send msg_type:file
      // (Vincent "给用户发文件" use case, 通信龙 3f70044c).
      const file = message.files[0];
      if (!file.path) {
        throw new Error("FeishuAdapter.send: files[0].path required");
      }
      const fileKey = await uploadFile(this.client, file.path, file.name);
      if (!fileKey) {
        throw new Error(
          `FeishuAdapter.send: file upload failed for ${file.path}`,
        );
      }
      msgType = "file";
      content = JSON.stringify({ file_key: fileKey });
    } else {
      const text = message.text ?? message.markdown;
      if (!text) {
        throw new Error(
          "FeishuAdapter.send: requires text, markdown, imagePath, or files",
        );
      }

      // Caption mode (RFC-020 §15.2): when the bridge is sending sibling
      // attachment files in the same dispatch, this text is a caption —
      // skip the heavy markdown→PNG render path so the user doesn't see
      // "another picture" alongside the actual file.
      if (message.forceTextOnly) {
        msgType = "text";
        content = JSON.stringify({ text });
      } else if (shouldRenderAsImage(text)) {
        // Heading / table / long content — Feishu card markdown element
        // can't render these. Render to PNG via headless chromium and
        // send through the image API (needs im:resource:upload scope).
        try {
          const png = await renderMarkdownToPng(text);
          const imageKey = await uploadImageBuffer(this.client, png);
          if (!imageKey) {
            throw new Error("uploadImageBuffer returned null");
          }
          msgType = "image";
          content = JSON.stringify({ image_key: imageKey });
        } catch (e: any) {
          // Fallback to schema 1.0 card if rendering or upload fails —
          // user still sees the text, just without true table render.
          process.stderr.write(
            `[feishu:adapter] markdown-image render failed, falling back to card: ${e?.message ?? e}\n`,
          );
          msgType = "interactive";
          content = JSON.stringify({
            config: { wide_screen_mode: true },
            elements: [{ tag: "markdown", content: text }],
          });
        }
      } else if (looksLikeMarkdown(text)) {
        // Short markdown — keep text copyable via schema 1.0 card
        // `markdown` element. preview.7 path.
        msgType = "interactive";
        content = JSON.stringify({
          config: { wide_screen_mode: true },
          elements: [{ tag: "markdown", content: text }],
        });
      } else {
        // Plain text — existing path, no behavior change.
        msgType = "text";
        content = JSON.stringify({ text });
      }
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
  } else if (message.message_type === "post") {
    // Feishu 图文混排 rich-text (Vincent 2026-06-29 catch: a message with
    // both image and text in a single send arrives as message_type="post"
    // and was silently dropped by the previous `return null` fallthrough).
    // The post content is a nested structure (title + array of paragraphs,
    // each paragraph is an array of segments with tag: text/img/a/at/
    // emotion). We flatten it to plain text + collect image_keys.
    try {
      text = parsePostContent(message.content);
    } catch (e: any) {
      process.stderr.write(
        `[feishu:adapter] post content parse failed: ${e?.message ?? e}\n`,
      );
      text = "[post message with unparseable content]";
    }
  } else {
    // unsupported types (audio / video / share_chat / file / ...) — skip
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

// ── Internals: markdown render auto-detect (RFC-020 §14, Vincent 2026-06-29) ──

/**
 * Heuristic — does this text look like it contains markdown syntax that
 * Feishu's plain-text `msg_type:"text"` would render as literal source?
 * Catches the patterns Vincent's heavy work produces: tables (`|...|`
 * + separator row), fenced code blocks (`` ``` ``), ATX headings (`#`),
 * bold/italic (`**text**` / `*text*`), unordered/ordered lists, inline
 * code (`` `code` ``), markdown links (`[label](url)`).
 *
 * Returns true for at least one match; the adapter then upgrades to
 * `msg_type:"interactive"` with a `markdown` element. Returns false for
 * plain prose so the text path stays untouched (no perf cost, no
 * behavior change for non-markdown replies).
 *
 * Conservative — single-character matches (e.g., a `|` in prose, one
 * `*` for emphasis-of-one-word that Feishu would render OK as text)
 * are NOT enough to trigger. We want false-positives < false-negatives
 * (a false-positive upgrade renders fine; a false-negative shows raw
 * `|` and `**`).
 */
export function looksLikeMarkdown(text: string): boolean {
  if (!text || typeof text !== "string") return false;
  // Fenced code block — `` ``` `` anywhere.
  if (/```/.test(text)) return true;
  // ATX heading at start of line.
  if (/(^|\n)#{1,6}\s/.test(text)) return true;
  // Table: a row of `|...|` followed by a separator row `|---|` / `|:--|`.
  // `(^|\n)` left-anchor catches tables at literal position 0 too
  // (通信牛 #328 round 1 blocker 2 — was `\n\|...` which missed
  // replies starting directly with a header row).
  if (/(^|\n)\|[^\n]*\|\n\|[\s:|-]+\|/.test(text)) return true;
  // Bold marker — `**text**` (at least one non-empty inner).
  if (/\*\*[^*\s][^*]*\*\*/.test(text)) return true;
  // Unordered list at start of line (`- ` / `* ` / `+ `), at least 1 item.
  if (/(^|\n)[-*+]\s+\S/.test(text)) return true;
  // Ordered list at start of line (`1. `).
  if (/(^|\n)\d+\.\s+\S/.test(text)) return true;
  // Markdown link `[label](url)`.
  if (/\[[^\]\n]+\]\([^)\n]+\)/.test(text)) return true;
  // Inline code (single backtick run, not the fenced case caught above).
  if (/`[^`\n]+`/.test(text)) return true;
  return false;
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
  const msgId = normalized.messageId;
  if (!client) {
    process.stderr.write(`[feishu:image] ${msgId} skip: no lark client\n`);
    return;
  }
  if (!mediaDir) {
    process.stderr.write(`[feishu:image] ${msgId} skip: no mediaDir configured\n`);
    return;
  }
  const raw = rawEvent as FeishuRawEvent | undefined;
  const message = raw?.message;
  if (!message || !message.message_id) return;

  // Collect image_keys from the message content. Two shapes supported:
  //   message_type: "image" → content.image_key (single key)
  //   message_type: "post"  → content.content[][] segments with tag:"img",
  //                          each has its own image_key (N keys, Vincent
  //                          2026-06-29 图文混排 fix)
  let imageKeys: string[] = [];
  if (message.message_type === "image") {
    try {
      const parsed = JSON.parse(message.content) as { image_key?: string };
      if (parsed.image_key) imageKeys = [parsed.image_key];
    } catch (e: any) {
      process.stderr.write(`[feishu:image] ${msgId} skip: content not JSON (${e?.message ?? e})\n`);
      return;
    }
  } else if (message.message_type === "post") {
    imageKeys = extractPostImageKeys(message.content);
  } else {
    return; // other types (text/file/sticker) — silent
  }

  if (imageKeys.length === 0) {
    // No image to download — silent (a text-only post still works,
    // text was already populated by normalizeMessageEvent's post branch).
    return;
  }

  process.stderr.write(
    `[feishu:image] ${msgId} download begin (${imageKeys.length} key(s), dir=${mediaDir})\n`,
  );
  const localPaths: string[] = [];
  for (const key of imageKeys) {
    const path = await downloadImage(
      client,
      message.message_id,
      key,
      mediaDir,
      normalized.conversation?.conversationId,
    );
    if (path) {
      process.stderr.write(`[feishu:image] ${msgId} download ok → ${path}\n`);
      localPaths.push(path);
    } else {
      process.stderr.write(
        `[feishu:image] ${msgId} download FAILED for key=${key.slice(0, 16)}… (see downloadImage stderr above)\n`,
      );
    }
  }
  if (localPaths.length > 0) {
    normalized.content = { ...normalized.content, images: localPaths };
  }
}

/**
 * Parse Feishu `message_type: "post"` content into plain text. Post
 * content is a nested structure:
 *
 *   { title?: string,
 *     content: Array<Array<{ tag: "text"|"img"|"a"|"at"|"emotion", ... }>>
 *   }
 *
 * Each top-level array entry is a paragraph; each paragraph is an array
 * of typed segments. We flatten by:
 *   - prepending title (if present) as `<title>\n\n`
 *   - joining paragraphs with `\n\n`
 *   - joining segments within a paragraph in order
 *   - tag=text → emit segment.text as-is
 *   - tag=a    → emit `[label](href)` (markdown link)
 *   - tag=at   → emit `@user_name` (fallback to `@<user_id>` if no name)
 *   - tag=img  → emit `[图片]` placeholder (actual download via maybeAttachImages)
 *   - tag=emotion → emit `[emoji]`
 *   - unknown tag → skip
 *
 * @internal exported for unit tests.
 */
export function parsePostContent(rawJson: string): string {
  const parsed = JSON.parse(rawJson) as {
    title?: string;
    content?: unknown;
  };
  const out: string[] = [];
  if (parsed.title && parsed.title.trim().length > 0) {
    out.push(parsed.title);
  }
  const paragraphs = Array.isArray(parsed.content) ? parsed.content : [];
  for (const p of paragraphs) {
    if (!Array.isArray(p)) continue;
    let buf = "";
    for (const seg of p) {
      if (!seg || typeof seg !== "object") continue;
      const tag = (seg as { tag?: string }).tag;
      if (tag === "text") {
        buf += String((seg as { text?: string }).text ?? "");
      } else if (tag === "a") {
        const a = seg as { text?: string; href?: string };
        const label = a.text ?? a.href ?? "";
        const href = a.href ?? "";
        if (href) buf += `[${label}](${href})`;
        else if (label) buf += label;
      } else if (tag === "at") {
        const at = seg as { user_name?: string; user_id?: string };
        const name = at.user_name ?? at.user_id ?? "user";
        buf += `@${name}`;
      } else if (tag === "img") {
        buf += "[图片]";
      } else if (tag === "emotion") {
        buf += "[emoji]";
      }
      // unknown tag → skip silently
    }
    if (buf.length > 0) out.push(buf);
  }
  return out.join("\n\n");
}

/**
 * Walk a Feishu `post` content JSON and collect all `image_key` values
 * from `tag: "img"` segments. Used by `maybeAttachImages` to schedule
 * downloads for every image in a 图文混排 message.
 *
 * @internal exported for unit tests.
 */
export function extractPostImageKeys(rawJson: string): string[] {
  try {
    const parsed = JSON.parse(rawJson) as { content?: unknown };
    const paragraphs = Array.isArray(parsed.content) ? parsed.content : [];
    const keys: string[] = [];
    for (const p of paragraphs) {
      if (!Array.isArray(p)) continue;
      for (const seg of p) {
        if (!seg || typeof seg !== "object") continue;
        const tag = (seg as { tag?: string }).tag;
        if (tag === "img") {
          const key = (seg as { image_key?: string }).image_key;
          if (typeof key === "string" && key.length > 0) keys.push(key);
        }
      }
    }
    return keys;
  } catch {
    return [];
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
    if (!resp) {
      process.stderr.write(`[feishu:image] ${messageId} messageResource.get returned falsy (no stream)\n`);
      return null;
    }
    // @larksuiteoapi/node-sdk wraps the HTTP response in an object exposing
    // `getReadableStream()` and `writeFile(path)`, NOT a raw `Readable`.
    // The previous `resp as unknown as Readable` cast made `resp.on(...)`
    // throw `q.on is not a function` (Vincent UAT 2026-06-29 trace caught
    // it after #322 observability ship). Real shape (verified in
    // node_modules/@larksuiteoapi/node-sdk/lib/index.js L398-413):
    //   { writeFile: (p) => Promise<string>,
    //     getReadableStream: () => Readable,
    //     headers: {...} }
    // We use getReadableStream() so the existing mime-check + magic-byte
    // path stays intact (writeFile would land bytes on disk before we
    // can verify they're really an image — defeats the whitelist).
    const respObj = resp as unknown as {
      getReadableStream?: () => Readable;
      writeFile?: (path: string) => Promise<string>;
    };
    if (typeof respObj.getReadableStream !== "function") {
      process.stderr.write(
        `[feishu:image] ${messageId} resp shape unexpected — no getReadableStream() method (lark SDK version drift?)\n`,
      );
      return null;
    }
    const stream = respObj.getReadableStream();
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      stream.on("end", () => resolve());
      stream.on("error", (err: Error) => reject(err));
    });
    const body = Buffer.concat(chunks);
    process.stderr.write(`[feishu:image] ${messageId} stream collected ${body.length} bytes\n`);
    // Magic-byte mime whitelist — reject non-image payloads even if the
    // server marked them as images. Defends against extension confusion +
    // accidental binary delivery.
    const detected = detectImageMime(body);
    if (!detected) {
      const head = body.slice(0, 16).toString("hex");
      process.stderr.write(`[feishu:image] ${messageId} mime rejected (head hex: ${head})\n`);
      return null;
    }
    // Path layout: `<mediaDir>/<conversationId-or-_>/<msg_id>.<ext>` —
    // conversationId subdir keeps a chat's attachments together (easier
    // for an operator to spot-check + GC). msg_id is unique enough across
    // a single conversation; the random suffix in the filename is dropped
    // because msg_id IS the dedup key (idempotencyKey). Collision-safe.
    // Shared with bridge.ts outbound dispatch (RFC-020 §15.1) so inbound
    // download dir == outbound whitelist dir, with zero algorithm drift.
    const subdir = conversationId
      ? join(mediaDir, feishuConvKey(conversationId))
      : mediaDir;
    mkdirSync(subdir, { recursive: true });
    const safeMsgId = messageId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filepath = join(subdir, `${safeMsgId}.${detected.ext}`);
    writeFileSync(filepath, body);
    return filepath;
  } catch (e: any) {
    // Surface the lark/HTTP error so operators can act (99991672 scope,
    // 99992354 invalid id, network, disk-full, etc.) instead of staring
    // at a silent "no image processed".
    const errMsg = e?.message ?? String(e);
    const errCode = e?.response?.data?.code ?? e?.code ?? "";
    process.stderr.write(`[feishu:image] ${messageId} downloadImage threw: code=${errCode} msg=${errMsg}\n`);
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
    return uploadImageBuffer(client, buf);
  } catch {
    return null;
  }
}

/**
 * Upload a raw buffer as an im.image. Used by the markdown-render path
 * (Vincent 2026-06-29) which produces PNG bytes in memory and never
 * lands them on disk. Same lark scope (`im:resource:upload`) as the
 * path-based uploadImage.
 */
async function uploadImageBuffer(
  client: lark.Client,
  buf: Buffer,
): Promise<string | null> {
  try {
    const stream = Readable.from(buf);
    const resp = await client.im.image.create({
      data: {
        image_type: "message",
        image: stream as unknown as never,
      },
    });
    return resp?.image_key ?? null;
  } catch (e: any) {
    process.stderr.write(
      `[feishu:adapter] uploadImageBuffer failed: ${e?.message ?? e}\n`,
    );
    return null;
  }
}

/**
 * Upload a file from disk via `im.file.create`. Caller chooses the
 * `file_name` (Feishu shows this in the chat) and we infer the
 * `file_type` from the filename extension. Returns the lark `file_key`
 * for use in `msg_type:"file"` send. Same `im:resource:upload` scope.
 *
 * Lark accepts file_type enum: `stream` (generic), `doc`, `xls`, `ppt`,
 * `pdf`, `mp4`, `opus`. Extension-to-type mapping is conservative — when
 * in doubt, fall back to `stream`.
 */
async function uploadFile(
  client: lark.Client,
  filePath: string,
  fileName?: string,
): Promise<string | null> {
  try {
    if (!existsSync(filePath)) return null;
    const buf = readFileSync(filePath);
    const stream = Readable.from(buf);
    const name = fileName || filePath.split("/").pop() || "file";
    const ext = (name.split(".").pop() || "").toLowerCase();
    const fileType: "stream" | "doc" | "xls" | "ppt" | "pdf" | "mp4" | "opus" =
      ext === "pdf"
        ? "pdf"
        : ext === "doc" || ext === "docx"
          ? "doc"
          : ext === "xls" || ext === "xlsx"
            ? "xls"
            : ext === "ppt" || ext === "pptx"
              ? "ppt"
              : ext === "mp4"
                ? "mp4"
                : ext === "opus"
                  ? "opus"
                  : "stream";
    const resp = await client.im.file.create({
      data: {
        file_type: fileType,
        file_name: name,
        file: stream as unknown as never,
      },
    });
    return resp?.file_key ?? null;
  } catch (e: any) {
    process.stderr.write(
      `[feishu:adapter] uploadFile failed (${filePath}): ${e?.message ?? e}\n`,
    );
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
