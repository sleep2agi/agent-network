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
  return {
    appId,
    appSecret,
    access,
    groupPolicy: "mention",
    ackPlaceholder: true,
    auditRaw: false,
    taskTimeoutMs: 5 * 60 * 1000,
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

function readAccessFile(path: string): FeishuAccessList {
  if (!existsSync(path)) return { allowFrom: [], allowChats: [] };
  try {
    const data = JSON.parse(readFileSync(path, "utf-8")) as Partial<FeishuAccessList>;
    return {
      allowFrom: Array.isArray(data.allowFrom) ? data.allowFrom : [],
      allowChats: Array.isArray(data.allowChats) ? data.allowChats : [],
    };
  } catch {
    return { allowFrom: [], allowChats: [] };
  }
}
