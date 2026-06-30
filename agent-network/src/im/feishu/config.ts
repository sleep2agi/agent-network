/**
 * RFC-020 §3.1 / §5.2 — Feishu channel config loader.
 *
 * Reads `.anet/nodes/<node>/channels/feishu/`:
 *   - `.env`         FEISHU_APP_ID + FEISHU_APP_SECRET (chmod 600, not in git)
 *   - `access.json`  { allowFrom: [open_id, ...], allowChats: [chat_id, ...] }
 *
 * Secrets stay agent-local; never uploaded to the hub (RFC-020 §5.3).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface FeishuChannelEnv {
  FEISHU_APP_ID: string;
  FEISHU_APP_SECRET: string;
}

export interface FeishuAccessList {
  /** Feishu open_ids permitted to DM the bot. */
  allowFrom: string[];
  /** Feishu chat_ids the bot is permitted to listen in. */
  allowChats: string[];
}

/**
 * Outbound text-reply rendering mode (RFC-020 §16). Controls how
 * `adapter.send` handles a text/markdown payload that doesn't already
 * carry an `imagePath` / `files[]` (those upload routes are unaffected).
 *
 *  - "plain" (DEFAULT): always send `msg_type:text`. Bot replies are
 *    fully copy-pasteable in Feishu; long replies are chunked into
 *    multiple text messages instead of being PNG-rendered. This is the
 *    correct default for issue/code/CLI bot replies where users want
 *    to grab the text. Vincent 2026-06-30 explicit ask: "issue 发文字".
 *
 *  - "card": short markdown (bold, list, link, inline code) goes via
 *    schema 1.0 interactive card with `markdown` element — text stays
 *    copy-friendly + gets bolds/bullets styled. Heading/table/long
 *    fall back to plain text (no PNG). Suited to operators who want
 *    light formatting without losing copy.
 *
 *  - "auto": preserve the pre-2026-06-30 behavior — markdown with
 *    headings / tables / >2000 chars is rendered to PNG via headless
 *    chromium (#329 path), short markdown goes to schema 1.0 card,
 *    plain text goes to msg_type:text. Highest fidelity at the cost
 *    of copy-paste. Opt-in for operators who genuinely need rendered
 *    tables / heading hierarchy in chat.
 */
export type OutboundRenderMode = "plain" | "card" | "auto";

export interface FeishuChannelConfig {
  appId: string;
  appSecret: string;
  access: FeishuAccessList;
  /** RFC-020 §4.3 group trigger policy. Default `mention`. */
  groupPolicy: "mention" | "command" | "all" | "observe";
  /** Send a "⏳ 处理中…" placeholder before agent reply (RFC-020 §4.2). */
  ackPlaceholder: boolean;
  /** Persist redacted raw payload to local audit log (RFC-020 §2.3 / §12.10). */
  auditRaw: boolean;
  /** Per-task timeout in ms; default 5 min (RFC-020 §4.5). */
  taskTimeoutMs: number;
  /**
   * RFC-020 §16 outbound rendering mode for text replies. Default `"plain"`.
   * See `OutboundRenderMode` for per-mode semantics. Channels that omit
   * the field get `"plain"` — Vincent's "issue 发文字" default.
   */
  outboundRender: OutboundRenderMode;
  /**
   * Absolute path to the channel directory. The adapter writes downloaded
   * inbound media to `<channelDir>/media/` (M5c). Populated by the loader so
   * callers do not have to thread it separately.
   */
  channelDir: string;
}

/**
 * Load Feishu channel config from a node's channels/feishu directory.
 * Throws if required secrets are missing.
 */
export function loadFeishuChannelConfig(channelDir: string): FeishuChannelConfig {
  const env = parseEnvFile(join(channelDir, ".env"));
  const appId = env.FEISHU_APP_ID;
  const appSecret = env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error(
      `feishu channel: FEISHU_APP_ID / FEISHU_APP_SECRET missing in ${channelDir}/.env`,
    );
  }
  const access = readAccessFile(join(channelDir, "access.json"));
  // Outbound render mode: prefer access.json `outboundRender`, fall back
  // to env `FEISHU_OUTBOUND_RENDER`, default "plain". The access.json
  // field is the operator-facing knob (committed to a node's config dir);
  // the env override is for one-off testing without editing files.
  const raw =
    (typeof access?.outboundRender === "string" && access.outboundRender) ||
    (typeof env.FEISHU_OUTBOUND_RENDER === "string" && env.FEISHU_OUTBOUND_RENDER) ||
    "plain";
  const outboundRender: OutboundRenderMode =
    raw === "card" || raw === "auto" ? raw : "plain";
  return {
    appId,
    appSecret,
    access,
    groupPolicy: "mention",
    ackPlaceholder: true,
    auditRaw: false,
    taskTimeoutMs: 5 * 60 * 1000,
    outboundRender,
    channelDir,
  };
}

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    out[k] = v;
  }
  return out;
}

interface AccessFileShape extends FeishuAccessList {
  /** Optional outbound render mode (RFC-020 §16). Mirrors the same field
   *  on FeishuChannelConfig; loaded here so operators can set it in the
   *  per-channel access.json without touching code. */
  outboundRender?: string;
}

function readAccessFile(path: string): AccessFileShape {
  if (!existsSync(path)) return { allowFrom: [], allowChats: [] };
  try {
    const data = JSON.parse(readFileSync(path, "utf-8")) as Partial<AccessFileShape>;
    return {
      allowFrom: Array.isArray(data.allowFrom) ? data.allowFrom : [],
      allowChats: Array.isArray(data.allowChats) ? data.allowChats : [],
      outboundRender:
        typeof data.outboundRender === "string" ? data.outboundRender : undefined,
    };
  } catch {
    return { allowFrom: [], allowChats: [] };
  }
}
