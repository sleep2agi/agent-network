/**
 * RFC-020 §17 — feishu inbound bridge → hub `/api/upload` integration.
 *
 * Vincent 2026-06-30: cross-machine agents (e.g. TM门户运维@toodadev2)
 * delegated by the feishu-local bot can't read inbound attachments
 * because the only thing they get is a host-local path that doesn't
 * exist on the receiver's filesystem. #351 already wired agent-node's
 * receiver to prefer `file_id` and pull via `GET /api/files/<id>` when
 * present. This module is the SENDER half: the feishu bridge uploads
 * each downloaded inbound file to the hub via `POST /api/upload`,
 * gets back a `file_id`, and propagates it alongside the local path.
 *
 * Failure mode (load-bearing): every failure path returns `null` and
 * the caller falls back to path-only. The bridge MUST NOT crash because
 * the hub is down / overloaded / refused a 12 MiB cap. Single-host
 * `agent-node` Read still works on the local path; only cross-host
 * delegation degrades, no regression vs the pre-fix baseline.
 *
 * Concurrency cap: a single feishu message can carry many images; bursts
 * to /api/upload would hammer the hub rate limit (60/hour per token).
 * `uploadFilesToHubConcurrent` caps in-flight requests at `concurrency`
 * (default 4) so a 20-image message takes 5 sequential rounds instead
 * of 20 simultaneous open sockets + a likely rate-limit denial.
 */

import { readFileSync, statSync, existsSync } from "node:fs";
import { basename } from "node:path";

/**
 * Hub upload limit, mirrors `server/src/uploads.ts:MAX_UPLOAD_BYTES`.
 * Anything bigger is skipped at the bridge — the hub would 413 anyway.
 */
export const HUB_UPLOAD_LIMIT_BYTES = 12 * 1024 * 1024;

/** Default in-flight cap for `uploadFilesToHubConcurrent`. */
export const DEFAULT_UPLOAD_CONCURRENCY = 4;

/**
 * One file uploaded to the hub. `mime` and `size` are from the local
 * filesystem read; `file_id` and `path` come from the hub's response.
 *
 * `file_id` is the canonical cross-machine handle — receiving agent
 * resolves to bytes via `GET /api/files/<file_id>`. `path` is the
 * hub-machine-local absolute path the hub stored to; on the sender
 * side it's purely informational (we already have the source file).
 */
export interface HubUploadResult {
  file_id: string;
  path?: string;
  mime?: string;
  size?: number;
  name?: string;
}

export interface HubUploadOpts {
  /** Hub base URL, no trailing slash. Defaults to env. */
  hubUrl: string;
  /** Bearer token (ntok_ / utok_ / atok_). Defaults to env. */
  authToken: string;
  /** Optional MIME hint; sniffed by filename ext otherwise. */
  mime?: string;
  /** Optional override filename (defaults to basename(path)). */
  name?: string;
  /** Injectable for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
}

/**
 * Sniff the MIME type from a filename's extension. Defensive default
 * `application/octet-stream` for anything unknown — hub uploads accept
 * any mime; the receiving agent's resolver re-classifies.
 */
function sniffMimeFromExt(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    pdf: "application/pdf",
    txt: "text/plain",
    json: "application/json",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };
  return map[ext] ?? "application/octet-stream";
}

/**
 * Upload one local file to `${hubUrl}/api/upload`. Returns the file
 * descriptor on success, or `null` on any failure (caller falls back
 * to path-only).
 *
 *  - File must exist + be ≤ 12 MiB. Larger → skipped silently with
 *    a stderr warn; caller gets `null` and ships path-only.
 *  - Auth via `Authorization: Bearer <token>`.
 *  - `Content-Length` header is set by `fetch` when given a Blob body;
 *    the hub validates it before consuming bytes.
 *  - Multipart body with a single `file` field. The hub server
 *    reads `form.get("file")` and stores under a new file_id.
 *  - Any network error / non-2xx / malformed JSON response → null.
 */
export async function uploadToHub(
  filePath: string,
  opts: HubUploadOpts,
): Promise<HubUploadResult | null> {
  // 1. Local filesystem checks — guard against missing/oversize files
  //    before we waste a round-trip + a hub rate-limit slot.
  if (!filePath || typeof filePath !== "string") return null;
  if (!existsSync(filePath)) {
    process.stderr.write(
      `[hub-upload] ${filePath} skip: file does not exist\n`,
    );
    return null;
  }
  let size = 0;
  try {
    size = statSync(filePath).size;
  } catch (e: any) {
    process.stderr.write(
      `[hub-upload] ${filePath} skip: stat failed: ${e?.message ?? e}\n`,
    );
    return null;
  }
  if (size <= 0) {
    process.stderr.write(`[hub-upload] ${filePath} skip: empty file\n`);
    return null;
  }
  if (size > HUB_UPLOAD_LIMIT_BYTES) {
    process.stderr.write(
      `[hub-upload] ${filePath} skip: ${size} > 12 MiB cap; sending path-only\n`,
    );
    return null;
  }

  // 2. Build multipart body. `fetch`'s native FormData → Blob path sets
  //    Content-Type + Content-Length correctly; the hub validates both.
  let buf: Buffer;
  try {
    buf = readFileSync(filePath);
  } catch (e: any) {
    process.stderr.write(
      `[hub-upload] ${filePath} skip: readFileSync failed: ${e?.message ?? e}\n`,
    );
    return null;
  }
  const name = opts.name ?? basename(filePath);
  const mime = opts.mime ?? sniffMimeFromExt(name);
  const form = new FormData();
  // Buffer is a Uint8Array subclass; the cast satisfies TS's stricter
  // Blob constructor signature (which requires ArrayBuffer-not-Shared).
  const blob = new Blob([new Uint8Array(buf)], { type: mime });
  form.append("file", blob, name);

  // 3. POST to hub. Catches: fetch throws (DNS/network), non-2xx,
  //    malformed JSON, missing file_id in response. All return null.
  const url = `${opts.hubUrl.replace(/\/+$/, "")}/api/upload`;
  const fetchFn = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${opts.authToken}` },
      body: form,
    });
  } catch (e: any) {
    process.stderr.write(
      `[hub-upload] ${filePath} POST threw: ${e?.message ?? e} (path-only fallback)\n`,
    );
    return null;
  }
  if (!res.ok) {
    let bodyHint = "";
    try {
      const t = await res.text();
      bodyHint = t.slice(0, 200).replace(/\n/g, " ");
    } catch {}
    process.stderr.write(
      `[hub-upload] ${filePath} POST returned HTTP ${res.status}: ${bodyHint} (path-only fallback)\n`,
    );
    return null;
  }
  let body: any;
  try {
    body = await res.json();
  } catch (e: any) {
    process.stderr.write(
      `[hub-upload] ${filePath} response not JSON: ${e?.message ?? e}\n`,
    );
    return null;
  }
  const fileId = body?.file_id ?? body?.fileId;
  if (typeof fileId !== "string" || fileId.length < 4) {
    process.stderr.write(
      `[hub-upload] ${filePath} response missing file_id: ${JSON.stringify(body).slice(0, 200)}\n`,
    );
    return null;
  }
  return {
    file_id: fileId,
    path: typeof body?.path === "string" ? body.path : undefined,
    mime,
    size,
    name,
  };
}

/**
 * Upload many files to the hub with a bounded concurrency window.
 * Returns one result per input path, preserving order. A failed
 * upload appears as `null` at that slot — caller composes path-only
 * descriptors for those.
 *
 * Why this matters: one feishu post can carry an arbitrary number of
 * images. Naive `Promise.all(paths.map(uploadToHub))` would open N
 * simultaneous HTTPS sockets to the hub AND blow past the 60/hour
 * per-token rate limit on a single message with >60 images. A
 * concurrency cap of 4 means N/4 sequential rounds, predictable
 * load, no head-of-line blocking on the agent's reply.
 */
export async function uploadFilesToHubConcurrent(
  filePaths: string[],
  opts: HubUploadOpts,
  concurrency: number = DEFAULT_UPLOAD_CONCURRENCY,
): Promise<(HubUploadResult | null)[]> {
  if (filePaths.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, 16));
  const results: (HubUploadResult | null)[] = new Array(filePaths.length).fill(null);
  let cursor = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < limit; w++) {
    workers.push(
      (async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= filePaths.length) return;
          const result = await uploadToHub(filePaths[idx], opts);
          results[idx] = result;
        }
      })(),
    );
  }
  await Promise.all(workers);
  return results;
}
