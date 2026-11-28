/**
 * Direct external storage relay client for agent-node (ModelScope / Aliyun OSS / AWS S3).
 *
 * Upload flow (0 file bytes through Hub when storage relay is enabled):
 *   1. Compute SHA-256 of buffer.
 *   2. POST /api/uploads/presign with { name, mime, size, sha256 }.
 *   3. If mode === "direct":
 *        - PUT bytes directly to presigned URL (unless skip_upload=true LFS dedup).
 *        - POST /api/uploads/complete with { file_id }.
 *   4. Else (mode === "hub" or older Hub 404/405):
 *        - Fall back transparently to multipart POST /api/upload.
 *
 * Download flow (0 file bytes through Hub for remotely stored files):
 *   1. GET /api/files/:id/direct with Bearer auth.
 *   2. If JSON response has mode === "direct", stream directly from external URL + headers.
 *   3. Otherwise fall back transparently to GET /api/files/:id.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const FILE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const HUB_LOCAL_UPLOAD_CAP = 12 * 1024 * 1024;
const REMOTE_MAX_UPLOAD_CEILING = 500 * 1024 * 1024;
const LIMIT_CACHE_TTL_MS = 60_000;

const uploadLimitCache = new Map<string, { maxBytes: number; expiresAt: number }>();
let cachedCallerCloud: "aws" | "" | undefined;

export function _clearDirectStorageCacheForTest(): void {
  uploadLimitCache.clear();
  cachedCallerCloud = undefined;
}

/**
 * Detect whether this agent-node runs on AWS EC2/Lambda (sync, 0ms, zero network calls).
 * Used as a routing hint so AWS nodes hit regional S3 directly (~3ms, $0 Transfer Acceleration surcharge)
 * while domestic China App clients continue using S3 Transfer Acceleration.
 */
export function detectCallerCloud(): "aws" | undefined {
  const override = (process.env.ANET_CALLER_CLOUD || "").trim().toLowerCase();
  if (override === "aws" || override === "ec2") return "aws";
  if (override) return undefined;
  if (cachedCallerCloud !== undefined) return cachedCallerCloud || undefined;

  let detected: "aws" | "" = "";
  if (process.env.AWS_EXECUTION_ENV) {
    detected = "aws";
  } else if (process.platform === "linux") {
    for (const p of ["/sys/devices/virtual/dmi/id/sys_vendor", "/sys/devices/virtual/dmi/id/board_vendor"]) {
      try {
        const text = readFileSync(p, "utf-8");
        if (/amazon\s+ec2/i.test(text)) {
          detected = "aws";
          break;
        }
      } catch {
        /* non-EC2 or unreadable sysfs */
      }
    }
  }
  cachedCallerCloud = detected;
  return detected || undefined;
}

function callerCloudHeaders(): Record<string, string> {
  const cloud = detectCallerCloud();
  return cloud ? { "X-ANet-Caller-Cloud": cloud } : {};
}

export interface DirectUploadRelayResultOk {
  ok: true;
  file_id: string;
  name: string;
  mime: string;
  size: number;
  url: string;
  storage_provider?: string;
}

export interface DirectUploadRelayResultFail {
  ok: false;
  error: "upload_failed" | "bad_response" | "missing_file_id";
  message: string;
}

export type DirectUploadRelayResult = DirectUploadRelayResultOk | DirectUploadRelayResultFail;

function cleanStringHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/** Probe Hub /api/storage/config to determine effective single-file upload limit (cached 60s). */
export async function probeHubStorageUploadLimit(opts: {
  hubUrl: string;
  authToken: string;
  fetch?: typeof fetch;
}): Promise<number> {
  const hubBase = opts.hubUrl.replace(/\/+$/, "");
  if (!hubBase || !opts.authToken) return HUB_LOCAL_UPLOAD_CAP;
  const cacheKey = `${hubBase}|${opts.authToken.slice(0, 16)}`;
  const now = Date.now();
  const cached = uploadLimitCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.maxBytes;

  const fetchFn = opts.fetch ?? fetch;
  let maxBytes = HUB_LOCAL_UPLOAD_CAP;
  try {
    const res = await fetchFn(`${hubBase}/api/storage/config`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${opts.authToken}`,
        ...callerCloudHeaders(),
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) {
      const ct = (res.headers.get("Content-Type") || "").toLowerCase();
      if (ct.includes("application/json")) {
        const body: any = await res.json();
        if (body?.ok && body?.enabled && typeof body.max_file_bytes === "number" && body.max_file_bytes > HUB_LOCAL_UPLOAD_CAP) {
          maxBytes = Math.min(Math.floor(body.max_file_bytes), REMOTE_MAX_UPLOAD_CEILING);
        }
      }
    }
  } catch {
    /* fall back to Hub local cap */
  }
  uploadLimitCache.set(cacheKey, { maxBytes, expiresAt: now + LIMIT_CACHE_TTL_MS });
  return maxBytes;
}

/**
 * Upload raw file bytes via Hub direct storage relay (ModelScope / OSS / S3),
 * falling back transparently to legacy multipart POST /api/upload when unconfigured or on older Hubs.
 */
export async function uploadBufferViaStorageRelay(opts: {
  hubUrl: string;
  authToken: string;
  bytes: Uint8Array;
  name: string;
  mime: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<DirectUploadRelayResult> {
  const hubBase = opts.hubUrl.replace(/\/+$/, "");
  const fetchFn = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const sha256 = createHash("sha256").update(opts.bytes).digest("hex");

  const canFallbackHub = opts.bytes.byteLength <= HUB_LOCAL_UPLOAD_CAP;

  // Step 1: Ask Hub whether direct storage relay is enabled for this network.
  let useDirect = false;
  let presignBody: any = null;
  try {
    const presignRes = await fetchFn(`${hubBase}/api/uploads/presign`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.authToken}`,
        "Content-Type": "application/json",
        ...callerCloudHeaders(),
      },
      body: JSON.stringify({
        name: opts.name,
        mime: opts.mime,
        size: opts.bytes.byteLength,
        sha256,
      }),
      signal: AbortSignal.timeout(25_000),
    });
    if (presignRes.ok) {
      try { presignBody = await presignRes.json(); } catch { presignBody = null; }
      if (presignBody?.ok === true && presignBody?.mode === "direct" && typeof presignBody?.file_id === "string") {
        useDirect = true;
      }
    } else if (
      presignRes.status === 401
      || presignRes.status === 403
      || presignRes.status === 413
      || presignRes.status === 429
      || (!canFallbackHub && presignRes.status !== 404 && presignRes.status !== 405 && presignRes.status !== 501)
    ) {
      let errBody: any = null;
      try { errBody = await presignRes.json(); } catch { /* ignore */ }
      return {
        ok: false,
        error: "upload_failed",
        message: errBody?.message || errBody?.error || `HTTP ${presignRes.status}`,
      };
    }
    // 404/405/501 (older Hub) or <=12 MiB transient 5xx → fall back to legacy POST /api/upload below.
  } catch (e: any) {
    if (!canFallbackHub) {
      return { ok: false, error: "upload_failed", message: `presign request failed: ${e?.message ?? e}` };
    }
    // Network glitch on presign for <=12 MiB → fall back to /api/upload below.
  }

  if (useDirect && presignBody) {
    const fileId = String(presignBody.file_id);
    let directError: DirectUploadRelayResultFail | null = null;
    if (!FILE_ID_RE.test(fileId)) {
      directError = { ok: false, error: "missing_file_id", message: "presign response missing valid file_id" };
    }

    // Step 2: Direct PUT to ModelScope / OSS / S3 (with optional regional fallback_upload retry on accelerate hiccup).
    if (!directError && !presignBody.skip_upload) {
      const candidates: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
      if (typeof presignBody.upload?.url === "string" && presignBody.upload.url) {
        candidates.push({
          url: presignBody.upload.url,
          method: presignBody.upload?.method || "PUT",
          headers: cleanStringHeaders(presignBody.upload?.headers),
        });
      }
      if (typeof presignBody.fallback_upload?.url === "string" && presignBody.fallback_upload.url) {
        candidates.push({
          url: presignBody.fallback_upload.url,
          method: presignBody.fallback_upload?.method || "PUT",
          headers: cleanStringHeaders(presignBody.fallback_upload?.headers),
        });
      }
      if (candidates.length === 0) {
        directError = { ok: false, error: "bad_response", message: "presign response missing upload.url" };
      } else {
        let putSucceeded = false;
        let lastPutErr: DirectUploadRelayResultFail = { ok: false, error: "upload_failed", message: "direct storage PUT failed" };
        for (const cand of candidates) {
          const uploadHeaders = { ...cand.headers };
          if (!uploadHeaders["Content-Length"] && !uploadHeaders["content-length"]) {
            uploadHeaders["Content-Length"] = String(opts.bytes.byteLength);
          }
          let putRes: Response;
          try {
            putRes = await fetchFn(cand.url, {
              method: cand.method,
              headers: uploadHeaders,
              body: opts.bytes as unknown as BodyInit,
              signal: AbortSignal.timeout(timeoutMs),
            });
          } catch (e: any) {
            lastPutErr = { ok: false, error: "upload_failed", message: `direct storage PUT failed: ${e?.message ?? e}` };
            continue;
          }
          if (!putRes.ok) {
            const snippet = await putRes.text().catch(() => "").then((s) => s.slice(0, 200));
            lastPutErr = {
              ok: false,
              error: "upload_failed",
              message: `direct storage PUT HTTP ${putRes.status}${snippet ? `: ${snippet}` : ""}`,
            };
            continue;
          }
          // ModelScope occasionally returns HTTP 200 with JSON { Code: != 200 }.
          const putCt = (putRes.headers.get("Content-Type") || "").toLowerCase();
          let bodyRejected = false;
          if (putCt.includes("application/json")) {
            try {
              const j: any = await putRes.json();
              if (typeof j?.Code === "number" && j.Code !== 200) {
                lastPutErr = { ok: false, error: "upload_failed", message: j?.Message || `storage PUT Code ${j.Code}` };
                bodyRejected = true;
              } else if (j?.Success === false || j?.success === false) {
                lastPutErr = { ok: false, error: "upload_failed", message: j?.Message || "storage PUT rejected" };
                bodyRejected = true;
              }
            } catch { /* empty/non-JSON body is normal on PUT */ }
          }
          if (!bodyRejected) {
            putSucceeded = true;
            break;
          }
        }
        if (!putSucceeded) directError = lastPutErr;
      }
    }

    // Step 3: Notify Hub to commit pointer / verify object and mark file_id ready.
    if (!directError) {
      let completeRes: Response | null = null;
      try {
        completeRes = await fetchFn(`${hubBase}/api/uploads/complete`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${opts.authToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ file_id: fileId }),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (e: any) {
        directError = { ok: false, error: "upload_failed", message: `upload complete failed: ${e?.message ?? e}` };
      }

      if (!directError && completeRes) {
        let completeBody: any = null;
        try {
          completeBody = await completeRes.json();
        } catch {
          directError = { ok: false, error: "bad_response", message: `hub complete returned non-JSON (HTTP ${completeRes.status})` };
        }
        if (!directError) {
          if (!completeRes.ok || !completeBody?.ok) {
            const errMsg = completeBody?.message || completeBody?.error || `HTTP ${completeRes.status}`;
            // Do not silently fall back on auth/quota rejections.
            if (completeRes.status === 401 || completeRes.status === 403 || completeRes.status === 413) {
              return { ok: false, error: "upload_failed", message: errMsg };
            }
            directError = { ok: false, error: "upload_failed", message: errMsg };
          } else {
            const finalId = String(completeBody.file_id || fileId);
            if (!FILE_ID_RE.test(finalId)) {
              directError = { ok: false, error: "missing_file_id", message: "complete response missing valid file_id" };
            } else {
              return {
                ok: true,
                file_id: finalId,
                name: typeof completeBody.name === "string" && completeBody.name ? completeBody.name : opts.name,
                mime: typeof completeBody.mime === "string" && completeBody.mime ? completeBody.mime.slice(0, 100) : opts.mime,
                size: typeof completeBody.size === "number" ? completeBody.size : opts.bytes.byteLength,
                url: typeof completeBody.url === "string" ? completeBody.url : `/api/files/${finalId}`,
                storage_provider: typeof completeBody.storage_provider === "string" ? completeBody.storage_provider : presignBody.provider,
              };
            }
          }
        }
      }
    }

    // If direct relay failed and the payload fits Hub's 12 MiB cap, degrade cleanly to POST /api/upload below.
    if (directError && !canFallbackHub) {
      return directError;
    }
  }

  // Fallback: legacy multipart POST /api/upload through Hub.
  const form = new FormData();
  form.append("file", new Blob([opts.bytes as BlobPart], { type: opts.mime }), opts.name);

  let res: Response;
  try {
    res = await fetchFn(`${hubBase}/api/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.authToken}`,
        ...callerCloudHeaders(),
      },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e: any) {
    return { ok: false, error: "upload_failed", message: e?.message ?? "network error" };
  }

  let body: any;
  try {
    body = await res.json();
  } catch {
    return {
      ok: false,
      error: "bad_response",
      message: `hub returned non-JSON (HTTP ${res.status})`,
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      error: "upload_failed",
      message: body?.message || body?.error || `HTTP ${res.status}`,
    };
  }
  const fileId = body?.file_id ?? body?.fileId;
  if (typeof fileId !== "string" || !FILE_ID_RE.test(fileId)) {
    return { ok: false, error: "missing_file_id", message: "hub response missing valid file_id" };
  }
  return {
    ok: true,
    file_id: fileId,
    name: typeof body?.name === "string" && body.name ? body.name : opts.name,
    mime: typeof body?.mime === "string" && body.mime ? body.mime.slice(0, 100) : opts.mime,
    size: typeof body?.size === "number" ? body.size : opts.bytes.byteLength,
    url: typeof body?.url === "string" ? body.url : `/api/files/${fileId}`,
  };
}

export type DirectDownloadProbeResult =
  | { kind: "direct"; url: string; fallbackUrl?: string; headers: Record<string, string>; provider?: string }
  | { kind: "hub" }
  | { kind: "auth_failed"; status: number };

/** Probe GET /api/files/:id/direct without consuming non-JSON responses. */
export async function probeDirectDownloadTarget(opts: {
  hubUrl: string;
  authToken: string;
  fileId: string;
  fetch?: typeof fetch;
}): Promise<DirectDownloadProbeResult> {
  const hubBase = opts.hubUrl.replace(/\/+$/, "");
  const fetchFn = opts.fetch ?? fetch;
  try {
    const res = await fetchFn(`${hubBase}/api/files/${encodeURIComponent(opts.fileId)}/direct`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${opts.authToken}`,
        ...callerCloudHeaders(),
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 || res.status === 403) {
      try { await res.body?.cancel?.(); } catch { /* ignore */ }
      return { kind: "auth_failed", status: res.status };
    }
    const ct = (res.headers.get("Content-Type") || "").toLowerCase();
    if (!res.ok || !ct.includes("application/json")) {
      // Do NOT consume body — fallback caller may use a single-response test mock.
      try { await res.body?.cancel?.(); } catch { /* ignore */ }
      return { kind: "hub" };
    }
    const body: any = await res.json();
    if (body?.ok === true && body?.mode === "direct" && typeof body?.url === "string" && body.url) {
      return {
        kind: "direct",
        url: body.url,
        ...(typeof body.fallback_url === "string" && body.fallback_url ? { fallbackUrl: body.fallback_url } : {}),
        headers: cleanStringHeaders(body.headers),
        provider: typeof body.provider === "string" ? body.provider : undefined,
      };
    }
    return { kind: "hub" };
  } catch {
    return { kind: "hub" };
  }
}
