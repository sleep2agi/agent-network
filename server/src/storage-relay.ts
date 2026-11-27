// External storage relay config & direct upload/download orchestration.
//
// Motivation:
// Hub server bandwidth is often limited. Instead of proxying images, videos, and
// large attachments through the Hub, a network owner/admin configures an external
// storage backend once on the Hub (encrypted at rest via vault.ts AES-256-GCM in
// `network_storage_configs`, isolated from node-facing `network_secrets`):
//
//   1. ModelScope (魔搭社区 Dataset/Model repo LFS — pure HTTP, zero Python deps)
//   2. Aliyun OSS (OSS4-HMAC-SHA256 presigned PUT / GET URLs)
//   3. AWS S3 / S3-compatible (AWS4-HMAC-SHA256 presigned PUT / GET URLs)
//
// Data flow (0 file bytes pass through the Hub):
//   Upload:   Client → POST /api/uploads/presign (metadata + sha256)
//                    → Direct PUT bytes to ModelScope / OSS / S3
//                    → POST /api/uploads/complete (ModelScope LFS commit / S3 HEAD verify)
//   Download: Client → GET /api/files/:id/direct (Hub enforces ACL & returns direct target)
//                    → Direct GET bytes from ModelScope / OSS / S3

import { createHash, createHmac } from "node:crypto";
import { db, logAudit } from "./db.js";
import { decryptSecret, encryptSecret, VaultError } from "./vault.js";
import {
  DEFAULT_REMOTE_UPLOAD_BYTES,
  MAX_REMOTE_UPLOAD_BYTES,
  MIN_REMOTE_UPLOAD_BYTES,
  type RemoteStorageIndexMeta,
  type RemoteStorageProvider,
} from "./uploads.js";

export type StorageProvider = RemoteStorageProvider;
export type ModelScopeRepoType = "dataset" | "model";

export const STORAGE_PROVIDERS = ["modelscope", "oss", "s3"] as const;
export const DEFAULT_MODELSCOPE_ENDPOINT = "https://www.modelscope.cn";
export const DEFAULT_MODELSCOPE_REVISION = "master";
export const DEFAULT_STORAGE_PREFIX = "anet-files";
export const PRESIGN_TTL_SECONDS = 900; // 15 minutes

export const STORAGE_WRITE_ERROR_CODES = [
  "invalid_provider",
  "invalid_repo_id",
  "invalid_repo_type",
  "invalid_revision",
  "invalid_bucket",
  "invalid_region",
  "invalid_endpoint",
  "invalid_public_base_url",
  "invalid_prefix",
  "invalid_max_file_bytes",
  "credential_required",
  "invalid_credential",
  "vault_master_key_missing",
  "vault_master_key_invalid",
  "vault_unavailable",
] as const;

export type StorageWriteErrorCode = (typeof STORAGE_WRITE_ERROR_CODES)[number];

export const STORAGE_WRITE_STATUS: Record<StorageWriteErrorCode, number> = {
  invalid_provider: 400,
  invalid_repo_id: 400,
  invalid_repo_type: 400,
  invalid_revision: 400,
  invalid_bucket: 400,
  invalid_region: 400,
  invalid_endpoint: 400,
  invalid_public_base_url: 400,
  invalid_prefix: 400,
  invalid_max_file_bytes: 400,
  credential_required: 400,
  invalid_credential: 400,
  vault_master_key_missing: 503,
  vault_master_key_invalid: 503,
  vault_unavailable: 503,
};

export function storageWriteStatus(code: StorageWriteErrorCode): number {
  return STORAGE_WRITE_STATUS[code];
}

export interface NetworkStoragePublicConfig {
  ok: true;
  network_id: string;
  enabled: boolean;
  configured: boolean;
  provider: StorageProvider;
  endpoint: string;
  region: string;
  bucket: string;
  repo_id: string;
  repo_type: ModelScopeRepoType;
  revision: string;
  prefix: string;
  public_base_url: string;
  max_file_bytes: number;
  key_hint: string;
  can_manage: boolean;
  vault_ready: boolean;
  updated_at: number | null;
}

export interface StorageConfigWriteInput {
  enabled?: unknown;
  provider?: unknown;
  endpoint?: unknown;
  region?: unknown;
  bucket?: unknown;
  repo_id?: unknown;
  repo_type?: unknown;
  revision?: unknown;
  prefix?: unknown;
  public_base_url?: unknown;
  max_file_bytes?: unknown;
  /** ModelScope API token. */
  api_token?: unknown;
  token?: unknown;
  /** Aliyun OSS / AWS S3 credentials. */
  access_key_id?: unknown;
  access_key_secret?: unknown;
  secret_access_key?: unknown;
  session_token?: unknown;
}

export type StorageConfigWriteResult =
  | NetworkStoragePublicConfig
  | { ok: false; error: StorageWriteErrorCode; message: string };

interface StoredStorageSecrets {
  token?: string;
  access_key_id?: string;
  access_key_secret?: string;
  session_token?: string;
}

interface StoredMetaRow {
  enabled: number;
  provider: string;
  endpoint: string;
  region: string;
  bucket: string;
  repo_id: string;
  repo_type: string;
  revision: string;
  prefix: string;
  public_base_url: string;
  max_file_bytes: number;
  key_hint: string;
  configured: number;
  updated_at: number | null;
}

interface StoredSecretRow extends StoredMetaRow {
  ciphertext_b64: string;
  iv_b64: string;
  tag_b64: string;
}

export interface ActiveStorageRuntimeConfig {
  network_id: string;
  enabled: boolean;
  provider: StorageProvider;
  endpoint: string;
  region: string;
  bucket: string;
  repo_id: string;
  repo_type: ModelScopeRepoType;
  revision: string;
  prefix: string;
  public_base_url: string;
  max_file_bytes: number;
  secrets: StoredStorageSecrets;
}

export interface StorageTestResult {
  ok: boolean;
  provider: StorageProvider;
  latency_ms: number;
  visibility?: "private" | "public" | "unknown";
  warning?: string;
  message: string;
  error?: string;
}

export interface DirectUploadInstruction {
  method: "PUT";
  url: string;
  headers: Record<string, string>;
}

export type PresignStorageResult =
  | {
      ok: true;
      provider: StorageProvider;
      object_key: string;
      skip_upload: boolean;
      upload: DirectUploadInstruction | null;
      storage_meta: RemoteStorageIndexMeta;
    }
  | { ok: false; status: number; error: string; message: string };

export type CompleteStorageResult =
  | { ok: true }
  | { ok: false; status: number; error: string; message: string };

export type ResolveDownloadResult =
  | {
      ok: true;
      provider: StorageProvider;
      url: string;
      headers: Record<string, string>;
      expires_in: number;
    }
  | { ok: false; status: number; error: string; message: string };

function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[") || host.includes(":");
}

/** Mask secret to tail 4 chars only; values shorter than 8 chars collapse to "…". */
export function maskStorageSecretTail(secret: string): string {
  const s = secret.trim();
  if (!s) return "";
  if (s.length < 8) return "…";
  return `…${s.slice(-4)}`;
}

export function isStorageVaultReady(): boolean {
  const hex = process.env.ANET_HUB_SECRET_VAULT_KEY;
  return !!hex && /^[0-9a-fA-F]{64}$/.test(hex);
}

function normalizeProvider(raw: unknown, fallback: StorageProvider = "modelscope"): StorageProvider | null {
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (v === "modelscope" || v === "oss" || v === "s3") return v;
  return null;
}

function normalizeRepoType(raw: unknown, fallback: ModelScopeRepoType = "dataset"): ModelScopeRepoType | null {
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (v === "dataset" || v === "datasets") return "dataset";
  if (v === "model" || v === "models") return "model";
  return null;
}

/** Validate optional HTTPS URL (loopback http:// allowed for local tests/dev). */
export function validateStorageUrl(
  input: string,
  errorCode: "invalid_endpoint" | "invalid_public_base_url",
): { ok: true; url: string } | { ok: false; error: "invalid_endpoint" | "invalid_public_base_url"; message: string } {
  const s = input.trim();
  if (!s) return { ok: true, url: "" };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: errorCode, message: "地址不是合法的 URL" };
  }
  if (u.username || u.password) {
    return { ok: false, error: errorCode, message: "地址不能包含内嵌账号密码" };
  }
  if (u.protocol === "https:" || (u.protocol === "http:" && isLoopbackHost(u.hostname))) {
    return { ok: true, url: u.toString().replace(/\/+$/, "") };
  }
  return { ok: false, error: errorCode, message: "地址必须使用 https://（本机回环除外）" };
}

export function validateModelScopeRepoId(input: string): string | null {
  const s = input.trim().replace(/^\/+|\/+$/g, "");
  if (!/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,120}$/.test(s)) return null;
  if (s.includes("..")) return null;
  return s;
}

export function validateModelScopeRevision(input: string): string | null {
  const s = input.trim().replace(/^\/+|\/+$/g, "");
  if (!s) return DEFAULT_MODELSCOPE_REVISION;
  if (!/^[A-Za-z0-9._/-]{1,80}$/.test(s) || s.includes("..")) return null;
  return s;
}

export function validateBucketName(input: string): string | null {
  const s = input.trim();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(s)) return null;
  if (s.includes("..")) return null;
  return s;
}

export function validateRegion(input: string): string | null {
  const s = input.trim().toLowerCase();
  if (!/^[a-z0-9-]{2,40}$/.test(s)) return null;
  return s;
}

export function validateStoragePrefix(input: string): string | null {
  const s = input.trim().replace(/^\/+|\/+$/g, "");
  if (!s) return "";
  if (s.length > 120) return null;
  if (/[\x00-\x1f\x7f\\]/.test(s)) return null;
  const parts = s.split("/");
  for (const part of parts) {
    if (!part || part === "." || part === ".." || !/^[A-Za-z0-9._-]+$/.test(part)) return null;
  }
  return parts.join("/");
}

function isValidSecretString(val: string): boolean {
  return val.length > 0 && val.length <= 4096 && !/[\s\x00-\x1f\x7f]/.test(val);
}

/** Deterministic remote object key: never includes user-supplied filename. */
export function buildRemoteObjectKey(
  prefix: string,
  networkId: string | null,
  dateBucket: string,
  fileId: string,
  ext: string,
): string {
  const safeNet = (networkId || "default").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "default";
  const parts = [prefix.replace(/^\/+|\/+$/g, ""), safeNet, dateBucket, `${fileId}${ext}`].filter(Boolean);
  return parts.join("/");
}

function toPublicConfig(
  networkId: string,
  row: StoredMetaRow | null | undefined,
  canManage: boolean,
): NetworkStoragePublicConfig {
  const configured = !!row && Number(row.configured) === 1;
  const provider = normalizeProvider(row?.provider, "modelscope") ?? "modelscope";
  const repoType = normalizeRepoType(row?.repo_type, "dataset") ?? "dataset";
  const maxBytes = row?.max_file_bytes && Number(row.max_file_bytes) >= MIN_REMOTE_UPLOAD_BYTES
    ? Math.min(Number(row.max_file_bytes), MAX_REMOTE_UPLOAD_BYTES)
    : DEFAULT_REMOTE_UPLOAD_BYTES;
  return {
    ok: true,
    network_id: networkId,
    enabled: configured && Number(row?.enabled) === 1,
    configured,
    provider,
    endpoint: row?.endpoint || "",
    region: row?.region || "",
    bucket: row?.bucket || "",
    repo_id: row?.repo_id || "",
    repo_type: repoType,
    revision: row?.revision || DEFAULT_MODELSCOPE_REVISION,
    prefix: row?.prefix ?? DEFAULT_STORAGE_PREFIX,
    public_base_url: row?.public_base_url || "",
    max_file_bytes: maxBytes,
    key_hint: configured ? (row?.key_hint || "…") : "",
    can_manage: canManage,
    vault_ready: isStorageVaultReady(),
    updated_at: row?.updated_at != null ? Number(row.updated_at) : null,
  };
}

/** Read public non-secret projection for a network. Never selects ciphertext columns. */
export function readNetworkStorageConfig(
  networkId: string,
  canManage: boolean,
): NetworkStoragePublicConfig {
  const row = db.get<StoredMetaRow>(
    `SELECT enabled, provider, endpoint, region, bucket, repo_id, repo_type, revision, prefix,
            public_base_url, max_file_bytes, key_hint,
            CASE WHEN ciphertext_b64 IS NOT NULL AND ciphertext_b64 != '' THEN 1 ELSE 0 END AS configured,
            updated_at
       FROM network_storage_configs
      WHERE network_id = ?1`,
    networkId,
  );
  return toPublicConfig(networkId, row, canManage);
}

function readStoredSecretRow(networkId: string): StoredSecretRow | null {
  return db.get<StoredSecretRow>(
    `SELECT enabled, provider, endpoint, region, bucket, repo_id, repo_type, revision, prefix,
            public_base_url, max_file_bytes, key_hint, ciphertext_b64, iv_b64, tag_b64,
            CASE WHEN ciphertext_b64 IS NOT NULL AND ciphertext_b64 != '' THEN 1 ELSE 0 END AS configured,
            updated_at
       FROM network_storage_configs
      WHERE network_id = ?1`,
    networkId,
  ) ?? null;
}

function decryptStoredSecrets(row: StoredSecretRow): StoredStorageSecrets {
  const raw = decryptSecret({
    ciphertext: Buffer.from(row.ciphertext_b64, "base64"),
    iv: Buffer.from(row.iv_b64, "base64"),
    tag: Buffer.from(row.tag_b64, "base64"),
  });
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new VaultError("vault_decrypt_failed", "corrupted storage secret payload");
  }
  return parsed as StoredStorageSecrets;
}

/** Load active (configured & enabled) runtime config with decrypted credentials for server-side signing/presign. */
export function readActiveNetworkStorageConfig(
  networkId: string,
  opts: { requireEnabled?: boolean } = {},
): { ok: true; config: ActiveStorageRuntimeConfig | null } | { ok: false; status: number; error: string; message: string } {
  const requireEnabled = opts.requireEnabled !== false;
  const row = readStoredSecretRow(networkId);
  if (!row || Number(row.configured) !== 1) return { ok: true, config: null };
  if (requireEnabled && Number(row.enabled) !== 1) return { ok: true, config: null };
  const provider = normalizeProvider(row.provider, "modelscope");
  if (!provider) return { ok: false, status: 500, error: "invalid_provider", message: "存储配置 provider 无效" };
  let secrets: StoredStorageSecrets;
  try {
    secrets = decryptStoredSecrets(row);
  } catch (e) {
    const code = e instanceof VaultError ? e.code : "vault_decrypt_failed";
    return { ok: false, status: 503, error: code, message: "Hub 加密主密钥不可用，无法读取存储配置" };
  }
  return {
    ok: true,
    config: {
      network_id: networkId,
      enabled: Number(row.enabled) === 1,
      provider,
      endpoint: row.endpoint || "",
      region: row.region || "",
      bucket: row.bucket || "",
      repo_id: row.repo_id || "",
      repo_type: normalizeRepoType(row.repo_type, "dataset") ?? "dataset",
      revision: row.revision || DEFAULT_MODELSCOPE_REVISION,
      prefix: row.prefix ?? DEFAULT_STORAGE_PREFIX,
      public_base_url: row.public_base_url || "",
      max_file_bytes: Math.min(
        Math.max(Number(row.max_file_bytes) || DEFAULT_REMOTE_UPLOAD_BYTES, MIN_REMOTE_UPLOAD_BYTES),
        MAX_REMOTE_UPLOAD_BYTES,
      ),
      secrets,
    },
  };
}

/** Validate & normalize a write/test draft, merging omitted secrets from an existing same-provider row if allowed. */
function resolveDraftConfig(
  networkId: string,
  input: StorageConfigWriteInput,
  existing: StoredSecretRow | null,
):
  | {
      ok: true;
      enabled: boolean;
      provider: StorageProvider;
      endpoint: string;
      region: string;
      bucket: string;
      repo_id: string;
      repo_type: ModelScopeRepoType;
      revision: string;
      prefix: string;
      public_base_url: string;
      max_file_bytes: number;
      secrets: StoredStorageSecrets;
      secretRotated: boolean;
      keyHint: string;
      reuseCiphertext: boolean;
    }
  | { ok: false; error: StorageWriteErrorCode; message: string } {
  const existingHasSecret = !!existing && Number(existing.configured) === 1
    && !!existing.ciphertext_b64 && !!existing.iv_b64 && !!existing.tag_b64;
  const existingProvider = existingHasSecret
    ? (normalizeProvider(existing!.provider, "modelscope") ?? "modelscope")
    : "modelscope";

  const provider = normalizeProvider(input.provider, existingProvider);
  if (!provider) {
    return { ok: false, error: "invalid_provider", message: "仅支持 modelscope、oss 或 s3 存储中转服务" };
  }
  const sameProvider = existingHasSecret && existingProvider === provider;

  const epRaw = typeof input.endpoint === "string"
    ? input.endpoint
    : (sameProvider ? (existing?.endpoint || "") : "");
  const ep = validateStorageUrl(epRaw, "invalid_endpoint");
  if (!ep.ok) return ep;

  const pubRaw = typeof input.public_base_url === "string"
    ? input.public_base_url
    : (sameProvider ? (existing?.public_base_url || "") : "");
  const pub = validateStorageUrl(pubRaw, "invalid_public_base_url");
  if (!pub.ok) return pub;

  const prefixRaw = typeof input.prefix === "string"
    ? input.prefix
    : (existing ? existing.prefix : DEFAULT_STORAGE_PREFIX);
  const prefix = validateStoragePrefix(prefixRaw);
  if (prefix === null) {
    return { ok: false, error: "invalid_prefix", message: "路径前缀只能包含字母、数字、.、_、- 和 /，不能包含 .." };
  }

  let maxFileBytes = existing?.max_file_bytes
    ? Number(existing.max_file_bytes)
    : DEFAULT_REMOTE_UPLOAD_BYTES;
  if (input.max_file_bytes !== undefined && input.max_file_bytes !== null && input.max_file_bytes !== "") {
    const n = Number(input.max_file_bytes);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < MIN_REMOTE_UPLOAD_BYTES || n > MAX_REMOTE_UPLOAD_BYTES) {
      return {
        ok: false,
        error: "invalid_max_file_bytes",
        message: `单文件上限必须在 ${MIN_REMOTE_UPLOAD_BYTES / (1024 * 1024)} MB 到 ${MAX_REMOTE_UPLOAD_BYTES / (1024 * 1024)} MB 之间`,
      };
    }
    maxFileBytes = n;
  }

  const enabled = typeof input.enabled === "boolean"
    ? input.enabled
    : (existing ? Number(existing.enabled) === 1 : true);

  let region = "";
  let bucket = "";
  let repoId = "";
  let repoType: ModelScopeRepoType = "dataset";
  let revision = DEFAULT_MODELSCOPE_REVISION;

  if (provider === "modelscope") {
    const rawRepoId = typeof input.repo_id === "string"
      ? input.repo_id
      : (sameProvider ? (existing?.repo_id || "") : "");
    const validRepo = validateModelScopeRepoId(rawRepoId);
    if (!validRepo) {
      return { ok: false, error: "invalid_repo_id", message: "请填写有效的 ModelScope 仓库 ID（格式：owner/repo）" };
    }
    repoId = validRepo;

    const rt = normalizeRepoType(
      input.repo_type,
      sameProvider ? (normalizeRepoType(existing?.repo_type, "dataset") ?? "dataset") : "dataset",
    );
    if (!rt) {
      return { ok: false, error: "invalid_repo_type", message: "仓库类型必须为 dataset 或 model" };
    }
    repoType = rt;

    const revRaw = typeof input.revision === "string"
      ? input.revision
      : (sameProvider ? (existing?.revision || DEFAULT_MODELSCOPE_REVISION) : DEFAULT_MODELSCOPE_REVISION);
    const validRev = validateModelScopeRevision(revRaw);
    if (!validRev) {
      return { ok: false, error: "invalid_revision", message: "分支/版本名格式无效" };
    }
    revision = validRev;

    const rawToken =
      typeof input.api_token === "string" && input.api_token.trim()
        ? input.api_token.trim()
        : typeof input.token === "string" && input.token.trim()
          ? input.token.trim()
          : "";
    if (rawToken) {
      if (!isValidSecretString(rawToken)) {
        return { ok: false, error: "invalid_credential", message: "ModelScope Token 格式无效（不能包含空格或控制字符）" };
      }
      return {
        ok: true,
        enabled,
        provider,
        endpoint: ep.url,
        region,
        bucket,
        repo_id: repoId,
        repo_type: repoType,
        revision,
        prefix,
        public_base_url: pub.url,
        max_file_bytes: maxFileBytes,
        secrets: { token: rawToken },
        secretRotated: true,
        keyHint: maskStorageSecretTail(rawToken),
        reuseCiphertext: false,
      };
    }
    if (sameProvider) {
      return {
        ok: true,
        enabled,
        provider,
        endpoint: ep.url,
        region,
        bucket,
        repo_id: repoId,
        repo_type: repoType,
        revision,
        prefix,
        public_base_url: pub.url,
        max_file_bytes: maxFileBytes,
        secrets: {},
        secretRotated: false,
        keyHint: existing!.key_hint,
        reuseCiphertext: true,
      };
    }
    return { ok: false, error: "credential_required", message: "请填写 ModelScope API Token" };
  }

  // Aliyun OSS / AWS S3
  const rawBucket = typeof input.bucket === "string"
    ? input.bucket
    : (sameProvider ? (existing?.bucket || "") : "");
  const validBucket = validateBucketName(rawBucket);
  if (!validBucket) {
    return { ok: false, error: "invalid_bucket", message: "请填写有效的 Bucket 名称（小写字母、数字、连字符）" };
  }
  bucket = validBucket;

  const rawRegion = typeof input.region === "string"
    ? input.region
    : (sameProvider ? (existing?.region || "") : "");
  const validRegion = validateRegion(rawRegion);
  if (!validRegion) {
    return {
      ok: false,
      error: "invalid_region",
      message: provider === "oss" ? "请填写有效的阿里云地域（如 cn-hangzhou 或 oss-cn-hangzhou）" : "请填写有效的 AWS 区域（如 us-east-1）",
    };
  }
  region = validRegion;

  const rawAk = typeof input.access_key_id === "string" ? input.access_key_id.trim() : "";
  const rawSk =
    typeof input.access_key_secret === "string" && input.access_key_secret.trim()
      ? input.access_key_secret.trim()
      : typeof input.secret_access_key === "string" && input.secret_access_key.trim()
        ? input.secret_access_key.trim()
        : "";
  const rawSession = typeof input.session_token === "string" ? input.session_token.trim() : "";

  if (rawAk || rawSk || rawSession) {
    if (!rawAk || !rawSk) {
      return { ok: false, error: "credential_required", message: "更新密钥时需同时填写 AccessKey ID 和 AccessKey Secret" };
    }
    if (!isValidSecretString(rawAk) || !isValidSecretString(rawSk) || (rawSession && !isValidSecretString(rawSession))) {
      return { ok: false, error: "invalid_credential", message: "AccessKey 格式无效（不能包含空格或控制字符）" };
    }
    return {
      ok: true,
      enabled,
      provider,
      endpoint: ep.url,
      region,
      bucket,
      repo_id: "",
      repo_type: "dataset",
      revision: DEFAULT_MODELSCOPE_REVISION,
      prefix,
      public_base_url: pub.url,
      max_file_bytes: maxFileBytes,
      secrets: {
        access_key_id: rawAk,
        access_key_secret: rawSk,
        ...(rawSession ? { session_token: rawSession } : {}),
      },
      secretRotated: true,
      keyHint: maskStorageSecretTail(rawAk),
      reuseCiphertext: false,
    };
  }

  if (sameProvider) {
    return {
      ok: true,
      enabled,
      provider,
      endpoint: ep.url,
      region,
      bucket,
      repo_id: "",
      repo_type: "dataset",
      revision: DEFAULT_MODELSCOPE_REVISION,
      prefix,
      public_base_url: pub.url,
      max_file_bytes: maxFileBytes,
      secrets: {},
      secretRotated: false,
      keyHint: existing!.key_hint,
      reuseCiphertext: true,
    };
  }

  return { ok: false, error: "credential_required", message: "请填写 AccessKey ID 和 AccessKey Secret" };
}

/** Create or update a network's external storage relay config (owner/admin only). */
export function saveNetworkStorageConfig(
  networkId: string,
  actorUserId: string | null,
  actorUsername: string | null,
  input: StorageConfigWriteInput,
): StorageConfigWriteResult {
  const existing = readStoredSecretRow(networkId);
  const resolved = resolveDraftConfig(networkId, input, existing);
  if (!resolved.ok) return resolved;

  let ciphertextB64: string;
  let ivB64: string;
  let tagB64: string;

  if (resolved.reuseCiphertext && existing) {
    ciphertextB64 = existing.ciphertext_b64;
    ivB64 = existing.iv_b64;
    tagB64 = existing.tag_b64;
  } else {
    try {
      const enc = encryptSecret(JSON.stringify(resolved.secrets));
      ciphertextB64 = enc.ciphertext.toString("base64");
      ivB64 = enc.iv.toString("base64");
      tagB64 = enc.tag.toString("base64");
    } catch (e) {
      if (e instanceof VaultError) {
        const code: StorageWriteErrorCode =
          e.code === "vault_master_key_missing" ? "vault_master_key_missing"
            : e.code === "vault_master_key_invalid" ? "vault_master_key_invalid"
            : "vault_unavailable";
        const message =
          code === "vault_master_key_missing"
            ? "Hub 未配置加密主密钥（ANET_HUB_SECRET_VAULT_KEY），无法加密保存存储密钥"
            : code === "vault_master_key_invalid"
              ? "Hub 加密主密钥（ANET_HUB_SECRET_VAULT_KEY）格式无效，需为 64 位十六进制"
              : "Hub 加密服务暂不可用";
        return { ok: false, error: code, message };
      }
      return { ok: false, error: "vault_unavailable", message: "Hub 加密服务暂不可用" };
    }
  }

  const now = Date.now();
  db.run(
    `INSERT INTO network_storage_configs
       (network_id, enabled, provider, endpoint, region, bucket, repo_id, repo_type, revision,
        prefix, public_base_url, max_file_bytes, key_hint, ciphertext_b64, iv_b64, tag_b64, updated_at, updated_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
     ON CONFLICT(network_id) DO UPDATE SET
       enabled = ?2,
       provider = ?3,
       endpoint = ?4,
       region = ?5,
       bucket = ?6,
       repo_id = ?7,
       repo_type = ?8,
       revision = ?9,
       prefix = ?10,
       public_base_url = ?11,
       max_file_bytes = ?12,
       key_hint = ?13,
       ciphertext_b64 = ?14,
       iv_b64 = ?15,
       tag_b64 = ?16,
       updated_at = ?17,
       updated_by = ?18`,
    [
      networkId,
      resolved.enabled ? 1 : 0,
      resolved.provider,
      resolved.endpoint,
      resolved.region,
      resolved.bucket,
      resolved.repo_id,
      resolved.repo_type,
      resolved.revision,
      resolved.prefix,
      resolved.public_base_url,
      resolved.max_file_bytes,
      resolved.keyHint,
      ciphertextB64,
      ivB64,
      tagB64,
      now,
      actorUserId ?? actorUsername ?? "",
    ],
  );

  logAudit(
    actorUserId,
    actorUsername,
    "storage_config.upsert",
    "network_storage",
    networkId,
    JSON.stringify({
      enabled: resolved.enabled,
      provider: resolved.provider,
      repo_id: resolved.repo_id || undefined,
      bucket: resolved.bucket || undefined,
      region: resolved.region || undefined,
      max_file_bytes: resolved.max_file_bytes,
      key_rotated: resolved.secretRotated,
    }),
    undefined,
    networkId,
  );

  return readNetworkStorageConfig(networkId, true);
}

/** Delete a network's external storage relay config (owner/admin only). */
export function deleteNetworkStorageConfig(
  networkId: string,
  actorUserId: string | null,
  actorUsername: string | null,
): NetworkStoragePublicConfig {
  db.run("DELETE FROM network_storage_configs WHERE network_id = ?1", [networkId]);
  logAudit(actorUserId, actorUsername, "storage_config.delete", "network_storage", networkId, "cleared", undefined, networkId);
  return readNetworkStorageConfig(networkId, true);
}

// ── Pure-crypto SigV4 Presigned URLs (AWS S3 & Aliyun OSS) ────────────────

function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** RFC 3986 percent-encoding required by AWS SigV4 & Aliyun OSS V4. */
function encodeRfc3986(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeObjectKeyPath(objectKey: string): string {
  return objectKey
    .replace(/^\/+/, "")
    .split("/")
    .map((seg) => encodeRfc3986(seg))
    .join("/");
}

function formatAmzDate(now: Date): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

function resolveS3OrOssTarget(
  provider: "oss" | "s3",
  bucket: string,
  region: string,
  endpointOverride: string,
  objectKey: string,
): {
  urlBase: string;
  hostHeader: string;
  canonicalUri: string;
  signingRegion: string;
} {
  const encodedKey = encodeObjectKeyPath(objectKey);
  const rawEndpoint = endpointOverride.trim()
    || (provider === "oss"
      ? `https://oss-${region.replace(/^oss-/, "")}.aliyuncs.com`
      : `https://s3.${region}.amazonaws.com`);
  const parsed = new URL(rawEndpoint);
  const hostLower = parsed.hostname.toLowerCase();
  const usePathStyle = isLoopbackHost(hostLower) || isIpLiteral(hostLower) || parsed.pathname.length > 1;

  if (provider === "oss") {
    const ossRegion = region.replace(/^oss-/, "");
    if (usePathStyle) {
      const basePath = parsed.pathname.replace(/\/+$/, "");
      const pathPart = `${basePath}/${encodeRfc3986(bucket)}/${encodedKey}`;
      return {
        urlBase: `${parsed.origin}${pathPart}`,
        hostHeader: parsed.host,
        canonicalUri: `/${encodeRfc3986(bucket)}/${encodedKey}`,
        signingRegion: ossRegion,
      };
    }
    const vhost = hostLower.startsWith(`${bucket.toLowerCase()}.`) ? parsed.host : `${bucket}.${parsed.host}`;
    return {
      urlBase: `${parsed.protocol}//${vhost}/${encodedKey}`,
      hostHeader: vhost,
      // Aliyun OSS V4 always includes /<bucket>/<key> in CanonicalURI even for virtual-hosted style.
      canonicalUri: `/${encodeRfc3986(bucket)}/${encodedKey}`,
      signingRegion: ossRegion,
    };
  }

  // AWS S3 / S3-compatible
  if (usePathStyle) {
    const basePath = parsed.pathname.replace(/\/+$/, "");
    const pathPart = `${basePath}/${encodeRfc3986(bucket)}/${encodedKey}`;
    return {
      urlBase: `${parsed.origin}${pathPart}`,
      hostHeader: parsed.host,
      canonicalUri: pathPart,
      signingRegion: region,
    };
  }
  const vhost = hostLower.startsWith(`${bucket.toLowerCase()}.`) ? parsed.host : `${bucket}.${parsed.host}`;
  return {
    urlBase: `${parsed.protocol}//${vhost}/${encodedKey}`,
    hostHeader: vhost,
    canonicalUri: `/${encodedKey}`,
    signingRegion: region,
  };
}

/**
 * Generate a presigned URL for AWS S3 (AWS4-HMAC-SHA256) or Aliyun OSS (OSS4-HMAC-SHA256).
 * Pure node:crypto — zero external SDK dependencies.
 */
export function signObjectStoragePresignedUrl(params: {
  provider: "oss" | "s3";
  method: "PUT" | "GET" | "HEAD";
  bucket: string;
  region: string;
  endpoint?: string;
  objectKey: string;
  accessKeyId: string;
  accessKeySecret: string;
  sessionToken?: string;
  expiresSeconds?: number;
  now?: Date;
}): string {
  const expires = Math.max(60, Math.min(params.expiresSeconds ?? PRESIGN_TTL_SECONDS, 7 * 24 * 3600));
  const { amzDate, dateStamp } = formatAmzDate(params.now ?? new Date());
  const target = resolveS3OrOssTarget(
    params.provider,
    params.bucket,
    params.region,
    params.endpoint ?? "",
    params.objectKey,
  );

  const isOss = params.provider === "oss";
  const algorithm = isOss ? "OSS4-HMAC-SHA256" : "AWS4-HMAC-SHA256";
  const service = isOss ? "oss" : "s3";
  const terminator = isOss ? "aliyun_v4_request" : "aws4_request";
  const keyPrefix = isOss ? "aliyun_v4" : "AWS4";
  const scope = `${dateStamp}/${target.signingRegion}/${service}/${terminator}`;
  const credential = `${params.accessKeyId}/${scope}`;

  const queryParams: Array<[string, string]> = isOss
    ? [
        ["x-oss-signature-version", algorithm],
        ["x-oss-credential", credential],
        ["x-oss-date", amzDate],
        ["x-oss-expires", String(expires)],
        ...(params.sessionToken ? [["x-oss-security-token", params.sessionToken] as [string, string]] : []),
      ]
    : [
        ["X-Amz-Algorithm", algorithm],
        ["X-Amz-Credential", credential],
        ["X-Amz-Date", amzDate],
        ["X-Amz-Expires", String(expires)],
        ["X-Amz-SignedHeaders", "host"],
        ...(params.sessionToken ? [["X-Amz-Security-Token", params.sessionToken] as [string, string]] : []),
      ];

  queryParams.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalQuery = queryParams
    .map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`)
    .join("&");

  const canonicalHeaders = `host:${target.hostHeader}\n`;
  const signedHeaders = isOss ? "" : "host";
  const canonicalRequest = [
    params.method,
    target.canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    algorithm,
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmacSha256(`${keyPrefix}${params.accessKeySecret}`, dateStamp);
  const kRegion = hmacSha256(kDate, target.signingRegion);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, terminator);
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  const sigKey = isOss ? "x-oss-signature" : "X-Amz-Signature";
  return `${target.urlBase}?${canonicalQuery}&${sigKey}=${signature}`;
}

// ── ModelScope Pure-HTTP LFS Driver ───────────────────────────────────────

function modelScopeEndpoint(cfg: { endpoint?: string }): string {
  return (cfg.endpoint || DEFAULT_MODELSCOPE_ENDPOINT).replace(/\/+$/, "");
}

function modelScopeRepoSegment(repoType: ModelScopeRepoType): "datasets" | "models" {
  return repoType === "model" ? "models" : "datasets";
}

function modelScopeAuthHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Cookie: `m_session_id=${token}`,
    "User-Agent": "agent-network-hub/1.0",
  };
}

/** Only send ModelScope credentials to ModelScope's own hosts (never leak token to external OSS presigned URLs). */
function shouldSendModelScopeAuthToUrl(targetUrl: string, configuredEndpoint: string): boolean {
  try {
    const targetHost = new URL(targetUrl).hostname.toLowerCase();
    const configuredHost = new URL(configuredEndpoint).hostname.toLowerCase();
    if (targetHost === configuredHost) return true;
    return targetHost === "modelscope.cn"
      || targetHost.endsWith(".modelscope.cn")
      || targetHost === "modelscope.ai"
      || targetHost.endsWith(".modelscope.ai");
  } catch {
    return false;
  }
}

async function fetchJsonSafe(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<{ ok: boolean; status: number; body: any; rawText: string }> {
  const res = await fetchFn(url, init);
  const rawText = await res.text().catch(() => "");
  let body: any = null;
  try { body = rawText ? JSON.parse(rawText) : null; } catch { /* non-JSON */ }
  return { ok: res.ok, status: res.status, body, rawText };
}

// ── Unified Provider Operations ───────────────────────────────────────────

/** Test either a saved config or an unsaved draft config against the live provider. */
export async function testNetworkStorageConfig(
  networkId: string,
  draft: StorageConfigWriteInput | null,
  fetchFn: typeof fetch = fetch,
): Promise<StorageTestResult> {
  const started = Date.now();
  const existing = readStoredSecretRow(networkId);
  let cfg: ActiveStorageRuntimeConfig;

  if (draft && Object.keys(draft).length > 0) {
    const resolved = resolveDraftConfig(networkId, draft, existing);
    if (!resolved.ok) {
      return {
        ok: false,
        provider: normalizeProvider(draft.provider, "modelscope") ?? "modelscope",
        latency_ms: Date.now() - started,
        error: resolved.error,
        message: resolved.message,
      };
    }
    let secrets = resolved.secrets;
    if (resolved.reuseCiphertext && existing) {
      try {
        secrets = decryptStoredSecrets(existing);
      } catch (e) {
        const code = e instanceof VaultError ? e.code : "vault_decrypt_failed";
        return {
          ok: false,
          provider: resolved.provider,
          latency_ms: Date.now() - started,
          error: code,
          message: "Hub 加密主密钥不可用，无法读取已保存密钥",
        };
      }
    }
    cfg = {
      network_id: networkId,
      enabled: resolved.enabled,
      provider: resolved.provider,
      endpoint: resolved.endpoint,
      region: resolved.region,
      bucket: resolved.bucket,
      repo_id: resolved.repo_id,
      repo_type: resolved.repo_type,
      revision: resolved.revision,
      prefix: resolved.prefix,
      public_base_url: resolved.public_base_url,
      max_file_bytes: resolved.max_file_bytes,
      secrets,
    };
  } else {
    const loaded = readActiveNetworkStorageConfig(networkId, { requireEnabled: false });
    if (!loaded.ok) {
      return {
        ok: false,
        provider: "modelscope",
        latency_ms: Date.now() - started,
        error: loaded.error,
        message: loaded.message,
      };
    }
    if (!loaded.config) {
      return {
        ok: false,
        provider: "modelscope",
        latency_ms: Date.now() - started,
        error: "not_configured",
        message: "当前网络尚未配置存储中转",
      };
    }
    cfg = loaded.config;
  }

  try {
    if (cfg.provider === "modelscope") {
      const token = cfg.secrets.token || "";
      if (!token) {
        return { ok: false, provider: "modelscope", latency_ms: Date.now() - started, error: "credential_required", message: "缺少 ModelScope API Token" };
      }
      const ep = modelScopeEndpoint(cfg);
      const seg = modelScopeRepoSegment(cfg.repo_type);
      const infoUrl = `${ep}/api/v1/${seg}/${cfg.repo_id}`;
      const r = await fetchJsonSafe(fetchFn, infoUrl, {
        method: "GET",
        headers: modelScopeAuthHeaders(token),
        signal: AbortSignal.timeout(15_000),
      });
      const latency = Date.now() - started;
      const apiCode = typeof r.body?.Code === "number" ? r.body.Code : null;
      if (!r.ok || (apiCode !== null && apiCode !== 200)) {
        const msg = r.body?.Message || r.body?.message || `HTTP ${r.status}`;
        return {
          ok: false,
          provider: "modelscope",
          latency_ms: latency,
          error: r.status === 401 || r.status === 403 ? "auth_failed" : "repo_check_failed",
          message: `ModelScope 仓库校验失败：${msg}`,
        };
      }
      const visNum = r.body?.Data?.Visibility;
      const visibility: "private" | "public" | "unknown" =
        visNum === 1 ? "private" : visNum === 5 ? "public" : "unknown";
      const warning = visibility === "public"
        ? "注意：该 ModelScope 仓库当前为公开（Public），建议切换为私有（Private）仓库以保护聊天文件隐私"
        : undefined;
      return {
        ok: true,
        provider: "modelscope",
        latency_ms: latency,
        visibility,
        warning,
        message: visibility === "private"
          ? `连接成功：ModelScope 私有仓库 ${cfg.repo_id} 可用`
          : `连接成功：ModelScope 仓库 ${cfg.repo_id} 可用`,
      };
    }

    // Aliyun OSS / AWS S3: verify bucket access via signed HEAD on a probe key (200 or 404 = valid credentials & bucket).
    const ak = cfg.secrets.access_key_id || "";
    const sk = cfg.secrets.access_key_secret || "";
    if (!ak || !sk) {
      return { ok: false, provider: cfg.provider, latency_ms: Date.now() - started, error: "credential_required", message: "缺少 AccessKey" };
    }
    const probeKey = `${cfg.prefix ? `${cfg.prefix}/` : ""}.anet-healthcheck`;
    const signedUrl = signObjectStoragePresignedUrl({
      provider: cfg.provider,
      method: "HEAD",
      bucket: cfg.bucket,
      region: cfg.region,
      endpoint: cfg.endpoint,
      objectKey: probeKey,
      accessKeyId: ak,
      accessKeySecret: sk,
      sessionToken: cfg.secrets.session_token,
      expiresSeconds: 120,
    });
    const res = await fetchFn(signedUrl, { method: "HEAD", signal: AbortSignal.timeout(15_000) });
    const latency = Date.now() - started;
    if (res.status === 200 || res.status === 404) {
      return {
        ok: true,
        provider: cfg.provider,
        latency_ms: latency,
        message: `连接成功：${cfg.provider === "oss" ? "阿里云 OSS" : "AWS S3"} Bucket ${cfg.bucket} 可用`,
      };
    }
    return {
      ok: false,
      provider: cfg.provider,
      latency_ms: latency,
      error: res.status === 403 ? "auth_failed" : "bucket_check_failed",
      message: `${cfg.provider === "oss" ? "阿里云 OSS" : "AWS S3"} 校验失败（HTTP ${res.status}）`,
    };
  } catch (e: any) {
    return {
      ok: false,
      provider: cfg.provider,
      latency_ms: Date.now() - started,
      error: "network_error",
      message: `连接失败：${e?.message || String(e)}`,
    };
  }
}

/** Step 1 of direct upload: obtain provider-specific direct PUT instruction (0 file bytes touch Hub). */
export async function presignStorageUpload(
  cfg: ActiveStorageRuntimeConfig,
  params: {
    networkId: string | null;
    dateBucket: string;
    fileId: string;
    ext: string;
    size: number;
    sha256: string;
    mime: string;
  },
  fetchFn: typeof fetch = fetch,
): Promise<PresignStorageResult> {
  const objectKey = buildRemoteObjectKey(cfg.prefix, params.networkId, params.dateBucket, params.fileId, params.ext);

  if (cfg.provider === "modelscope") {
    const token = cfg.secrets.token || "";
    if (!token) {
      return { ok: false, status: 503, error: "storage_credential_missing", message: "ModelScope Token 未配置" };
    }
    const ep = modelScopeEndpoint(cfg);
    const seg = modelScopeRepoSegment(cfg.repo_type);
    const batchUrl = `${ep}/api/v1/repos/${seg}/${cfg.repo_id}/info/lfs/objects/batch`;
    let r: { ok: boolean; status: number; body: any; rawText: string };
    try {
      r = await fetchJsonSafe(fetchFn, batchUrl, {
        method: "POST",
        headers: {
          ...modelScopeAuthHeaders(token),
          "Content-Type": "application/json",
          Accept: "application/vnd.git-lfs+json, application/json",
        },
        body: JSON.stringify({
          operation: "upload",
          objects: [{ oid: params.sha256, size: params.size }],
        }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e: any) {
      return { ok: false, status: 502, error: "storage_upstream_error", message: `ModelScope LFS 预签名请求失败：${e?.message || e}` };
    }

    if (!r.ok || r.body?.Success === false || r.body?.success === false || (typeof r.body?.Code === "number" && r.body.Code !== 200)) {
      const msg = r.body?.Message || r.body?.message || `HTTP ${r.status}`;
      return { ok: false, status: 502, error: "storage_presign_failed", message: `ModelScope LFS 预签名失败：${msg}` };
    }
    const data = r.body?.Data ?? r.body;
    const objects = Array.isArray(data?.objects) ? data.objects : null;
    if (!objects) {
      return { ok: false, status: 502, error: "storage_presign_bad_response", message: "ModelScope LFS 返回格式异常（缺少 objects）" };
    }

    const storageMeta: RemoteStorageIndexMeta = {
      provider: "modelscope",
      object_key: objectKey,
      sha256: params.sha256,
      repo_id: cfg.repo_id,
      repo_type: cfg.repo_type,
      revision: cfg.revision,
      endpoint: ep,
      ...(cfg.public_base_url ? { public_base_url: cfg.public_base_url } : {}),
    };

    // Live ModelScope returns `Data: { objects: [], "reused-objects": [] }` when the blob already exists in LFS!
    if (objects.length === 0) {
      return {
        ok: true,
        provider: "modelscope",
        object_key: objectKey,
        skip_upload: true,
        upload: null,
        storage_meta: storageMeta,
      };
    }

    const obj = objects[0];
    if (obj?.error) {
      return {
        ok: false,
        status: 502,
        error: "storage_presign_rejected",
        message: `ModelScope LFS 拒绝上传：${obj.error?.message || obj.error?.code || "unknown"}`,
      };
    }

    const uploadAction = obj?.actions?.upload;
    if (!uploadAction || typeof uploadAction.href !== "string" || !uploadAction.href) {
      // Standard Git-LFS dedup: object returned without upload action.
      return {
        ok: true,
        provider: "modelscope",
        object_key: objectKey,
        skip_upload: true,
        upload: null,
        storage_meta: storageMeta,
      };
    }

    const headers: Record<string, string> = {};
    if (uploadAction.header && typeof uploadAction.header === "object") {
      for (const [k, v] of Object.entries(uploadAction.header)) {
        if (typeof v === "string") headers[k] = v;
      }
    }
    if (shouldSendModelScopeAuthToUrl(uploadAction.href, ep)) {
      headers.Authorization = `Bearer ${token}`;
      headers.Cookie = `m_session_id=${token}`;
    }

    return {
      ok: true,
      provider: "modelscope",
      object_key: objectKey,
      skip_upload: false,
      upload: {
        method: "PUT",
        url: uploadAction.href,
        headers,
      },
      storage_meta: storageMeta,
    };
  }

  // Aliyun OSS / AWS S3: pure-crypto presigned PUT URL (zero round-trip to cloud during presign!)
  const ak = cfg.secrets.access_key_id || "";
  const sk = cfg.secrets.access_key_secret || "";
  if (!ak || !sk) {
    return { ok: false, status: 503, error: "storage_credential_missing", message: "对象存储 AccessKey 未配置" };
  }
  const signedPutUrl = signObjectStoragePresignedUrl({
    provider: cfg.provider,
    method: "PUT",
    bucket: cfg.bucket,
    region: cfg.region,
    endpoint: cfg.endpoint,
    objectKey,
    accessKeyId: ak,
    accessKeySecret: sk,
    sessionToken: cfg.secrets.session_token,
    expiresSeconds: PRESIGN_TTL_SECONDS,
  });

  const storageMeta: RemoteStorageIndexMeta = {
    provider: cfg.provider,
    object_key: objectKey,
    sha256: params.sha256,
    bucket: cfg.bucket,
    region: cfg.region,
    ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
    ...(cfg.public_base_url ? { public_base_url: cfg.public_base_url } : {}),
  };

  return {
    ok: true,
    provider: cfg.provider,
    object_key: objectKey,
    skip_upload: false,
    upload: {
      method: "PUT",
      url: signedPutUrl,
      headers: {},
    },
    storage_meta: storageMeta,
  };
}

// Per-repo ModelScope Git commit coalescer + 429 retry queue.
// Live ModelScope benchmarks (2026-11-27) showed concurrent `POST .../commit/master` calls
// collide with HTTP 429 Code 10030000001 ("commit lock busy, please try again") and each
// commit takes ~2.8s. Serializing & micro-batching actions per repo eliminates 429s and lets
// multi-image sends (e.g. 9 photos) land in a single Git commit.
interface QueuedModelScopeCommitItem {
  fileId: string;
  size: number;
  objectKey: string;
  sha256: string;
  token: string;
  fetchFn: typeof fetch;
  resolve: (res: CompleteStorageResult) => void;
}
interface ModelScopeCommitQueue {
  pending: QueuedModelScopeCommitItem[];
  flushing: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}
const modelScopeCommitQueues = new Map<string, ModelScopeCommitQueue>();
const MODELSCOPE_COMMIT_COALESCE_MS = 80;
const MODELSCOPE_COMMIT_MAX_BATCH = 20;
const MODELSCOPE_COMMIT_RETRY_DELAYS_MS = [600, 1200, 2400, 3500];

function isCommitLockBusy(status: number, body: any): boolean {
  if (status === 429) return true;
  if (body?.Code === 10030000001) return true;
  const msg = String(body?.Message || body?.message || "");
  return /commit lock busy|try again/i.test(msg);
}

async function flushModelScopeCommitQueue(queueKey: string, commitUrl: string): Promise<void> {
  const q = modelScopeCommitQueues.get(queueKey);
  if (!q || q.flushing) return;
  q.flushing = true;
  try {
    while (q.pending.length > 0) {
      const batch = q.pending.splice(0, MODELSCOPE_COMMIT_MAX_BATCH);
      const token = batch[batch.length - 1].token;
      const fetchFn = batch[0].fetchFn;
      const payload = JSON.stringify({
        commit_message: batch.length === 1
          ? `anet relay ${batch[0].fileId}`
          : `anet relay batch (${batch.length} files)`,
        actions: batch.map((item) => ({
          action: "create",
          path: item.objectKey,
          type: "lfs",
          size: item.size,
          sha256: item.sha256,
          content: "",
          encoding: "",
        })),
      });

      let outcome: CompleteStorageResult = {
        ok: false,
        status: 502,
        error: "storage_commit_failed",
        message: "ModelScope 提交失败",
      };

      for (let attempt = 0; attempt <= MODELSCOPE_COMMIT_RETRY_DELAYS_MS.length; attempt++) {
        let r: { ok: boolean; status: number; body: any; rawText: string };
        try {
          r = await fetchJsonSafe(fetchFn, commitUrl, {
            method: "POST",
            headers: {
              ...modelScopeAuthHeaders(token),
              "Content-Type": "application/json",
            },
            body: payload,
            signal: AbortSignal.timeout(25_000),
          });
        } catch (e: any) {
          outcome = { ok: false, status: 502, error: "storage_commit_error", message: `ModelScope 提交失败：${e?.message || e}` };
          break;
        }

        const failedFlag = r.body?.Success === false || r.body?.success === false
          || (typeof r.body?.Code === "number" && r.body.Code !== 200);
        if (r.ok && !failedFlag) {
          outcome = { ok: true };
          break;
        }
        if (isCommitLockBusy(r.status, r.body) && attempt < MODELSCOPE_COMMIT_RETRY_DELAYS_MS.length) {
          await new Promise((res) => setTimeout(res, MODELSCOPE_COMMIT_RETRY_DELAYS_MS[attempt]));
          continue;
        }
        const msg = r.body?.Message || r.body?.message || `HTTP ${r.status}`;
        outcome = { ok: false, status: r.status === 429 ? 429 : 502, error: "storage_commit_failed", message: `ModelScope 提交文件记录失败：${msg}` };
        break;
      }

      for (const item of batch) item.resolve(outcome);
    }
  } finally {
    q.flushing = false;
    if (q.pending.length > 0) {
      void flushModelScopeCommitQueue(queueKey, commitUrl);
    } else if (!q.timer) {
      modelScopeCommitQueues.delete(queueKey);
    }
  }
}

function enqueueModelScopeCommit(
  commitUrl: string,
  item: Omit<QueuedModelScopeCommitItem, "resolve">,
): Promise<CompleteStorageResult> {
  return new Promise((resolve) => {
    let q = modelScopeCommitQueues.get(commitUrl);
    if (!q) {
      q = { pending: [], flushing: false, timer: null };
      modelScopeCommitQueues.set(commitUrl, q);
    }
    q.pending.push({ ...item, resolve });
    if (q.flushing || q.timer) return;
    q.timer = setTimeout(() => {
      if (q) q.timer = null;
      void flushModelScopeCommitQueue(commitUrl, commitUrl);
    }, MODELSCOPE_COMMIT_COALESCE_MS);
  });
}

/** Step 3 of direct upload: commit ModelScope LFS pointer or verify S3/OSS object exists. */
export async function completeStorageUpload(
  cfg: ActiveStorageRuntimeConfig,
  params: {
    fileId: string;
    size: number;
    storage: RemoteStorageIndexMeta;
  },
  fetchFn: typeof fetch = fetch,
): Promise<CompleteStorageResult> {
  if (params.storage.provider === "modelscope") {
    const token = cfg.secrets.token || "";
    if (!token) {
      return { ok: false, status: 503, error: "storage_credential_missing", message: "ModelScope Token 未配置" };
    }
    const ep = (params.storage.endpoint || modelScopeEndpoint(cfg)).replace(/\/+$/, "");
    const repoType: ModelScopeRepoType = params.storage.repo_type === "model" ? "model" : "dataset";
    const repoId = params.storage.repo_id || cfg.repo_id;
    const revision = params.storage.revision || cfg.revision || DEFAULT_MODELSCOPE_REVISION;
    const seg = modelScopeRepoSegment(repoType);
    const commitUrl = `${ep}/api/v1/repos/${seg}/${repoId}/commit/${encodeURIComponent(revision)}`;

    return enqueueModelScopeCommit(commitUrl, {
      fileId: params.fileId,
      size: params.size,
      objectKey: params.storage.object_key,
      sha256: params.storage.sha256,
      token,
      fetchFn,
    });
  }

  // Aliyun OSS / AWS S3: verify object exists via presigned HEAD (ensures client actually uploaded bytes).
  const ak = cfg.secrets.access_key_id || "";
  const sk = cfg.secrets.access_key_secret || "";
  if (!ak || !sk) {
    return { ok: false, status: 503, error: "storage_credential_missing", message: "对象存储 AccessKey 未配置" };
  }
  const headUrl = signObjectStoragePresignedUrl({
    provider: params.storage.provider,
    method: "HEAD",
    bucket: params.storage.bucket || cfg.bucket,
    region: params.storage.region || cfg.region,
    endpoint: params.storage.endpoint || cfg.endpoint,
    objectKey: params.storage.object_key,
    accessKeyId: ak,
    accessKeySecret: sk,
    sessionToken: cfg.secrets.session_token,
    expiresSeconds: 120,
  });

  try {
    const res = await fetchFn(headUrl, { method: "HEAD", signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      return {
        ok: false,
        status: res.status === 404 ? 400 : 502,
        error: res.status === 404 ? "storage_object_missing" : "storage_verify_failed",
        message: res.status === 404 ? "文件尚未上传到对象存储" : `对象存储校验失败（HTTP ${res.status}）`,
      };
    }
    const lenRaw = res.headers.get("Content-Length");
    if (lenRaw !== null) {
      const actualLen = Number(lenRaw);
      if (Number.isFinite(actualLen) && actualLen !== params.size) {
        return {
          ok: false,
          status: 400,
          error: "storage_size_mismatch",
          message: `上传字节数不匹配（预期 ${params.size}，实际 ${actualLen}）`,
        };
      }
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, status: 502, error: "storage_verify_error", message: `对象存储校验失败：${e?.message || e}` };
  }
}

/** Resolve direct download URL (+ provider headers if private ModelScope) for an authorized download request. */
export function resolveStorageDownload(
  networkId: string | undefined,
  storage: RemoteStorageIndexMeta,
): ResolveDownloadResult {
  // Public base URL override (e.g. CDN domain) needs no credentials.
  if (storage.public_base_url) {
    const base = storage.public_base_url.replace(/\/+$/, "");
    return {
      ok: true,
      provider: storage.provider,
      url: `${base}/${encodeObjectKeyPath(storage.object_key)}`,
      headers: {},
      expires_in: PRESIGN_TTL_SECONDS,
    };
  }

  if (!networkId) {
    return { ok: false, status: 503, error: "storage_network_missing", message: "远程文件缺少网络归属" };
  }
  // Allow downloading historical files even if the admin later toggled `enabled=false` (still configured!).
  const loaded = readActiveNetworkStorageConfig(networkId, { requireEnabled: false });
  if (!loaded.ok) return loaded;
  if (!loaded.config) {
    return { ok: false, status: 503, error: "storage_not_configured", message: "当前网络存储配置已清除，无法读取远程文件" };
  }
  const cfg = loaded.config;

  if (storage.provider === "modelscope") {
    const token = cfg.secrets.token || "";
    if (!token) {
      return { ok: false, status: 503, error: "storage_credential_missing", message: "ModelScope Token 未配置" };
    }
    const ep = (storage.endpoint || modelScopeEndpoint(cfg)).replace(/\/+$/, "");
    const repoType: ModelScopeRepoType = storage.repo_type === "model" ? "model" : "dataset";
    const repoId = storage.repo_id || cfg.repo_id;
    const revision = storage.revision || cfg.revision || DEFAULT_MODELSCOPE_REVISION;
    const seg = modelScopeRepoSegment(repoType);
    const url = `${ep}/api/v1/${seg}/${repoId}/repo?Revision=${encodeURIComponent(revision)}&FilePath=${encodeURIComponent(storage.object_key)}`;
    return {
      ok: true,
      provider: "modelscope",
      url,
      headers: {
        Authorization: `Bearer ${token}`,
        Cookie: `m_session_id=${token}`,
      },
      expires_in: PRESIGN_TTL_SECONDS,
    };
  }

  const ak = cfg.secrets.access_key_id || "";
  const sk = cfg.secrets.access_key_secret || "";
  if (!ak || !sk) {
    return { ok: false, status: 503, error: "storage_credential_missing", message: "对象存储 AccessKey 未配置" };
  }
  const signedGetUrl = signObjectStoragePresignedUrl({
    provider: storage.provider,
    method: "GET",
    bucket: storage.bucket || cfg.bucket,
    region: storage.region || cfg.region,
    endpoint: storage.endpoint || cfg.endpoint,
    objectKey: storage.object_key,
    accessKeyId: ak,
    accessKeySecret: sk,
    sessionToken: cfg.secrets.session_token,
    expiresSeconds: PRESIGN_TTL_SECONDS,
  });
  return {
    ok: true,
    provider: storage.provider,
    url: signedGetUrl,
    headers: {},
    expires_in: PRESIGN_TTL_SECONDS,
  };
}
