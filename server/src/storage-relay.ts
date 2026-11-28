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
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
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
  "public_storage_forbidden",
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
  public_storage_forbidden: 400,
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

export type NetworkStorageSource = "network" | "hub_managed" | "none";

export interface NetworkStoragePublicConfig {
  ok: true;
  network_id: string;
  enabled: boolean;
  configured: boolean;
  /** Where this effective config comes from: per-network override, Hub-managed env default, or none. */
  source: NetworkStorageSource;
  /** True when the Hub server has a valid COMMHUB_STORAGE_* default configured. */
  hub_managed_available: boolean;
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

export type StorageRoutePreference = "auto" | "accelerate" | "regional";
export type StorageCallerCloud = "aws" | "other";
export type StorageEffectiveRoute = "accelerate" | "regional";

export interface StorageRouteOptions {
  callerCloud?: StorageCallerCloud;
  routePreference?: StorageRoutePreference;
}

export function parseStorageRoutePreference(raw: unknown): StorageRoutePreference {
  if (typeof raw !== "string") return "auto";
  const v = raw.trim().toLowerCase();
  if (v === "regional" || v === "direct") return "regional";
  if (v === "accelerate" || v === "accel") return "accelerate";
  return "auto";
}

export function parseStorageCallerCloud(raw: unknown): StorageCallerCloud | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "aws" || v === "ec2") return "aws";
  if (v) return "other";
  return undefined;
}

/** Detect default AWS EC2 hostnames (e.g. ip-172-31-42-211, ip-10-0-1-5.us-west-2.compute.internal, ec2-1-2-3-4...). */
export function isAwsEc2Hostname(hostname: string | null | undefined): boolean {
  if (!hostname || typeof hostname !== "string") return false;
  const h = hostname.trim().toLowerCase();
  return /^ip-(?:10-\d{1,3}|172-(?:1[6-9]|2\d|3[01])|192-168)-\d{1,3}-\d{1,3}(?:\.[\w.-]+\.compute\.internal)?$/.test(h)
    || /^ec2-\d{1,3}-\d{1,3}-\d{1,3}-\d{1,3}\.[\w.-]+\.amazonaws\.com$/.test(h);
}

/**
 * When Transfer Acceleration is configured for AWS S3, AWS EC2 callers ride the AWS
 * private global backbone directly to regional S3 (~3ms, $0 acceleration surcharge)
 * instead of detouring through CloudFront edge PoPs ($0.04-$0.08/GB).
 * Non-AWS callers (e.g. domestic China App clients) keep Transfer Acceleration primary with regional fallback.
 */
export function shouldPreferRegionalOverAccelerate(
  provider: "oss" | "s3",
  endpoint: string,
  routeOpts: StorageRouteOptions = {},
): boolean {
  if (!isObjectStorageAccelerateEndpoint(provider, endpoint)) return false;
  const pref = routeOpts.routePreference ?? "auto";
  if (pref === "regional") return true;
  if (pref === "accelerate") return false;
  return provider === "s3" && routeOpts.callerCloud === "aws";
}

export type PresignStorageResult =
  | {
      ok: true;
      provider: StorageProvider;
      object_key: string;
      skip_upload: boolean;
      upload: DirectUploadInstruction | null;
      /** Optional fallback PUT target when Transfer Acceleration is enabled (regional <-> accelerate). */
      fallback_upload?: DirectUploadInstruction | null;
      /** Selected object storage route when Transfer Acceleration is enabled. */
      route?: StorageEffectiveRoute;
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
      /** Optional fallback GET target when Transfer Acceleration is enabled (regional <-> accelerate). */
      fallback_url?: string;
      /** Selected object storage route when Transfer Acceleration is enabled. */
      route?: StorageEffectiveRoute;
      headers: Record<string, string>;
      expires_in: number;
    }
  | { ok: false; status: number; error: string; message: string };

export const MAX_STORAGE_REDIRECTS = 5;

export type StorageSsrfErrorCode =
  | "invalid_endpoint"
  | "invalid_public_base_url"
  | "storage_ssrf_blocked"
  | "storage_ssrf_dns_failed"
  | "storage_ssrf_too_many_redirects";

export class StorageSsrfError extends Error {
  constructor(
    public readonly code: StorageSsrfErrorCode,
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "StorageSsrfError";
  }
}

export type StorageLookupFn = (
  hostname: string,
) => Promise<ReadonlyArray<{ address: string; family: number }>>;

export interface SafeStorageUrlOptions {
  /** Explicit test/dev opt-in to allow loopback (127.0.0.0/8, ::1, localhost). Never allows RFC1918/link-local/CGNAT/ULA. */
  allowLoopback?: boolean;
  /** Injectable DNS resolver for deterministic unit tests; defaults to node:dns/promises lookup({ all: true, verbatim: true }). */
  lookupFn?: StorageLookupFn;
  /** Override error code when callers want write-validation codes (invalid_endpoint / invalid_public_base_url). */
  errorCode?: StorageSsrfErrorCode;
}

export interface SafeStorageFetchOptions extends SafeStorageUrlOptions {
  fetchFn?: typeof fetch;
  maxRedirects?: number;
}

/** Dev/test-only opt-in for loopback storage mocks. Production MUST leave ANET_STORAGE_ALLOW_LOOPBACK unset. */
export function isStorageLoopbackAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ANET_STORAGE_ALLOW_LOOPBACK === "1";
}

function stripHostBrackets(host: string): string {
  const trimmed = host.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function normalizeHostForCheck(host: string): string {
  return stripHostBrackets(host).split("%")[0].replace(/\.+$/, "").toLowerCase();
}

function parseIpv4Octets(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith("0")) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    out.push(n);
  }
  return [out[0], out[1], out[2], out[3]];
}

function parseIpv6Groups(raw: string): number[] | null {
  let s = raw;
  const lastColon = s.lastIndexOf(":");
  if (lastColon !== -1 && s.slice(lastColon + 1).includes(".")) {
    const v4 = parseIpv4Octets(s.slice(lastColon + 1));
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;

  const parseSide = (part: string): number[] | null => {
    if (!part) return [];
    const segs = part.split(":");
    const groups: number[] = [];
    for (const seg of segs) {
      if (!/^[0-9a-f]{1,4}$/.test(seg)) return null;
      groups.push(parseInt(seg, 16));
    }
    return groups;
  };

  if (halves.length === 1) {
    const groups = parseSide(halves[0]);
    return groups && groups.length === 8 ? groups : null;
  }

  const left = parseSide(halves[0]);
  const right = parseSide(halves[1]);
  if (!left || !right) return null;
  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

function isLoopbackIpv4Octets(a: number): boolean {
  return a === 127;
}

function isForbiddenIpv4Octets(
  a: number,
  b: number,
  _c: number,
  _d: number,
  allowLoopback: boolean,
): boolean {
  if (a === 0) return true; // 0.0.0.0/8 unspecified / "this network"
  if (a === 10) return true; // 10.0.0.0/8 RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT (RFC6598)
  if (a === 127) return !allowLoopback; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC1918
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 RFC1918
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved/broadcast
  return false;
}

/**
 * Check whether an IPv4/IPv6 address belongs to a forbidden internal/reserved range (SSRF guard).
 * Fails closed on malformed/unparseable IP strings.
 *
 * Forbidden by default:
 * - IPv4: 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8 (unless allowLoopback),
 *         169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/4, 240.0.0.0/4
 * - IPv6: ::, ::1 (unless allowLoopback), fc00::/7, fe80::/10, fec0::/10, ff00::/8,
 *         plus IPv4-mapped (::ffff:0:0/96), IPv4-compatible (::/96), NAT64 (64:ff9b::/96),
 *         and 6to4 (2002::/16) wrapping a forbidden IPv4 address.
 */
export function isForbiddenStorageIp(
  ip: string,
  opts: { allowLoopback?: boolean } = {},
): boolean {
  const allowLoopback = opts.allowLoopback === true;
  const clean = normalizeHostForCheck(ip);
  if (!clean) return true;

  const family = isIP(clean);
  if (family === 4) {
    const octets = parseIpv4Octets(clean);
    if (!octets) return true;
    return isForbiddenIpv4Octets(octets[0], octets[1], octets[2], octets[3], allowLoopback);
  }
  if (family === 6) {
    const g = parseIpv6Groups(clean);
    if (!g) return true;
    const isAllZeroPrefix6 = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0;
    // :: (unspecified)
    if (isAllZeroPrefix6 && g[6] === 0 && g[7] === 0) return true;
    // ::1 (loopback)
    if (isAllZeroPrefix6 && g[6] === 0 && g[7] === 1) return !allowLoopback;
    // ::ffff:0:0/96 (IPv4-mapped IPv6, both dotted-quad and hex form e.g. ::ffff:a9fe:a9fe)
    if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
      return isForbiddenIpv4Octets(g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff, allowLoopback);
    }
    // ::/96 (deprecated IPv4-compatible IPv6)
    if (isAllZeroPrefix6) {
      return isForbiddenIpv4Octets(g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff, allowLoopback);
    }
    // 64:ff9b::/96 (NAT64 well-known prefix)
    if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
      return isForbiddenIpv4Octets(g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff, allowLoopback);
    }
    // 2002::/16 (6to4 embedding IPv4 in bits 16..47)
    if (g[0] === 0x2002) {
      return isForbiddenIpv4Octets(g[1] >> 8, g[1] & 0xff, g[2] >> 8, g[2] & 0xff, allowLoopback);
    }
    // fc00::/7 (Unique Local Addresses: fc00:: – fdff::)
    if ((g[0] & 0xfe00) === 0xfc00) return true;
    // fe80::/10 (Link-Local: fe80:: – febf::)
    if ((g[0] & 0xffc0) === 0xfe80) return true;
    // fec0::/10 (deprecated Site-Local)
    if ((g[0] & 0xffc0) === 0xfec0) return true;
    // ff00::/8 (Multicast)
    if ((g[0] & 0xff00) === 0xff00) return true;
    return false;
  }

  // Non-IP string passed to IP checker -> fail closed.
  return true;
}

function isLoopbackHost(host: string): boolean {
  const clean = normalizeHostForCheck(host);
  if (!clean) return false;
  if (clean === "localhost" || clean.endsWith(".localhost")) return true;
  const family = isIP(clean);
  if (family === 4) {
    const octets = parseIpv4Octets(clean);
    return !!octets && isLoopbackIpv4Octets(octets[0]);
  }
  if (family === 6) {
    const g = parseIpv6Groups(clean);
    if (!g) return false;
    const isAllZeroPrefix6 = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0;
    if (isAllZeroPrefix6 && g[6] === 0 && g[7] === 1) return true;
    if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
      return isLoopbackIpv4Octets(g[6] >> 8);
    }
  }
  return false;
}

function isIpLiteral(host: string): boolean {
  return isIP(normalizeHostForCheck(host)) !== 0;
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

/**
 * Validate optional HTTPS storage URL statically (no DNS I/O).
 * Rejects embedded credentials, non-HTTPS schemes, localhost, and literal private/link-local/CGNAT/reserved IPs.
 * Loopback (http:// or https:// to localhost / 127.0.0.0/8 / ::1) is ONLY allowed when explicitly opted in for tests.
 */
export function validateStorageUrl(
  input: string,
  errorCode: "invalid_endpoint" | "invalid_public_base_url",
  opts: { allowLoopback?: boolean } = {},
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
  const host = normalizeHostForCheck(u.hostname);
  if (!host) {
    return { ok: false, error: errorCode, message: "地址缺少有效主机名" };
  }
  const allowLoopback = opts.allowLoopback ?? isStorageLoopbackAllowed();
  const hostIsLoopback = isLoopbackHost(host);

  if (u.protocol !== "https:") {
    if (!(u.protocol === "http:" && allowLoopback && hostIsLoopback)) {
      return { ok: false, error: errorCode, message: "地址必须使用 https://" };
    }
  }
  if (hostIsLoopback && !allowLoopback) {
    return { ok: false, error: errorCode, message: "地址不能指向本机回环地址（SSRF 防护）" };
  }
  if (isIP(host) !== 0 && isForbiddenStorageIp(host, { allowLoopback })) {
    return { ok: false, error: errorCode, message: "地址不能指向内网、保留或链路本地 IP（SSRF 防护）" };
  }
  return { ok: true, url: u.toString().replace(/\/+$/, "") };
}

const defaultStorageLookup: StorageLookupFn = (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

/**
 * Full async SSRF validation before any Hub outbound request or config write:
 * 1. Static scheme / credential / literal IP validation.
 * 2. DNS resolution (all A/AAAA records) with FAIL-CLOSED on lookup error or empty result.
 * 3. Every resolved IP checked against isForbiddenStorageIp (RFC1918, 127/8, 169.254/16, 100.64/10, ::1, fc00::/7, fe80::/10, etc.).
 */
export async function assertSafeStorageUrl(
  urlStr: string,
  opts: SafeStorageUrlOptions = {},
): Promise<{ url: string; hostname: string; addresses: ReadonlyArray<{ address: string; family: number }> }> {
  const allowLoopback = opts.allowLoopback ?? isStorageLoopbackAllowed();
  const blockCode: StorageSsrfErrorCode = opts.errorCode ?? "storage_ssrf_blocked";
  const dnsCode: StorageSsrfErrorCode = opts.errorCode ?? "storage_ssrf_dns_failed";

  const staticRes = validateStorageUrl(urlStr, "invalid_endpoint", { allowLoopback });
  if (!staticRes.ok || !staticRes.url) {
    throw new StorageSsrfError(
      blockCode,
      staticRes.ok ? "地址不能为空" : staticRes.message,
      { reason: "static_rejected" },
    );
  }

  const u = new URL(staticRes.url);
  const host = normalizeHostForCheck(u.hostname);
  const ipFamily = isIP(host);
  if (ipFamily !== 0) {
    if (isForbiddenStorageIp(host, { allowLoopback })) {
      throw new StorageSsrfError(blockCode, `目标 IP ${host} 属于禁止访问的内网/保留网段（SSRF 防护）`, {
        reason: "forbidden_ip",
        ip: host,
      });
    }
    return { url: staticRes.url, hostname: host, addresses: [{ address: host, family: ipFamily }] };
  }

  const lookupFn = opts.lookupFn ?? defaultStorageLookup;
  let addrs: ReadonlyArray<{ address: string; family: number }>;
  try {
    addrs = await lookupFn(host);
  } catch (e: any) {
    throw new StorageSsrfError(
      dnsCode,
      `域名 ${host} DNS 解析失败，已按安全策略拒绝访问（SSRF 防护）`,
      { reason: "dns_lookup_failed", host, error: e?.code || e?.message || String(e) },
    );
  }

  if (!Array.isArray(addrs) || addrs.length === 0) {
    throw new StorageSsrfError(
      dnsCode,
      `域名 ${host} 未解析到有效 IP，已按安全策略拒绝访问（SSRF 防护）`,
      { reason: "dns_empty", host },
    );
  }

  for (const record of addrs) {
    if (!record || typeof record.address !== "string" || isForbiddenStorageIp(record.address, { allowLoopback })) {
      throw new StorageSsrfError(
        blockCode,
        `域名 ${host} 解析到禁止访问的内网/保留 IP（SSRF 防护）`,
        { reason: "forbidden_resolved_ip", host, ip: record?.address ?? "" },
      );
    }
  }

  return { url: staticRes.url, hostname: host, addresses: addrs };
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function stripHeadersCaseInsensitive(headers: HeadersInit | undefined, namesToStrip: ReadonlySet<string>): Headers {
  const out = new Headers(headers);
  for (const key of [...out.keys()]) {
    if (namesToStrip.has(key.toLowerCase())) {
      out.delete(key);
    }
  }
  return out;
}

/**
 * SSRF-hardened outbound fetch for all Hub → external storage requests:
 * - Validates initial URL (scheme + literal IP + DNS resolution + IP blocklist) before connecting.
 * - Uses `redirect: "manual"` and re-validates EVERY redirect hop target BEFORE following.
 * - Strips Authorization / Cookie / Proxy-Authorization headers on cross-origin redirects.
 * - Enforces a strict redirect hop cap (default 5).
 */
export async function safeStorageFetch(
  url: string,
  init: RequestInit = {},
  opts: SafeStorageFetchOptions = {},
): Promise<Response> {
  const fetchFn = opts.fetchFn ?? fetch;
  const maxRedirects = opts.maxRedirects ?? MAX_STORAGE_REDIRECTS;

  let currentUrl = url;
  let currentMethod = (init.method || "GET").toUpperCase();
  let currentHeaders = new Headers(init.headers);
  let currentBody = init.body;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertSafeStorageUrl(currentUrl, {
      allowLoopback: opts.allowLoopback,
      lookupFn: opts.lookupFn,
    });

    const res = await fetchFn(currentUrl, {
      ...init,
      method: currentMethod,
      headers: currentHeaders,
      body: currentBody,
      redirect: "manual",
    });

    if (!REDIRECT_STATUSES.has(res.status)) {
      return res;
    }

    const location = res.headers.get("Location");
    if (!location) {
      return res;
    }

    // Drain/cancel intermediate redirect body to avoid holding sockets open.
    await res.body?.cancel().catch(() => {});

    if (hop >= maxRedirects) {
      throw new StorageSsrfError(
        "storage_ssrf_too_many_redirects",
        `远程存储重定向次数超过上限（${maxRedirects} 次），已拒绝请求`,
        { reason: "too_many_redirects", maxRedirects },
      );
    }

    let nextUrl: string;
    try {
      nextUrl = new URL(location, currentUrl).toString();
    } catch {
      throw new StorageSsrfError(
        "storage_ssrf_blocked",
        "远程存储返回无效的重定向地址（SSRF 防护）",
        { reason: "invalid_redirect_location" },
      );
    }

    const prevOrigin = new URL(currentUrl).origin;
    const nextOrigin = new URL(nextUrl).origin;
    if (prevOrigin !== nextOrigin) {
      currentHeaders = stripHeadersCaseInsensitive(
        currentHeaders,
        new Set(["authorization", "cookie", "proxy-authorization"]),
      );
    }

    if (res.status === 303 || ((res.status === 301 || res.status === 302) && currentMethod === "POST")) {
      currentMethod = "GET";
      currentBody = undefined;
      currentHeaders = stripHeadersCaseInsensitive(
        currentHeaders,
        new Set(["content-length", "content-type"]),
      );
    }

    currentUrl = nextUrl;
  }

  throw new StorageSsrfError(
    "storage_ssrf_too_many_redirects",
    `远程存储重定向次数超过上限（${maxRedirects} 次），已拒绝请求`,
    { reason: "too_many_redirects", maxRedirects },
  );
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

export interface HubManagedStorageRuntime {
  config: Omit<ActiveStorageRuntimeConfig, "network_id">;
  keyHint: string;
}

/**
 * Read optional Hub-level managed default external storage from environment variables
 * (`COMMHUB_STORAGE_PROVIDER` — `s3` or `oss` only; `COMMHUB_STORAGE_BUCKET`, `COMMHUB_STORAGE_REGION`,
 * `COMMHUB_STORAGE_ENDPOINT`, `COMMHUB_STORAGE_ACCESS_KEY_ID`, `COMMHUB_STORAGE_ACCESS_KEY_SECRET`,
 * `COMMHUB_STORAGE_SESSION_TOKEN`).
 *
 * ModelScope is intentionally refused for Hub-managed multi-network default storage as defense-in-depth:
 * Hub-managed storage shares one backing store across networks and must use per-object presigned object
 * storage (`s3` / `oss`) so master credentials cannot span networks and downloads never fall back to Hub bandwidth.
 * Per-network admin self-configured ModelScope (`PUT /api/storage/config`) remains supported.
 *
 * Strictly private-only and SSRF-validated; returns null if unset, disabled (`COMMHUB_STORAGE_ENABLED=0/false`),
 * or invalid (fail-closed, never throws). Any network without a per-network override inherits this seamlessly.
 */
export function readHubManagedStorageConfig(
  env: Record<string, string | undefined> = process.env,
): HubManagedStorageRuntime | null {
  const rawEnabled = (env.COMMHUB_STORAGE_ENABLED ?? "").trim().toLowerCase();
  if (rawEnabled === "0" || rawEnabled === "false" || rawEnabled === "off") return null;

  const rawProvider = (env.COMMHUB_STORAGE_PROVIDER ?? "").trim().toLowerCase();
  if (!rawProvider) return null;
  const provider = normalizeProvider(rawProvider, "s3");
  // Defense-in-depth: Hub-managed multi-network default storage only permits per-object presigned
  // object storage (s3 / oss), never modelscope.
  if (!provider || provider === "modelscope") return null;

  const allowLoopback = isStorageLoopbackAllowed(env);
  const epCheck = validateStorageUrl(env.COMMHUB_STORAGE_ENDPOINT ?? "", "invalid_endpoint", { allowLoopback });
  if (!epCheck.ok) return null;

  const prefixRaw = env.COMMHUB_STORAGE_PREFIX !== undefined ? env.COMMHUB_STORAGE_PREFIX : DEFAULT_STORAGE_PREFIX;
  const prefix = validateStoragePrefix(prefixRaw);
  if (prefix === null) return null;

  let maxFileBytes = DEFAULT_REMOTE_UPLOAD_BYTES;
  const rawMax = (env.COMMHUB_STORAGE_MAX_FILE_BYTES ?? "").trim();
  if (rawMax) {
    const n = Number(rawMax);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < MIN_REMOTE_UPLOAD_BYTES || n > MAX_REMOTE_UPLOAD_BYTES) {
      return null;
    }
    maxFileBytes = n;
  }

  const bucket = validateBucketName(env.COMMHUB_STORAGE_BUCKET ?? "");
  const region = validateRegion(env.COMMHUB_STORAGE_REGION ?? "");
  const ak = (env.COMMHUB_STORAGE_ACCESS_KEY_ID ?? "").trim();
  const sk = (env.COMMHUB_STORAGE_ACCESS_KEY_SECRET ?? env.COMMHUB_STORAGE_SECRET_ACCESS_KEY ?? "").trim();
  const sessionToken = (env.COMMHUB_STORAGE_SESSION_TOKEN ?? "").trim();
  if (!bucket || !region || !isValidSecretString(ak) || !isValidSecretString(sk)) return null;
  if (sessionToken && !isValidSecretString(sessionToken)) return null;
  if (provider === "s3" && isAwsS3AccelerateEndpoint(epCheck.url) && bucket.includes(".")) return null;

  return {
    config: {
      enabled: true,
      provider,
      endpoint: epCheck.url,
      region,
      bucket,
      repo_id: "",
      repo_type: "dataset",
      revision: DEFAULT_MODELSCOPE_REVISION,
      prefix,
      public_base_url: "",
      max_file_bytes: maxFileBytes,
      secrets: {
        access_key_id: ak,
        access_key_secret: sk,
        ...(sessionToken ? { session_token: sessionToken } : {}),
      },
    },
    keyHint: maskStorageSecretTail(ak),
  };
}

function runtimeMatchesStorageMeta(cfg: Omit<ActiveStorageRuntimeConfig, "network_id">, storage: RemoteStorageIndexMeta): boolean {
  if (cfg.provider !== storage.provider) return false;
  if (storage.provider === "modelscope") {
    return !storage.repo_id || cfg.repo_id === storage.repo_id;
  }
  return (!storage.bucket || cfg.bucket === storage.bucket) && (!storage.region || cfg.region === storage.region);
}

function draftMatchesHubManagedWithoutSecrets(
  draft: StorageConfigWriteInput,
  hubDefault: HubManagedStorageRuntime,
  allowLoopback?: boolean,
): boolean {
  const hasAnySecret = [
    draft.api_token,
    draft.token,
    draft.access_key_id,
    draft.access_key_secret,
    draft.secret_access_key,
    draft.session_token,
  ].some((v) => typeof v === "string" && v.trim().length > 0);
  if (hasAnySecret) return false;

  const target = hubDefault.config;
  const prov = normalizeProvider(draft.provider, target.provider);
  if (prov !== target.provider) return false;

  const epRaw = typeof draft.endpoint === "string" ? draft.endpoint : target.endpoint;
  const epCheck = validateStorageUrl(epRaw, "invalid_endpoint", { allowLoopback });
  if (!epCheck.ok || epCheck.url !== target.endpoint) return false;

  if (target.provider === "modelscope") return false;

  const bucket = typeof draft.bucket === "string" ? validateBucketName(draft.bucket) : target.bucket;
  const region = typeof draft.region === "string" ? validateRegion(draft.region) : target.region;
  return bucket === target.bucket && region === target.region;
}

function toPublicConfig(
  networkId: string,
  row: StoredMetaRow | null | undefined,
  canManage: boolean,
  hubDefault: HubManagedStorageRuntime | null,
): NetworkStoragePublicConfig {
  const configured = !!row && Number(row.configured) === 1;
  if (!configured && hubDefault) {
    const hc = hubDefault.config;
    return {
      ok: true,
      network_id: networkId,
      enabled: hc.enabled,
      configured: true,
      source: "hub_managed",
      hub_managed_available: true,
      provider: hc.provider,
      endpoint: hc.endpoint,
      region: hc.region,
      bucket: hc.bucket,
      repo_id: hc.repo_id,
      repo_type: hc.repo_type,
      revision: hc.revision,
      prefix: hc.prefix,
      public_base_url: "",
      max_file_bytes: hc.max_file_bytes,
      key_hint: hubDefault.keyHint,
      can_manage: canManage,
      vault_ready: isStorageVaultReady(),
      updated_at: null,
    };
  }
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
    source: configured ? "network" : "none",
    hub_managed_available: !!hubDefault,
    provider,
    endpoint: row?.endpoint || "",
    region: row?.region || "",
    bucket: row?.bucket || "",
    repo_id: row?.repo_id || "",
    repo_type: repoType,
    revision: row?.revision || DEFAULT_MODELSCOPE_REVISION,
    prefix: row?.prefix ?? DEFAULT_STORAGE_PREFIX,
    public_base_url: "",
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
  return toPublicConfig(networkId, row, canManage, readHubManagedStorageConfig());
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
  if (!row || Number(row.configured) !== 1) {
    const hubDefault = readHubManagedStorageConfig();
    if (!hubDefault) return { ok: true, config: null };
    if (requireEnabled && !hubDefault.config.enabled) return { ok: true, config: null };
    return {
      ok: true,
      config: {
        ...hubDefault.config,
        network_id: networkId,
      },
    };
  }
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
      public_base_url: "",
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
  opts: { allowLoopback?: boolean } = {},
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
  const ep = validateStorageUrl(epRaw, "invalid_endpoint", opts);
  if (!ep.ok) return ep;

  // Strictly private-only policy: public CDN / unauthenticated base URLs are forbidden.
  const pubRaw = typeof input.public_base_url === "string" ? input.public_base_url.trim() : "";
  if (pubRaw) {
    return {
      ok: false,
      error: "invalid_public_base_url",
      message: "出于隐私安全策略，禁止配置公开下载 / CDN 地址（仅允许私有鉴权直传）",
    };
  }
  const pub = { ok: true as const, url: "" };

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
  if (provider === "s3" && isAwsS3AccelerateEndpoint(ep.url) && bucket.includes(".")) {
    return {
      ok: false,
      error: "invalid_bucket",
      message: "AWS S3 传输加速（s3-accelerate.amazonaws.com）要求 Bucket 名称不能包含点号（.）",
    };
  }

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

/** Async write-time URL + DNS SSRF validation for PUT /api/storage/config. */
export async function validateStorageConfigUrlsAsync(
  networkId: string,
  input: StorageConfigWriteInput,
  opts: SafeStorageUrlOptions = {},
): Promise<{ ok: true } | { ok: false; error: StorageWriteErrorCode; message: string }> {
  const existing = readStoredSecretRow(networkId);
  const resolved = resolveDraftConfig(networkId, input, existing, { allowLoopback: opts.allowLoopback });
  if (!resolved.ok) return resolved;

  if (resolved.endpoint) {
    const urlsToCheck: string[] = [];
    if (resolved.provider === "oss" || resolved.provider === "s3") {
      // Validate the effective virtual-host / path-style request URL so wildcard-only accelerate
      // endpoints (e.g. s3-accelerate.amazonaws.com, oss-accelerate.aliyuncs.com) resolve <bucket>.<host>.
      urlsToCheck.push(
        resolveS3OrOssTarget(resolved.provider, resolved.bucket, resolved.region, resolved.endpoint, "").urlBase,
      );
      if (isObjectStorageAccelerateEndpoint(resolved.provider, resolved.endpoint)) {
        urlsToCheck.push(
          resolveS3OrOssTarget(resolved.provider, resolved.bucket, resolved.region, "", "").urlBase,
        );
      }
    } else {
      urlsToCheck.push(resolved.endpoint);
    }

    for (const targetUrl of urlsToCheck) {
      try {
        await assertSafeStorageUrl(targetUrl, { ...opts, errorCode: "invalid_endpoint" });
      } catch (e: any) {
        return {
          ok: false,
          error: "invalid_endpoint",
          message: e instanceof StorageSsrfError ? e.message : `接口地址不安全：${e?.message || e}`,
        };
      }
    }
  }
  return { ok: true };
}

/**
 * Async write-time privacy gate for PUT /api/storage/config:
 * - When enabled=true, verifies live against the provider that the target repo/bucket is STRICTLY PRIVATE
 *   (ModelScope Visibility=1; OSS/S3 non-public ACL, non-public policy, and non-public anonymous access).
 * - When enabled=false, skips live upstream probe so admins can always disable a relay immediately.
 */
export async function verifyStorageConfigPrivateAsync(
  networkId: string,
  input: StorageConfigWriteInput,
  fetchFn: typeof fetch = fetch,
  ssrfOpts: SafeStorageUrlOptions = {},
): Promise<
  | { ok: true }
  | { ok: false; status: number; error: string; message: string; visibility?: "private" | "public" | "unknown" }
> {
  const existing = readStoredSecretRow(networkId);
  const resolved = resolveDraftConfig(networkId, input, existing, { allowLoopback: ssrfOpts.allowLoopback });
  if (!resolved.ok) {
    return {
      ok: false,
      status: storageWriteStatus(resolved.error),
      error: resolved.error,
      message: resolved.message,
    };
  }
  if (!resolved.enabled) {
    return { ok: true };
  }
  const testRes = await testNetworkStorageConfig(networkId, input, fetchFn, ssrfOpts);
  if (testRes.ok) return { ok: true };
  const errCode = testRes.error || "public_storage_forbidden";
  const status =
    errCode.startsWith("vault_") ? 503
      : errCode === "network_error" ? 502
      : 400;
  return {
    ok: false,
    status,
    error: errCode,
    message: testRes.message,
    ...(testRes.visibility ? { visibility: testRes.visibility } : {}),
  };
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

export function isAwsS3AccelerateEndpoint(endpoint: string): boolean {
  const raw = endpoint.trim();
  if (!raw) return false;
  try {
    const host = normalizeHostForCheck(new URL(raw).hostname);
    return host === "s3-accelerate.amazonaws.com"
      || host.endsWith(".s3-accelerate.amazonaws.com")
      || host === "s3-accelerate.dualstack.amazonaws.com"
      || host.endsWith(".s3-accelerate.dualstack.amazonaws.com");
  } catch {
    return false;
  }
}

export function isOssAccelerateEndpoint(endpoint: string): boolean {
  const raw = endpoint.trim();
  if (!raw) return false;
  try {
    const host = normalizeHostForCheck(new URL(raw).hostname);
    return host === "oss-accelerate.aliyuncs.com"
      || host.endsWith(".oss-accelerate.aliyuncs.com")
      || host === "oss-accelerate-overseas.aliyuncs.com"
      || host.endsWith(".oss-accelerate-overseas.aliyuncs.com");
  } catch {
    return false;
  }
}

function isObjectStorageAccelerateEndpoint(provider: "oss" | "s3", endpoint: string): boolean {
  return provider === "s3" ? isAwsS3AccelerateEndpoint(endpoint) : isOssAccelerateEndpoint(endpoint);
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
  const encodedKey = objectKey ? encodeObjectKeyPath(objectKey) : "";
  const rawEndpoint = endpointOverride.trim()
    || (provider === "oss"
      ? `https://oss-${region.replace(/^oss-/, "")}.aliyuncs.com`
      : `https://s3.${region}.amazonaws.com`);
  const parsed = new URL(rawEndpoint);
  const hostLower = parsed.hostname.toLowerCase();
  // Cloudflare R2 (*.r2.cloudflarestorage.com) uses path-style addressing so single-level TLS wildcard certs match.
  const usePathStyle = isLoopbackHost(hostLower)
    || isIpLiteral(hostLower)
    || parsed.pathname.length > 1
    || (provider === "s3" && hostLower.endsWith(".r2.cloudflarestorage.com"));

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
  extraQuery?: ReadonlyArray<readonly [string, string]>;
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

  if (params.extraQuery) {
    for (const [k, v] of params.extraQuery) {
      queryParams.push([k, v]);
    }
  }

  queryParams.sort(([aKey, aVal], [bKey, bVal]) => {
    const ka = encodeRfc3986(aKey);
    const kb = encodeRfc3986(bKey);
    if (ka !== kb) return ka < kb ? -1 : 1;
    const va = encodeRfc3986(aVal);
    const vb = encodeRfc3986(bVal);
    return va < vb ? -1 : va > vb ? 1 : 0;
  });
  // Aliyun OSS V4 omits "=" for valueless subresource params (e.g. `?acl`),
  // whereas AWS SigV4 requires `acl=`.
  const canonicalQuery = queryParams
    .map(([k, v]) => (isOss && v === "" ? encodeRfc3986(k) : `${encodeRfc3986(k)}=${encodeRfc3986(v)}`))
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
  url: string,
  init: RequestInit,
  opts: SafeStorageFetchOptions = {},
): Promise<{ ok: boolean; status: number; body: any; rawText: string }> {
  const res = await safeStorageFetch(url, init, opts);
  const rawText = await res.text().catch(() => "");
  let body: any = null;
  try { body = rawText ? JSON.parse(rawText) : null; } catch { /* non-JSON */ }
  return { ok: res.ok, status: res.status, body, rawText };
}

function isPublicBucketAclXml(provider: "oss" | "s3", xml: string): boolean {
  if (provider === "oss") {
    return /<Grant>\s*public-read(?:-write)?\s*<\/Grant>/i.test(xml);
  }
  return /https?:\/\/acs\.amazonaws\.com\/groups\/global\/(?:AllUsers|AuthenticatedUsers)/i.test(xml);
}

function isWildcardPrincipal(principal: unknown): boolean {
  if (principal === "*") return true;
  if (Array.isArray(principal)) return principal.some((p) => p === "*");
  if (principal && typeof principal === "object") {
    const aws = (principal as Record<string, unknown>).AWS;
    if (aws === "*") return true;
    if (Array.isArray(aws)) return aws.some((p) => p === "*");
  }
  return false;
}

function isPublicBucketPolicyJson(rawText: string): boolean {
  let parsed: any;
  try {
    parsed = rawText ? JSON.parse(rawText) : null;
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object") return false;
  const rawStatements = parsed.Statement;
  const statements = Array.isArray(rawStatements) ? rawStatements : (rawStatements ? [rawStatements] : []);
  for (const stmt of statements) {
    if (!stmt || typeof stmt !== "object") continue;
    if (String(stmt.Effect || "").toLowerCase() !== "allow") continue;
    if (isWildcardPrincipal(stmt.Principal)) return true;
  }
  return false;
}

// ── Unified Provider Operations ───────────────────────────────────────────

/** Test either a saved config or an unsaved draft config against the live provider. */
export async function testNetworkStorageConfig(
  networkId: string,
  draft: StorageConfigWriteInput | null,
  fetchFn: typeof fetch = fetch,
  ssrfOpts: SafeStorageUrlOptions = {},
): Promise<StorageTestResult> {
  const started = Date.now();
  const existing = readStoredSecretRow(networkId);
  let cfg: ActiveStorageRuntimeConfig;
  const fetchOpts: SafeStorageFetchOptions = { ...ssrfOpts, fetchFn };

  if (draft && Object.keys(draft).length > 0) {
    const hubDefault = !existing ? readHubManagedStorageConfig() : null;
    if (hubDefault && draftMatchesHubManagedWithoutSecrets(draft, hubDefault, ssrfOpts.allowLoopback)) {
      cfg = {
        ...hubDefault.config,
        network_id: networkId,
      };
    } else {
      const resolved = resolveDraftConfig(networkId, draft, existing, { allowLoopback: ssrfOpts.allowLoopback });
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
    }
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
    if (cfg.public_base_url) {
      return {
        ok: false,
        provider: cfg.provider,
        latency_ms: Date.now() - started,
        error: "invalid_public_base_url",
        message: "出于隐私安全策略，禁止配置公开下载 / CDN 地址（仅允许私有鉴权直传）",
      };
    }

    if (cfg.provider === "modelscope") {
      const token = cfg.secrets.token || "";
      if (!token) {
        return { ok: false, provider: "modelscope", latency_ms: Date.now() - started, error: "credential_required", message: "缺少 ModelScope API Token" };
      }
      const ep = modelScopeEndpoint(cfg);
      const seg = modelScopeRepoSegment(cfg.repo_type);
      const infoUrl = `${ep}/api/v1/${seg}/${cfg.repo_id}`;
      const r = await fetchJsonSafe(infoUrl, {
        method: "GET",
        headers: modelScopeAuthHeaders(token),
        signal: AbortSignal.timeout(15_000),
      }, fetchOpts);
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
      if (visibility !== "private") {
        return {
          ok: false,
          provider: "modelscope",
          latency_ms: latency,
          visibility,
          error: "public_storage_forbidden",
          message: visibility === "public"
            ? `安全策略禁止使用公开（Public）ModelScope 仓库 ${cfg.repo_id}，请将仓库设为私有（Private）后再试`
            : `无法确认 ModelScope 仓库 ${cfg.repo_id} 为私有（Visibility=${String(visNum ?? "unknown")}），出于隐私安全策略已拒绝启用`,
        };
      }
      return {
        ok: true,
        provider: "modelscope",
        latency_ms: latency,
        visibility: "private",
        message: `连接成功：ModelScope 私有仓库 ${cfg.repo_id} 校验通过`,
      };
    }

    // Aliyun OSS / AWS S3:
    // 1. Verify data-plane access via signed HEAD on a probe key (200 or 404 = valid credentials & bucket).
    // 2. Enforce strict private-only policy via anonymous list/read probes + signed ACL & policy checks.
    //    For Transfer Acceleration endpoints (s3-accelerate / oss-accelerate), control-plane probes
    //    target the standard regional endpoint so bucket ACL/policyStatus checks never fail or degrade.
    const providerLabel = cfg.provider === "oss" ? "阿里云 OSS" : "AWS S3";
    const isAccelerate = isObjectStorageAccelerateEndpoint(cfg.provider, cfg.endpoint);
    const controlEndpoint = isAccelerate ? "" : cfg.endpoint;
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
    const res = await safeStorageFetch(signedUrl, { method: "HEAD", signal: AbortSignal.timeout(15_000) }, fetchOpts);
    await res.body?.cancel().catch(() => {});
    if (res.status !== 200 && res.status !== 404) {
      if (isAccelerate && (res.status === 400 || res.status === 403)) {
        return {
          ok: false,
          provider: cfg.provider,
          latency_ms: Date.now() - started,
          error: res.status === 403 ? "auth_failed" : "bucket_check_failed",
          message: cfg.provider === "s3"
            ? `AWS S3 传输加速校验失败（HTTP ${res.status}）：请确认已在 AWS S3 控制台为 Bucket "${cfg.bucket}" 开启「Transfer Acceleration（传输加速）」，且 AccessKey 与 Region（${cfg.region}）正确`
            : `阿里云 OSS 传输加速校验失败（HTTP ${res.status}）：请确认已在阿里云 OSS 控制台为 Bucket "${cfg.bucket}" 开启「传输加速」，且 AccessKey 与地域（${cfg.region}）正确`,
        };
      }
      return {
        ok: false,
        provider: cfg.provider,
        latency_ms: Date.now() - started,
        error: res.status === 403 ? "auth_failed" : "bucket_check_failed",
        message: `${providerLabel} 校验失败（HTTP ${res.status}）`,
      };
    }

    const bucketRootUrl = resolveS3OrOssTarget(cfg.provider, cfg.bucket, cfg.region, controlEndpoint, "").urlBase;
    const probeObjectUrl = resolveS3OrOssTarget(cfg.provider, cfg.bucket, cfg.region, controlEndpoint, probeKey).urlBase;

    // Privacy probe A: unsigned anonymous bucket listing MUST NOT succeed.
    const anonListRes = await safeStorageFetch(
      `${bucketRootUrl}?list-type=2&max-keys=1`,
      { method: "GET", signal: AbortSignal.timeout(10_000) },
      fetchOpts,
    );
    await anonListRes.body?.cancel().catch(() => {});
    if (anonListRes.status >= 200 && anonListRes.status < 300) {
      return {
        ok: false,
        provider: cfg.provider,
        latency_ms: Date.now() - started,
        visibility: "public",
        error: "public_storage_forbidden",
        message: `安全策略禁止使用公开（允许匿名列举）的 ${providerLabel} Bucket（${cfg.bucket}），请将读写权限设为私有（Private）后再试`,
      };
    }

    // Privacy probe B: unsigned anonymous HEAD on probe object MUST NOT return 2xx.
    const anonHeadRes = await safeStorageFetch(
      probeObjectUrl,
      { method: "HEAD", signal: AbortSignal.timeout(10_000) },
      fetchOpts,
    );
    await anonHeadRes.body?.cancel().catch(() => {});
    if (anonHeadRes.status >= 200 && anonHeadRes.status < 300) {
      return {
        ok: false,
        provider: cfg.provider,
        latency_ms: Date.now() - started,
        visibility: "public",
        error: "public_storage_forbidden",
        message: `安全策略禁止使用允许匿名读取的公开 ${providerLabel} Bucket（${cfg.bucket}），请将读写权限设为私有（Private）后再试`,
      };
    }

    // Privacy probe C: signed GET ?acl checks OSS public-read/public-read-write & S3 AllUsers/AuthenticatedUsers.
    const signedAclUrl = signObjectStoragePresignedUrl({
      provider: cfg.provider,
      method: "GET",
      bucket: cfg.bucket,
      region: cfg.region,
      endpoint: controlEndpoint,
      objectKey: "",
      extraQuery: [["acl", ""]],
      accessKeyId: ak,
      accessKeySecret: sk,
      sessionToken: cfg.secrets.session_token,
      expiresSeconds: 120,
    });
    const aclRes = await safeStorageFetch(signedAclUrl, { method: "GET", signal: AbortSignal.timeout(10_000) }, fetchOpts);
    if (aclRes.status === 200) {
      const aclXml = await aclRes.text().catch(() => "");
      if (isPublicBucketAclXml(cfg.provider, aclXml)) {
        return {
          ok: false,
          provider: cfg.provider,
          latency_ms: Date.now() - started,
          visibility: "public",
          error: "public_storage_forbidden",
          message: `安全策略禁止使用公开 ACL 的 ${providerLabel} Bucket（${cfg.bucket}），请将 Bucket ACL 设为私有（Private）后再试`,
        };
      }
    } else {
      await aclRes.body?.cancel().catch(() => {});
    }

    // Privacy probe D: AWS S3 GetBucketPolicyStatus (?policyStatus) + OSS/S3-compat GetBucketPolicy (?policy).
    let checkPolicyJson = cfg.provider === "oss";
    if (cfg.provider === "s3") {
      const signedPolicyStatusUrl = signObjectStoragePresignedUrl({
        provider: "s3",
        method: "GET",
        bucket: cfg.bucket,
        region: cfg.region,
        endpoint: controlEndpoint,
        objectKey: "",
        extraQuery: [["policyStatus", ""]],
        accessKeyId: ak,
        accessKeySecret: sk,
        sessionToken: cfg.secrets.session_token,
        expiresSeconds: 120,
      });
      const psRes = await safeStorageFetch(signedPolicyStatusUrl, { method: "GET", signal: AbortSignal.timeout(10_000) }, fetchOpts);
      if (psRes.status === 200) {
        const psXml = await psRes.text().catch(() => "");
        if (/<IsPublic>\s*true\s*<\/IsPublic>/i.test(psXml)) {
          return {
            ok: false,
            provider: "s3",
            latency_ms: Date.now() - started,
            visibility: "public",
            error: "public_storage_forbidden",
            message: `安全策略禁止使用公开 Bucket Policy 的 AWS S3 Bucket（${cfg.bucket}），请关闭公开访问并开启 Block Public Access 后再试`,
          };
        }
      } else {
        await psRes.body?.cancel().catch(() => {});
        if (psRes.status === 405 || psRes.status === 501) {
          checkPolicyJson = true;
        }
      }
    }
    if (checkPolicyJson) {
      const signedPolicyUrl = signObjectStoragePresignedUrl({
        provider: cfg.provider,
        method: "GET",
        bucket: cfg.bucket,
        region: cfg.region,
        endpoint: controlEndpoint,
        objectKey: "",
        extraQuery: [["policy", ""]],
        accessKeyId: ak,
        accessKeySecret: sk,
        sessionToken: cfg.secrets.session_token,
        expiresSeconds: 120,
      });
      const polRes = await safeStorageFetch(signedPolicyUrl, { method: "GET", signal: AbortSignal.timeout(10_000) }, fetchOpts);
      if (polRes.status === 200) {
        const polText = await polRes.text().catch(() => "");
        if (isPublicBucketPolicyJson(polText)) {
          return {
            ok: false,
            provider: cfg.provider,
            latency_ms: Date.now() - started,
            visibility: "public",
            error: "public_storage_forbidden",
            message: `安全策略禁止使用包含匿名公开授权策略（Principal="*"）的 ${providerLabel} Bucket（${cfg.bucket}），请移除公开策略后再试`,
          };
        }
      } else {
        await polRes.body?.cancel().catch(() => {});
      }
    }

    return {
      ok: true,
      provider: cfg.provider,
      latency_ms: Date.now() - started,
      visibility: "private",
      message: isAccelerate
        ? `连接成功：${providerLabel} 私有 Bucket ${cfg.bucket} 校验通过（已启用传输加速）`
        : `连接成功：${providerLabel} 私有 Bucket ${cfg.bucket} 校验通过`,
    };
  } catch (e: any) {
    if (e instanceof StorageSsrfError) {
      return {
        ok: false,
        provider: cfg.provider,
        latency_ms: Date.now() - started,
        error: e.code,
        message: e.message,
      };
    }
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
    route?: StorageRouteOptions;
  },
  fetchFn: typeof fetch = fetch,
  ssrfOpts: SafeStorageUrlOptions = {},
): Promise<PresignStorageResult> {
  const objectKey = buildRemoteObjectKey(cfg.prefix, params.networkId, params.dateBucket, params.fileId, params.ext);
  const fetchOpts: SafeStorageFetchOptions = { ...ssrfOpts, fetchFn };

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
      r = await fetchJsonSafe(batchUrl, {
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
      }, fetchOpts);
    } catch (e: any) {
      if (e instanceof StorageSsrfError) {
        return { ok: false, status: 400, error: e.code, message: e.message };
      }
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
    };

    // Live ModelScope returns `Data: { objects: [], "reused-objects": [] }` when the blob already exists in LFS.
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
      // Standard Git-LFS dedup: object returned without upload action; client only needs /complete to commit pointer.
      return {
        ok: true,
        provider: "modelscope",
        object_key: objectKey,
        skip_upload: true,
        upload: null,
        storage_meta: storageMeta,
      };
    }

    const hrefCheck = validateStorageUrl(uploadAction.href, "invalid_endpoint", {
      allowLoopback: ssrfOpts.allowLoopback,
    });
    if (!hrefCheck.ok) {
      return {
        ok: false,
        status: 502,
        error: "storage_presign_bad_response",
        message: `ModelScope LFS 返回不安全的上传地址：${hrefCheck.message}`,
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
  if (cfg.endpoint) {
    const epCheck = validateStorageUrl(cfg.endpoint, "invalid_endpoint", { allowLoopback: ssrfOpts.allowLoopback });
    if (!epCheck.ok) {
      return { ok: false, status: 400, error: "storage_ssrf_blocked", message: epCheck.message };
    }
  }
  const accelConfigured = isObjectStorageAccelerateEndpoint(cfg.provider, cfg.endpoint);
  const preferRegional = accelConfigured && shouldPreferRegionalOverAccelerate(cfg.provider, cfg.endpoint, params.route);
  const primaryEndpoint = preferRegional ? "" : cfg.endpoint;
  const fallbackEndpoint = preferRegional ? cfg.endpoint : "";
  const effectiveRoute: StorageEffectiveRoute | undefined = accelConfigured
    ? (preferRegional ? "regional" : "accelerate")
    : undefined;

  const signedPutUrl = signObjectStoragePresignedUrl({
    provider: cfg.provider,
    method: "PUT",
    bucket: cfg.bucket,
    region: cfg.region,
    endpoint: primaryEndpoint,
    objectKey,
    accessKeyId: ak,
    accessKeySecret: sk,
    sessionToken: cfg.secrets.session_token,
    expiresSeconds: PRESIGN_TTL_SECONDS,
  });

  // When Transfer Acceleration is configured, always emit the complementary fallback PUT target
  // (regional for external/CN accelerate callers; accelerate for AWS regional-direct callers).
  const fallbackUpload: DirectUploadInstruction | null = accelConfigured
    ? {
        method: "PUT",
        url: signObjectStoragePresignedUrl({
          provider: cfg.provider,
          method: "PUT",
          bucket: cfg.bucket,
          region: cfg.region,
          endpoint: fallbackEndpoint,
          objectKey,
          accessKeyId: ak,
          accessKeySecret: sk,
          sessionToken: cfg.secrets.session_token,
          expiresSeconds: PRESIGN_TTL_SECONDS,
        }),
        headers: {},
      }
    : null;

  const storageMeta: RemoteStorageIndexMeta = {
    provider: cfg.provider,
    object_key: objectKey,
    sha256: params.sha256,
    bucket: cfg.bucket,
    region: cfg.region,
    ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
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
    ...(fallbackUpload ? { fallback_upload: fallbackUpload } : {}),
    ...(effectiveRoute ? { route: effectiveRoute } : {}),
    storage_meta: storageMeta,
  };
}

// Per-repo ModelScope Git commit coalescer + 429 retry queue.
// Live ModelScope benchmarks showed concurrent `POST .../commit/master` calls collide with
// HTTP 429 Code 10030000001 ("commit lock busy, please try again"). Serializing and
// micro-batching actions per repo eliminates 429s and coalesces multi-file sends into one commit.
interface QueuedModelScopeCommitItem {
  fileId: string;
  size: number;
  objectKey: string;
  sha256: string;
  token: string;
  fetchOpts: SafeStorageFetchOptions;
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
      const fetchOpts = batch[0].fetchOpts;
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
          r = await fetchJsonSafe(commitUrl, {
            method: "POST",
            headers: {
              ...modelScopeAuthHeaders(token),
              "Content-Type": "application/json",
            },
            body: payload,
            signal: AbortSignal.timeout(25_000),
          }, fetchOpts);
        } catch (e: any) {
          if (e instanceof StorageSsrfError) {
            outcome = { ok: false, status: 400, error: e.code, message: e.message };
          } else {
            outcome = { ok: false, status: 502, error: "storage_commit_error", message: `ModelScope 提交失败：${e?.message || e}` };
          }
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
  const queueKey = `${commitUrl}\0${sha256Hex(item.token).slice(0, 16)}`;
  return new Promise((resolve) => {
    let q = modelScopeCommitQueues.get(queueKey);
    if (!q) {
      q = { pending: [], flushing: false, timer: null };
      modelScopeCommitQueues.set(queueKey, q);
    }
    q.pending.push({ ...item, resolve });
    if (q.flushing || q.timer) return;
    q.timer = setTimeout(() => {
      if (q) q.timer = null;
      void flushModelScopeCommitQueue(queueKey, commitUrl);
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
  ssrfOpts: SafeStorageUrlOptions = {},
): Promise<CompleteStorageResult> {
  const fetchOpts: SafeStorageFetchOptions = { ...ssrfOpts, fetchFn };

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

    try {
      await assertSafeStorageUrl(commitUrl, ssrfOpts);
    } catch (e: any) {
      if (e instanceof StorageSsrfError) {
        return { ok: false, status: 400, error: e.code, message: e.message };
      }
      return { ok: false, status: 502, error: "storage_commit_error", message: `ModelScope 提交失败：${e?.message || e}` };
    }

    return enqueueModelScopeCommit(commitUrl, {
      fileId: params.fileId,
      size: params.size,
      objectKey: params.storage.object_key,
      sha256: params.storage.sha256,
      token,
      fetchOpts,
    });
  }

  // Aliyun OSS / AWS S3: verify object exists via presigned HEAD (ensures client actually uploaded bytes).
  // If an accelerate endpoint fails (edge glitch or client fell back to regional PUT), retry HEAD against the regional endpoint.
  const ak = cfg.secrets.access_key_id || "";
  const sk = cfg.secrets.access_key_secret || "";
  if (!ak || !sk) {
    return { ok: false, status: 503, error: "storage_credential_missing", message: "对象存储 AccessKey 未配置" };
  }
  const effectiveEp = params.storage.endpoint || cfg.endpoint;
  const headEndpoints = isObjectStorageAccelerateEndpoint(params.storage.provider, effectiveEp)
    ? [effectiveEp, ""]
    : [effectiveEp];

  let lastFailure: CompleteStorageResult = {
    ok: false,
    status: 502,
    error: "storage_verify_error",
    message: "对象存储校验失败",
  };

  for (let i = 0; i < headEndpoints.length; i++) {
    const headUrl = signObjectStoragePresignedUrl({
      provider: params.storage.provider,
      method: "HEAD",
      bucket: params.storage.bucket || cfg.bucket,
      region: params.storage.region || cfg.region,
      endpoint: headEndpoints[i],
      objectKey: params.storage.object_key,
      accessKeyId: ak,
      accessKeySecret: sk,
      sessionToken: cfg.secrets.session_token,
      expiresSeconds: 120,
    });

    try {
      const res = await safeStorageFetch(headUrl, { method: "HEAD", signal: AbortSignal.timeout(15_000) }, fetchOpts);
      if (!res.ok) {
        lastFailure = {
          ok: false,
          status: res.status === 404 ? 400 : 502,
          error: res.status === 404 ? "storage_object_missing" : "storage_verify_failed",
          message: res.status === 404 ? "文件尚未上传到对象存储" : `对象存储校验失败（HTTP ${res.status}）`,
        };
        if (i + 1 < headEndpoints.length) continue;
        return lastFailure;
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
      if (e instanceof StorageSsrfError) {
        return { ok: false, status: 400, error: e.code, message: e.message };
      }
      lastFailure = { ok: false, status: 502, error: "storage_verify_error", message: `对象存储校验失败：${e?.message || e}` };
      if (i + 1 < headEndpoints.length) continue;
      return lastFailure;
    }
  }
  return lastFailure;
}

/** Resolve authenticated/presigned direct download URL for an authorized download request (never unauthenticated public_base_url). */
export function resolveStorageDownload(
  networkId: string | undefined,
  storage: RemoteStorageIndexMeta,
  routeOpts: StorageRouteOptions = {},
): ResolveDownloadResult {
  if (!networkId) {
    return { ok: false, status: 503, error: "storage_network_missing", message: "远程文件缺少网络归属" };
  }
  // Allow downloading historical files even if the admin later toggled `enabled=false` or switched between
  // Hub-managed default storage and a custom network bucket.
  const loaded = readActiveNetworkStorageConfig(networkId, { requireEnabled: false });
  const hubDefault = readHubManagedStorageConfig();
  let cfg: ActiveStorageRuntimeConfig | null = loaded.ok ? loaded.config : null;
  if ((!cfg || !runtimeMatchesStorageMeta(cfg, storage)) && hubDefault && runtimeMatchesStorageMeta(hubDefault.config, storage)) {
    cfg = { ...hubDefault.config, network_id: networkId };
  }
  if (!cfg) {
    if (!loaded.ok) return loaded;
    return { ok: false, status: 503, error: "storage_not_configured", message: "当前网络存储配置已清除，无法读取远程文件" };
  }

  if (storage.provider === "modelscope") {
    const token = cfg.secrets.token || "";
    if (!token) {
      return { ok: false, status: 503, error: "storage_credential_missing", message: "ModelScope Token 未配置" };
    }
    const ep = (storage.endpoint || modelScopeEndpoint(cfg)).replace(/\/+$/, "");
    const epCheck = validateStorageUrl(ep, "invalid_endpoint");
    if (!epCheck.ok || !epCheck.url) {
      return { ok: false, status: 400, error: "storage_ssrf_blocked", message: epCheck.ok ? "无效的存储地址" : epCheck.message };
    }
    const repoType: ModelScopeRepoType = storage.repo_type === "model" ? "model" : "dataset";
    const repoId = storage.repo_id || cfg.repo_id;
    const revision = storage.revision || cfg.revision || DEFAULT_MODELSCOPE_REVISION;
    const seg = modelScopeRepoSegment(repoType);
    const url = `${epCheck.url}/api/v1/${seg}/${repoId}/repo?Revision=${encodeURIComponent(revision)}&FilePath=${encodeURIComponent(storage.object_key)}`;
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
  const ep = storage.endpoint || cfg.endpoint;
  if (ep) {
    const epCheck = validateStorageUrl(ep, "invalid_endpoint");
    if (!epCheck.ok) {
      return { ok: false, status: 400, error: "storage_ssrf_blocked", message: epCheck.message };
    }
  }
  const accelConfigured = isObjectStorageAccelerateEndpoint(storage.provider, ep);
  const preferRegional = accelConfigured && shouldPreferRegionalOverAccelerate(storage.provider, ep, routeOpts);
  const primaryEndpoint = preferRegional ? "" : ep;
  const fallbackEndpoint = preferRegional ? ep : "";
  const effectiveRoute: StorageEffectiveRoute | undefined = accelConfigured
    ? (preferRegional ? "regional" : "accelerate")
    : undefined;

  const signedGetUrl = signObjectStoragePresignedUrl({
    provider: storage.provider,
    method: "GET",
    bucket: storage.bucket || cfg.bucket,
    region: storage.region || cfg.region,
    endpoint: primaryEndpoint,
    objectKey: storage.object_key,
    accessKeyId: ak,
    accessKeySecret: sk,
    sessionToken: cfg.secrets.session_token,
    expiresSeconds: PRESIGN_TTL_SECONDS,
  });
  const fallbackUrl = accelConfigured
    ? signObjectStoragePresignedUrl({
        provider: storage.provider,
        method: "GET",
        bucket: storage.bucket || cfg.bucket,
        region: storage.region || cfg.region,
        endpoint: fallbackEndpoint,
        objectKey: storage.object_key,
        accessKeyId: ak,
        accessKeySecret: sk,
        sessionToken: cfg.secrets.session_token,
        expiresSeconds: PRESIGN_TTL_SECONDS,
      })
    : undefined;
  return {
    ok: true,
    provider: storage.provider,
    url: signedGetUrl,
    ...(fallbackUrl ? { fallback_url: fallbackUrl } : {}),
    ...(effectiveRoute ? { route: effectiveRoute } : {}),
    headers: {},
    expires_in: PRESIGN_TTL_SECONDS,
  };
}
