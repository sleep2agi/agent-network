// #5653 — Network-managed Voice ASR config & authenticated Doubao Flash proxy.
//
// Security boundaries:
// - Credentials are encrypted at rest via vault.ts (AES-256-GCM) in a dedicated
//   `network_voice_configs` table isolated from node-facing `network_secrets`.
// - Plaintext API Key / Access Token is NEVER returned in GET/PUT/DELETE/POST
//   responses, NEVER logged, and NEVER written to audit logs.
// - Upstream Volcengine auth errors (401/403) are returned as HTTP 502 with
//   structured `{ ok: false, code: 'auth_failed' | 'not_enabled' }` — NEVER
//   HTTP 401 — so a misconfigured ASR key never triggers client Hub logout.

import { randomUUID } from "node:crypto";
import { db, logAudit } from "./db.js";
import { decryptSecret, encryptSecret, VaultError } from "./vault.js";

export const DOUBAO_DEFAULT_ENDPOINT =
  "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash";
export const DOUBAO_FLASH_RESOURCE_ID = "volc.bigasr.auc_turbo";
/** ~60 s of 16 kHz / 16-bit / mono PCM WAV (~1.92 MB) with headroom. */
export const MAX_WAV_BYTES = 2_500_000;
/** Max HTTP JSON body size for POST /api/voice/recognize (~3.33 MB base64 + JSON envelope). */
export const MAX_RECOGNIZE_BODY_BYTES = 4 * 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 20_000;

export type VoiceProvider = "doubao";
export type VoiceAuthMode = "api-key" | "app-token";

export type VoiceAsrErrorCode =
  | "not_configured"
  | "too_long"
  | "auth_failed"
  | "not_enabled"
  | "rate_limited"
  | "bad_audio"
  | "timeout"
  | "network"
  | "upstream_error";

export const VOICE_WRITE_ERROR_CODES = [
  "invalid_provider",
  "invalid_auth_mode",
  "invalid_app_id",
  "credential_required",
  "invalid_credential",
  "invalid_endpoint",
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
  mode: "hub-proxy";
  provider: VoiceProvider;
  auth_mode: VoiceAuthMode;
  app_id: string;
  key_hint: string;
  endpoint: string;
  can_manage: boolean;
  vault_ready: boolean;
  updated_at: number | null;
}

export interface VoiceConfigWriteInput {
  enabled?: unknown;
  provider?: unknown;
  auth_mode?: unknown;
  app_id?: unknown;
  access_token?: unknown;
  api_key?: unknown;
  endpoint?: unknown;
}

export type VoiceConfigWriteResult =
  | NetworkVoicePublicConfig
  | { ok: false; error: VoiceWriteErrorCode; message: string };

export type VoiceRecognizeResult =
  | { ok: true; status: 200; text: string }
  | { ok: false; status: number; code: VoiceAsrErrorCode; error: string; upstream?: string };

export type VoiceFetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

const BLOCKED_METADATA_HOSTS = new Set([
  "169.254.169.254",
  "100.100.100.200",
  "metadata.google.internal",
  "metadata.goog",
]);

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

/**
 * Validate custom Doubao endpoint override.
 * Blank = use official default. Non-blank must be https:// without embedded
 * userinfo or cloud-metadata hosts. Loopback http:// is permitted only when
 * explicitly enabled (local dev / integration tests) to prevent Hub SSRF.
 */
export function validateVoiceEndpoint(
  input: string,
  opts?: { allowLoopback?: boolean },
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
  const host = u.hostname.toLowerCase();
  if (BLOCKED_METADATA_HOSTS.has(host)) {
    return { ok: false, error: "invalid_endpoint", message: "不允许指向云主机元数据地址" };
  }
  const allowLoopback = opts?.allowLoopback ?? process.env.ANET_VOICE_ALLOW_LOOPBACK_ENDPOINT === "1";
  if (u.protocol === "https:") {
    if (isLoopbackHost(host) && !allowLoopback) {
      return { ok: false, error: "invalid_endpoint", message: "不允许指向 Hub 本机回环地址" };
    }
    return { ok: true, url: u.toString() };
  }
  if (u.protocol === "http:" && isLoopbackHost(host) && allowLoopback) {
    return { ok: true, url: u.toString() };
  }
  return { ok: false, error: "invalid_endpoint", message: "接口地址必须使用 https://" };
}

interface StoredMetaRow {
  enabled: number;
  provider: string;
  auth_mode: string;
  app_id: string;
  endpoint: string;
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
): NetworkVoicePublicConfig {
  const configured = !!row && Number(row.configured) === 1;
  const authMode: VoiceAuthMode = row?.auth_mode === "app-token" ? "app-token" : "api-key";
  return {
    ok: true,
    network_id: networkId,
    enabled: configured && Number(row?.enabled) === 1,
    configured,
    mode: "hub-proxy",
    provider: "doubao",
    auth_mode: authMode,
    app_id: authMode === "app-token" ? (row?.app_id || "") : "",
    key_hint: configured ? (row?.key_hint || "…") : "",
    endpoint: row?.endpoint || "",
    can_manage: canManage,
    vault_ready: isVoiceVaultReady(),
    updated_at: row?.updated_at != null ? Number(row.updated_at) : null,
  };
}

/** Read public non-secret projection for a network. Never selects ciphertext columns. */
export function readNetworkVoiceConfig(networkId: string, canManage: boolean): NetworkVoicePublicConfig {
  const row = db.get<StoredMetaRow>(
    `SELECT enabled, provider, auth_mode, app_id, endpoint, key_hint,
            CASE WHEN ciphertext_b64 IS NOT NULL AND ciphertext_b64 != '' THEN 1 ELSE 0 END AS configured,
            updated_at
       FROM network_voice_configs
      WHERE network_id = ?1`,
    networkId,
  );
  return toPublicConfig(networkId, row, canManage);
}

/** Create or update a network's managed voice config (owner/admin only — caller enforces authz). */
export function saveNetworkVoiceConfig(
  networkId: string,
  actorUserId: string | null,
  actorUsername: string | null,
  input: VoiceConfigWriteInput,
  opts?: { allowLoopback?: boolean },
): VoiceConfigWriteResult {
  const rawProvider = typeof input.provider === "string" ? input.provider.trim().toLowerCase() : "doubao";
  if (rawProvider !== "" && rawProvider !== "doubao") {
    return { ok: false, error: "invalid_provider", message: "仅支持 doubao 语音识别服务" };
  }

  const existing = db.get<StoredSecretRow>(
    `SELECT enabled, provider, auth_mode, app_id, endpoint, key_hint,
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
  const ep = validateVoiceEndpoint(endpointRaw, opts);
  if (!ep.ok) return ep;

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
       (network_id, enabled, provider, auth_mode, app_id, endpoint, key_hint, ciphertext_b64, iv_b64, tag_b64, updated_at, updated_by)
     VALUES (?1, ?2, 'doubao', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
     ON CONFLICT(network_id) DO UPDATE SET
       enabled = ?2,
       provider = 'doubao',
       auth_mode = ?3,
       app_id = ?4,
       endpoint = ?5,
       key_hint = ?6,
       ciphertext_b64 = ?7,
       iv_b64 = ?8,
       tag_b64 = ?9,
       updated_at = ?10,
       updated_by = ?11`,
    [networkId, enabled ? 1 : 0, authMode, appId, ep.url, keyHint, ciphertextB64, ivB64, tagB64, now, actorUserId ?? actorUsername ?? ""],
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

const digits = (s: string | null | undefined): string | undefined => {
  const t = (s ?? "").trim();
  return /^\d{1,12}$/.test(t) ? t : undefined;
};

/** Pure mapping from Volcengine Doubao Flash HTTP status + X-Api-Status-Code + JSON body. */
export function interpretDoubaoFlashResponse(
  httpStatus: number,
  apiStatus: string | null | undefined,
  body: unknown,
): { text: string } | { error: VoiceAsrErrorCode; upstream?: string } {
  const code = digits(apiStatus);
  if (httpStatus === 401) return { error: "auth_failed", upstream: "401" };
  if (httpStatus === 403) return { error: "not_enabled", upstream: "403" };
  if (httpStatus === 429) return { error: "rate_limited", upstream: "429" };
  if (code === "20000003" || code === "45000002") return { text: "" };
  if (code === "45000151") return { error: "bad_audio", upstream: code };
  if (code === "55000031") return { error: "rate_limited", upstream: code };
  if (httpStatus >= 200 && httpStatus < 300 && code === "20000000") {
    const text = (body as { result?: { text?: unknown } } | null)?.result?.text;
    if (typeof text !== "string") return { error: "upstream_error", upstream: "no_text" };
    return { text: text.trim() };
  }
  return { error: "upstream_error", upstream: code ?? (httpStatus ? String(httpStatus) : undefined) };
}

/** Validate base64 WAV payload and enforce MAX_WAV_BYTES cap. */
export function validateWavBase64(
  raw: unknown,
): { ok: true; wavBase64: string; byteLength: number } | { ok: false; status: number; code: "bad_audio" | "too_long"; error: string } {
  if (typeof raw !== "string") {
    return { ok: false, status: 400, code: "bad_audio", error: "wav_base64_required" };
  }
  const cleaned = raw.replace(/\s+/g, "");
  if (!cleaned) {
    return { ok: false, status: 400, code: "bad_audio", error: "wav_base64_empty" };
  }
  // Quick pre-decode length check before allocating buffer.
  const maxBase64Chars = Math.ceil(MAX_WAV_BYTES / 3) * 4 + 4;
  if (cleaned.length > maxBase64Chars) {
    return { ok: false, status: 413, code: "too_long", error: "audio_too_long" };
  }
  if (cleaned.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) {
    return { ok: false, status: 400, code: "bad_audio", error: "invalid_base64" };
  }
  const buf = Buffer.from(cleaned, "base64");
  if (buf.length === 0) {
    return { ok: false, status: 400, code: "bad_audio", error: "wav_base64_empty" };
  }
  if (buf.length > MAX_WAV_BYTES) {
    return { ok: false, status: 413, code: "too_long", error: "audio_too_long" };
  }
  return { ok: true, wavBase64: cleaned, byteLength: buf.length };
}

function asrErrorHttpStatus(code: VoiceAsrErrorCode): number {
  switch (code) {
    case "not_configured": return 409;
    case "too_long": return 413;
    case "bad_audio": return 400;
    case "rate_limited": return 429;
    case "timeout": return 504;
    // Upstream Volcengine 401/403 must NEVER map to HTTP 401/403 so clients do not
    // misclassify a bad ASR credential as an expired ANet Hub login session.
    case "auth_failed":
    case "not_enabled":
    case "network":
    case "upstream_error":
      return 502;
  }
}

/** Proxy one WAV recognition request using the network's encrypted Doubao ASR credentials. */
export async function recognizeNetworkVoice(
  networkId: string,
  wavBase64Input: unknown,
  opts?: { fetchImpl?: VoiceFetchLike; timeoutMs?: number; requestId?: string; allowLoopback?: boolean },
): Promise<VoiceRecognizeResult> {
  const row = db.get<StoredSecretRow>(
    `SELECT enabled, provider, auth_mode, app_id, endpoint, key_hint,
            ciphertext_b64, iv_b64, tag_b64,
            CASE WHEN ciphertext_b64 IS NOT NULL AND ciphertext_b64 != '' THEN 1 ELSE 0 END AS configured,
            updated_at
       FROM network_voice_configs
      WHERE network_id = ?1`,
    networkId,
  );
  if (!row || Number(row.configured) !== 1 || Number(row.enabled) !== 1) {
    return { ok: false, status: 409, code: "not_configured", error: "voice_not_configured" };
  }

  const audio = validateWavBase64(wavBase64Input);
  if (!audio.ok) {
    return { ok: false, status: audio.status, code: audio.code, error: audio.error };
  }

  const ep = validateVoiceEndpoint(row.endpoint || "", opts);
  if (!ep.ok) {
    return { ok: false, status: 502, code: "upstream_error", error: "invalid_configured_endpoint" };
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
    return { ok: false, status: 503, code: "upstream_error", error: errCode };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Api-Resource-Id": DOUBAO_FLASH_RESOURCE_ID,
    "X-Api-Request-Id": opts?.requestId ?? randomUUID(),
    "X-Api-Sequence": "-1",
  };
  if (row.auth_mode === "app-token" && row.app_id) {
    headers["X-Api-App-Key"] = row.app_id;
    headers["X-Api-Access-Key"] = accessToken;
  } else {
    headers["X-Api-Key"] = accessToken;
  }

  const url = ep.url || DOUBAO_DEFAULT_ENDPOINT;
  const payload = JSON.stringify({
    user: { uid: "anet-hub-voice" },
    audio: { data: audio.wavBase64, format: "wav" },
    request: { model_name: "bigmodel", enable_itn: true, enable_punc: true },
  });

  const fetchImpl: VoiceFetchLike = opts?.fetchImpl ?? ((u, init) => fetch(u, init));
  const timeoutMs = opts?.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);

  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: payload,
      signal: ctrl.signal,
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const interpreted = interpretDoubaoFlashResponse(
      res.status,
      res.headers.get("X-Api-Status-Code"),
      body,
    );
    if ("error" in interpreted) {
      return {
        ok: false,
        status: asrErrorHttpStatus(interpreted.error),
        code: interpreted.error,
        error: interpreted.error,
        ...(interpreted.upstream ? { upstream: interpreted.upstream } : {}),
      };
    }
    return { ok: true, status: 200, text: interpreted.text };
  } catch {
    if (timedOut) {
      return { ok: false, status: 504, code: "timeout", error: "upstream_timeout" };
    }
    return { ok: false, status: 502, code: "network", error: "upstream_network_error" };
  } finally {
    clearTimeout(timer);
  }
}
