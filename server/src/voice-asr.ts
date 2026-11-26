// #5653 — Network-managed Voice ASR config & authenticated member key distribution.
//
// Design (direct-to-ASR key distribution, no audio forwarding through Hub):
// - Network owner/admin saves Doubao ASR credentials once on the Hub.
// - Credentials are encrypted at rest via vault.ts (AES-256-GCM) in a dedicated
//   `network_voice_configs` table strictly isolated from node-facing `network_secrets`.
// - GET /api/voice/config returns non-secret metadata + availability for UI/status.
// - GET /api/voice/credentials issues the decrypted credentials ONLY to authenticated
//   human members of that network (never node tokens, never outsiders, Cache-Control: no-store)
//   so clients connect directly to Volcengine Doubao (both real-time streaming and flash)
//   with zero Hub audio bandwidth/latency overhead.

import { db, logAudit } from "./db.js";
import { decryptSecret, encryptSecret, VaultError } from "./vault.js";

export type VoiceProvider = "doubao";
export type VoiceAuthMode = "api-key" | "app-token";

export const STREAM_RESOURCE_IDS = [
  "volc.bigasr.sauc.duration",
  "volc.bigasr.sauc.concurrent",
  "volc.seedasr.sauc.duration",
  "volc.seedasr.sauc.concurrent",
] as const;

export type StreamResourceId = (typeof STREAM_RESOURCE_IDS)[number];

const STREAM_RESOURCE_SET = new Set<string>(STREAM_RESOURCE_IDS);

export const VOICE_WRITE_ERROR_CODES = [
  "invalid_provider",
  "invalid_auth_mode",
  "invalid_app_id",
  "credential_required",
  "invalid_credential",
  "invalid_endpoint",
  "invalid_stream_endpoint",
  "invalid_stream_resource_id",
  "vault_master_key_missing",
  "vault_master_key_invalid",
  "vault_unavailable",
] as const;

export type VoiceWriteErrorCode = (typeof VOICE_WRITE_ERROR_CODES)[number];

export const VOICE_WRITE_STATUS: Record<VoiceWriteErrorCode, number> = {
  invalid_provider: 400,
  invalid_auth_mode: 400,
  invalid_app_id: 400,
  credential_required: 400,
  invalid_credential: 400,
  invalid_endpoint: 400,
  invalid_stream_endpoint: 400,
  invalid_stream_resource_id: 400,
  vault_master_key_missing: 503,
  vault_master_key_invalid: 503,
  vault_unavailable: 503,
};

export function voiceWriteStatus(code: VoiceWriteErrorCode): number {
  return VOICE_WRITE_STATUS[code];
}

export interface NetworkVoicePublicConfig {
  ok: true;
  network_id: string;
  enabled: boolean;
  configured: boolean;
  mode: "hub-key";
  provider: VoiceProvider;
  auth_mode: VoiceAuthMode;
  app_id: string;
  key_hint: string;
  endpoint: string;
  stream_endpoint: string;
  stream_resource_id: string;
  can_use: boolean;
  can_manage: boolean;
  vault_ready: boolean;
  updated_at: number | null;
}

export interface DistributedVoiceCredentials {
  provider: VoiceProvider;
  auth_mode: VoiceAuthMode;
  app_id: string;
  access_token: string;
  endpoint: string;
  stream_endpoint: string;
  stream_resource_id: string;
}

export type VoiceCredentialsReadResult =
  | {
      ok: true;
      status: 200;
      network_id: string;
      enabled: true;
      configured: true;
      mode: "hub-key";
      provider: VoiceProvider;
      credentials: DistributedVoiceCredentials;
      updated_at: number | null;
    }
  | { ok: false; status: number; error: string; message: string };

export interface VoiceConfigWriteInput {
  enabled?: unknown;
  provider?: unknown;
  auth_mode?: unknown;
  app_id?: unknown;
  access_token?: unknown;
  api_key?: unknown;
  endpoint?: unknown;
  stream_endpoint?: unknown;
  stream_resource_id?: unknown;
}

export type VoiceConfigWriteResult =
  | NetworkVoicePublicConfig
  | { ok: false; error: VoiceWriteErrorCode; message: string };

function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}

/** Mask secret to tail 4 chars only; values shorter than 8 chars collapse to "…". */
export function maskVoiceSecretTail(secret: string): string {
  const s = secret.trim();
  if (!s) return "";
  if (s.length < 8) return "…";
  return `…${s.slice(-4)}`;
}

export function isVoiceVaultReady(): boolean {
  const hex = process.env.ANET_HUB_SECRET_VAULT_KEY;
  return !!hex && /^[0-9a-fA-F]{64}$/.test(hex);
}

/** Validate optional custom Doubao Flash endpoint (blank = official default; must be https:// or loopback http://). */
export function validateVoiceEndpoint(
  input: string,
): { ok: true; url: string } | { ok: false; error: "invalid_endpoint"; message: string } {
  const s = input.trim();
  if (!s) return { ok: true, url: "" };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: "invalid_endpoint", message: "接口地址不是合法的 URL" };
  }
  if (u.username || u.password) {
    return { ok: false, error: "invalid_endpoint", message: "接口地址不能包含内嵌账号密码" };
  }
  if (u.protocol === "https:") return { ok: true, url: u.toString() };
  if (u.protocol === "http:" && isLoopbackHost(u.hostname)) return { ok: true, url: u.toString() };
  return { ok: false, error: "invalid_endpoint", message: "接口地址必须使用 https://（本机回环除外）" };
}

/** Validate optional custom Doubao Streaming endpoint (blank = official default; must be wss:// or loopback ws://). */
export function validateVoiceStreamEndpoint(
  input: string,
): { ok: true; url: string } | { ok: false; error: "invalid_stream_endpoint"; message: string } {
  const s = input.trim();
  if (!s) return { ok: true, url: "" };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: "invalid_stream_endpoint", message: "流式接口地址不是合法的 URL" };
  }
  if (u.username || u.password) {
    return { ok: false, error: "invalid_stream_endpoint", message: "流式接口地址不能包含内嵌账号密码" };
  }
  if (u.protocol === "wss:") return { ok: true, url: u.toString() };
  if (u.protocol === "ws:" && isLoopbackHost(u.hostname)) return { ok: true, url: u.toString() };
  return { ok: false, error: "invalid_stream_endpoint", message: "流式接口地址必须使用 wss://（本机回环除外）" };
}

interface StoredMetaRow {
  enabled: number;
  provider: string;
  auth_mode: string;
  app_id: string;
  endpoint: string;
  stream_endpoint: string;
  stream_resource_id: string;
  key_hint: string;
  configured: number;
  updated_at: number | null;
}

interface StoredSecretRow extends StoredMetaRow {
  ciphertext_b64: string;
  iv_b64: string;
  tag_b64: string;
}

function toPublicConfig(
  networkId: string,
  row: StoredMetaRow | null | undefined,
  canManage: boolean,
  canUse: boolean,
): NetworkVoicePublicConfig {
  const configured = !!row && Number(row.configured) === 1;
  const authMode: VoiceAuthMode = row?.auth_mode === "app-token" ? "app-token" : "api-key";
  return {
    ok: true,
    network_id: networkId,
    enabled: configured && Number(row?.enabled) === 1,
    configured,
    mode: "hub-key",
    provider: "doubao",
    auth_mode: authMode,
    app_id: authMode === "app-token" ? (row?.app_id || "") : "",
    key_hint: configured ? (row?.key_hint || "…") : "",
    endpoint: row?.endpoint || "",
    stream_endpoint: row?.stream_endpoint || "",
    stream_resource_id: row?.stream_resource_id || "",
    can_use: canUse,
    can_manage: canManage,
    vault_ready: isVoiceVaultReady(),
    updated_at: row?.updated_at != null ? Number(row.updated_at) : null,
  };
}

/** Read public non-secret projection for a network. Never selects ciphertext columns. */
export function readNetworkVoiceConfig(
  networkId: string,
  canManage: boolean,
  canUse = true,
): NetworkVoicePublicConfig {
  const row = db.get<StoredMetaRow>(
    `SELECT enabled, provider, auth_mode, app_id, endpoint, stream_endpoint, stream_resource_id, key_hint,
            CASE WHEN ciphertext_b64 IS NOT NULL AND ciphertext_b64 != '' THEN 1 ELSE 0 END AS configured,
            updated_at
       FROM network_voice_configs
      WHERE network_id = ?1`,
    networkId,
  );
  return toPublicConfig(networkId, row, canManage, canUse);
}

/** Decrypt & issue active network voice credentials to an authorized member (caller enforces authz) and record audit trail. */
export function readNetworkVoiceCredentials(
  networkId: string,
  actor?: { userId: string | null; username: string | null },
): VoiceCredentialsReadResult {
  const row = db.get<StoredSecretRow>(
    `SELECT enabled, provider, auth_mode, app_id, endpoint, stream_endpoint, stream_resource_id, key_hint,
            ciphertext_b64, iv_b64, tag_b64,
            CASE WHEN ciphertext_b64 IS NOT NULL AND ciphertext_b64 != '' THEN 1 ELSE 0 END AS configured,
            updated_at
       FROM network_voice_configs
      WHERE network_id = ?1`,
    networkId,
  );
  if (!row || Number(row.configured) !== 1 || Number(row.enabled) !== 1) {
    return { ok: false, status: 409, error: "voice_not_configured", message: "当前网络未启用服务器语音配置" };
  }
  let accessToken: string;
  try {
    accessToken = decryptSecret({
      ciphertext: Buffer.from(row.ciphertext_b64, "base64"),
      iv: Buffer.from(row.iv_b64, "base64"),
      tag: Buffer.from(row.tag_b64, "base64"),
    });
  } catch (e) {
    const errCode = e instanceof VaultError ? e.code : "vault_decrypt_failed";
    return { ok: false, status: 503, error: errCode, message: "Hub 加密主密钥不可用，无法读取语音配置" };
  }
  const authMode: VoiceAuthMode = row.auth_mode === "app-token" ? "app-token" : "api-key";
  logAudit(
    actor?.userId ?? null,
    actor?.username ?? null,
    "voice_credentials.issue",
    "network_voice",
    networkId,
    JSON.stringify({ auth_mode: authMode }),
    undefined,
    networkId,
  );
  return {
    ok: true,
    status: 200,
    network_id: networkId,
    enabled: true,
    configured: true,
    mode: "hub-key",
    provider: "doubao",
    credentials: {
      provider: "doubao",
      auth_mode: authMode,
      app_id: authMode === "app-token" ? (row.app_id || "") : "",
      access_token: accessToken,
      endpoint: row.endpoint || "",
      stream_endpoint: row.stream_endpoint || "",
      stream_resource_id: row.stream_resource_id || "",
    },
    updated_at: row.updated_at != null ? Number(row.updated_at) : null,
  };
}

/** Create or update a network's managed voice config (owner/admin only — caller enforces authz). */
export function saveNetworkVoiceConfig(
  networkId: string,
  actorUserId: string | null,
  actorUsername: string | null,
  input: VoiceConfigWriteInput,
): VoiceConfigWriteResult {
  const rawProvider = typeof input.provider === "string" ? input.provider.trim().toLowerCase() : "doubao";
  if (rawProvider !== "" && rawProvider !== "doubao") {
    return { ok: false, error: "invalid_provider", message: "仅支持 doubao 语音识别服务" };
  }

  const existing = db.get<StoredSecretRow>(
    `SELECT enabled, provider, auth_mode, app_id, endpoint, stream_endpoint, stream_resource_id, key_hint,
            ciphertext_b64, iv_b64, tag_b64,
            CASE WHEN ciphertext_b64 IS NOT NULL AND ciphertext_b64 != '' THEN 1 ELSE 0 END AS configured,
            updated_at
       FROM network_voice_configs
      WHERE network_id = ?1`,
    networkId,
  );
  const existingHasSecret = !!existing && Number(existing.configured) === 1 && !!existing.ciphertext_b64 && !!existing.iv_b64 && !!existing.tag_b64;
  const existingMode: VoiceAuthMode = existing?.auth_mode === "app-token" ? "app-token" : "api-key";

  const rawAppId = typeof input.app_id === "string" ? input.app_id.trim() : undefined;
  let authMode: VoiceAuthMode;
  if (input.auth_mode === undefined || input.auth_mode === null || input.auth_mode === "") {
    if (rawAppId) authMode = "app-token";
    else if (existingHasSecret && rawAppId === undefined && input.api_key === undefined && input.access_token === undefined) authMode = existingMode;
    else authMode = "api-key";
  } else if (input.auth_mode === "api-key" || input.auth_mode === "app-token") {
    authMode = input.auth_mode;
  } else {
    return { ok: false, error: "invalid_auth_mode", message: "auth_mode 必须为 api-key 或 app-token" };
  }

  let appId = "";
  if (authMode === "app-token") {
    appId = rawAppId !== undefined ? rawAppId : (existingMode === "app-token" ? (existing?.app_id || "") : "");
    if (!appId) {
      return { ok: false, error: "invalid_app_id", message: "旧版控制台模式需要填写 App ID" };
    }
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(appId)) {
      return { ok: false, error: "invalid_app_id", message: "App ID 只能包含字母、数字、- 或 _" };
    }
  }

  const rawSecret =
    typeof input.access_token === "string" && input.access_token.trim()
      ? input.access_token.trim()
      : typeof input.api_key === "string" && input.api_key.trim()
        ? input.api_key.trim()
        : "";

  if (rawSecret && (/[\s\x00-\x1f\x7f]/.test(rawSecret) || rawSecret.length > 4096)) {
    return { ok: false, error: "invalid_credential", message: "密钥格式无效（不能包含空格、换行或控制字符）" };
  }

  const endpointRaw = typeof input.endpoint === "string" ? input.endpoint : (existing?.endpoint || "");
  const ep = validateVoiceEndpoint(endpointRaw);
  if (!ep.ok) return ep;

  const streamEndpointRaw = typeof input.stream_endpoint === "string" ? input.stream_endpoint : (existing?.stream_endpoint || "");
  const sep = validateVoiceStreamEndpoint(streamEndpointRaw);
  if (!sep.ok) return sep;

  const streamResourceIdRaw =
    typeof input.stream_resource_id === "string"
      ? input.stream_resource_id.trim()
      : (existing?.stream_resource_id || "");
  if (streamResourceIdRaw && !STREAM_RESOURCE_SET.has(streamResourceIdRaw)) {
    return { ok: false, error: "invalid_stream_resource_id", message: "流式资源 ID 不是豆包控制台提供的有效选项" };
  }

  const enabled = typeof input.enabled === "boolean"
    ? input.enabled
    : (existing ? Number(existing.enabled) === 1 : true);

  let ciphertextB64: string;
  let ivB64: string;
  let tagB64: string;
  let keyHint: string;

  if (rawSecret) {
    try {
      const enc = encryptSecret(rawSecret);
      ciphertextB64 = enc.ciphertext.toString("base64");
      ivB64 = enc.iv.toString("base64");
      tagB64 = enc.tag.toString("base64");
      keyHint = maskVoiceSecretTail(rawSecret);
    } catch (e) {
      if (e instanceof VaultError) {
        const code: VoiceWriteErrorCode =
          e.code === "vault_master_key_missing" ? "vault_master_key_missing"
            : e.code === "vault_master_key_invalid" ? "vault_master_key_invalid"
            : "vault_unavailable";
        const message =
          code === "vault_master_key_missing"
            ? "Hub 未配置加密主密钥（ANET_HUB_SECRET_VAULT_KEY），无法加密保存语音密钥"
            : code === "vault_master_key_invalid"
              ? "Hub 加密主密钥（ANET_HUB_SECRET_VAULT_KEY）格式无效，需为 64 位十六进制"
              : "Hub 加密服务暂不可用";
        return { ok: false, error: code, message };
      }
      return { ok: false, error: "vault_unavailable", message: "Hub 加密服务暂不可用" };
    }
  } else if (existingHasSecret && existingMode === authMode) {
    ciphertextB64 = existing!.ciphertext_b64;
    ivB64 = existing!.iv_b64;
    tagB64 = existing!.tag_b64;
    keyHint = existing!.key_hint;
  } else {
    return {
      ok: false,
      error: "credential_required",
      message: authMode === "app-token" ? "请填写 Access Token" : "请填写 API Key",
    };
  }

  const now = Date.now();
  db.run(
    `INSERT INTO network_voice_configs
       (network_id, enabled, provider, auth_mode, app_id, endpoint, stream_endpoint, stream_resource_id, key_hint, ciphertext_b64, iv_b64, tag_b64, updated_at, updated_by)
     VALUES (?1, ?2, 'doubao', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
     ON CONFLICT(network_id) DO UPDATE SET
       enabled = ?2,
       provider = 'doubao',
       auth_mode = ?3,
       app_id = ?4,
       endpoint = ?5,
       stream_endpoint = ?6,
       stream_resource_id = ?7,
       key_hint = ?8,
       ciphertext_b64 = ?9,
       iv_b64 = ?10,
       tag_b64 = ?11,
       updated_at = ?12,
       updated_by = ?13`,
    [networkId, enabled ? 1 : 0, authMode, appId, ep.url, sep.url, streamResourceIdRaw, keyHint, ciphertextB64, ivB64, tagB64, now, actorUserId ?? actorUsername ?? ""],
  );

  logAudit(
    actorUserId,
    actorUsername,
    "voice_config.upsert",
    "network_voice",
    networkId,
    JSON.stringify({
      enabled,
      provider: "doubao",
      auth_mode: authMode,
      custom_endpoint: !!ep.url,
      custom_stream_endpoint: !!sep.url,
      stream_resource_id: streamResourceIdRaw || undefined,
      key_rotated: !!rawSecret,
    }),
    undefined,
    networkId,
  );

  return readNetworkVoiceConfig(networkId, true);
}

/** Delete a network's managed voice config (owner/admin only). */
export function deleteNetworkVoiceConfig(
  networkId: string,
  actorUserId: string | null,
  actorUsername: string | null,
): NetworkVoicePublicConfig {
  db.run("DELETE FROM network_voice_configs WHERE network_id = ?1", [networkId]);
  logAudit(actorUserId, actorUsername, "voice_config.delete", "network_voice", networkId, "cleared", undefined, networkId);
  return readNetworkVoiceConfig(networkId, true);
}
