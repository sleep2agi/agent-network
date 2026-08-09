// #221 — commhub-server file upload primitives.
//
// Hub upload surface for the mobile APP (#220). The hub started reverse-
// proxying over HTTPS to the public internet last night, so the upload
// endpoint is a brand-new public attack surface. The six security items
// in the issue are HARD verification items, encoded here:
//
//   1. file_id is server-generated (uuidv4, alphanumeric only), client-
//      supplied filenames never enter the storage path.
//   2. Storage root sits in $HOME/.anet/server/uploads (outside any
//      web-served directory); downloads go through an explicit handler.
//   3. Download handler forces Content-Disposition: attachment +
//      X-Content-Type-Options: nosniff — uploaded files are never
//      executed or served as HTML.
//   4. 12 MB cap enforced two-stage per 通信龙: Content-Length header
//      pre-check (reject before reading body) + post-parse size verify.
//   5. Auth is the existing requireAuth — anonymous + bad tokens 401.
//   6. Naive per-token rate limit: 60 uploads/hour per token (or IP for
//      legacy/dev mode).
//
// This module stays pure-ish: file I/O lives in the HTTP handlers, the
// path / id / rate-limit primitives are unit-testable.

import { homedir } from "os";
import { join, relative, isAbsolute } from "path";

export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

// Allow ~1 MiB of multipart envelope overhead on top of the 12 MiB
// payload limit when checking Content-Length. The post-parse check is
// still done against MAX_UPLOAD_BYTES so the actual binary payload
// never exceeds the documented cap.
export const MAX_REQUEST_CONTENT_LENGTH = MAX_UPLOAD_BYTES + 1024 * 1024;

// Per-token rate-limit constants. 60 uploads/hour matches the issue
// "如 60 req/h" suggestion and is enforced in-memory (one process holds
// the source of truth; resets on restart).
export const UPLOAD_RATE_WINDOW_MS = 60 * 60 * 1000;
export const UPLOAD_RATE_MAX_PER_WINDOW = 60;
// Cap the in-memory rate-limit map so a public-facing hub can't be
// pushed to OOM by a flood of unique IPs / token ids (the call site
// uses IP-as-key for legacy auth, which is rotatable cheaply over IPv6).
// Matches LOGIN_GUARD_MAX_ENTRIES in auth_login_guard.ts for symmetric
// behaviour across the two in-memory limiters this hub maintains.
export const UPLOAD_RATE_MAX_ENTRIES = 50_000;

// Strict file_id regex. Generated server-side via crypto.randomUUID()
// with hyphens stripped, so the natural output is 32 hex chars. The
// regex is intentionally permissive on the upper bound (64 chars) to
// allow future scheme changes (e.g. prefix), but it rejects ANY of `.`
// `/` `\` `..` so the same regex used for path generation can also be
// used to validate a /api/files/:file_id lookup against directory
// traversal.
export const FILE_ID_REGEX = /^[A-Za-z0-9_-]{8,64}$/;

// Stored extension tokens have one invariant at every path boundary:
// either no extension, or a leading dot followed by 1-16 ASCII
// alphanumeric characters. Keep this separate from sanitizeExt(), which
// parses a client filename and therefore deliberately has different
// capture/anchoring semantics.
const EXT_TOKEN_REGEX = /^\.[A-Za-z0-9]{1,16}$/;

function isValidExtToken(ext: unknown): ext is string {
  return typeof ext === "string" && (ext === "" || EXT_TOKEN_REGEX.test(ext));
}

export type GeneratedFile = {
  fileId: string;
  ext: string;
  dateBucket: string;
  relativePath: string;
  absolutePath: string;
};

export function getUploadsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.COMMHUB_UPLOADS_DIR || join(homedir(), ".anet/server/uploads");
}

export function getDateBucket(now: Date = new Date()): string {
  // YYYY-MM-DD partitioning per issue spec — keeps a single directory
  // from accumulating millions of entries while leaving the lookup
  // path predictable from the disk index (file_id → date bucket).
  return now.toISOString().slice(0, 10);
}

export function generateFileId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/**
 * Extract a safe file extension from a client-supplied filename.
 * Server NEVER uses the rest of the filename. Returns "" if no
 * acceptable extension is present.
 *
 * Accepts: alphanumeric extensions of 1–16 chars (`.png`, `.tar`,
 * `.docx`, `.tar.gz` returns only `.gz`). Rejects: anything containing
 * path separators, dots in unusual positions, or non-ASCII characters.
 */
export function sanitizeExt(filename: string | undefined | null): string {
  if (!filename || typeof filename !== "string") return "";
  // Defense: strip any leading directory the client might have shoved
  // into "name", then take only the last extension.
  const base = filename.split(/[\\/]/).pop() ?? "";
  const match = base.match(/\.([A-Za-z0-9]{1,16})$/);
  return match ? "." + match[1].toLowerCase() : "";
}

// YYYY-MM-DD bucket string regex — matches what getDateBucket produces
// and what an index entry's `date_bucket` field is validated against.
const DATE_BUCKET_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate a date_bucket string against BOTH shape (YYYY-MM-DD regex)
 * AND real-calendar semantics: rejects "2026-02-30", "2026-13-01",
 * "2026-00-15", leap-day-on-non-leap-year, etc. Shape-only check is not
 * enough because the regex accepts any digit combination in each
 * position.
 *
 * Used as a pre-check by the download handler before it calls into
 * pathForExistingBlob — a non-calendar bucket is a 404 (invalid input
 * rejected at the boundary), NOT a 500 (uncaught throw from deep in
 * the read path). Distinguishing these matters: 500 says "server
 * failed"; 404 says "we know your request is bad, refused early".
 */
export function isValidCalendarBucket(bucket: unknown): bucket is string {
  if (typeof bucket !== "string") return false;
  if (!DATE_BUCKET_REGEX.test(bucket)) return false;
  // Round-trip via Date to reject non-calendar shapes like "2026-02-30"
  // or "2026-13-01". `Date.UTC` coerces overflow ("2026-02-30" becomes
  // "2026-03-02") — if the ISO round-trip doesn't equal the input, the
  // caller supplied a non-calendar bucket.
  const [yStr, mStr, dStr] = bucket.split("-");
  const y = Number(yStr), m = Number(mStr), d = Number(dStr);
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  const roundtrip = new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
  return roundtrip === bucket;
}

/**
 * Build the storage path for a NEW upload. Computes today's date bucket
 * from the runtime clock (or `opts.now` for tests). Use ONLY for creating
 * a fresh blob; for reading an existing blob whose bucket is already
 * recorded in the index, use pathForExistingBlob() instead.
 *
 * The file_id and ext are validated against strict regexes; any
 * path-separator or `..` segment from a malicious client gets rejected
 * at the regex layer before any I/O.
 */
export function buildStoragePath(fileId: string, ext: string, opts: { uploadsRoot?: string; now?: Date } = {}): GeneratedFile {
  if (!FILE_ID_REGEX.test(fileId)) throw new Error(`file_id "${fileId}" is invalid`);
  if (!isValidExtToken(ext)) throw new Error(`ext "${ext}" is invalid`);
  const dateBucket = getDateBucket(opts.now);
  const root = opts.uploadsRoot ?? getUploadsRoot();
  const relativePath = join(dateBucket, fileId + ext);
  const absolutePath = join(root, relativePath);
  return { fileId, ext, dateBucket, relativePath, absolutePath };
}

/**
 * Build the storage path for an EXISTING blob, using the caller-supplied
 * `dateBucket` (typically read from the index entry). Does NOT compute
 * a date from the runtime clock — that is the write-side concern.
 *
 * This split exists because sharing one date-computing function between
 * write and read semantics caused #509: yesterday's file downloaded
 * today would look under today's bucket → blob_missing → 404, even
 * though the blob was still sitting in yesterday's directory.
 *
 * The file_id, ext and dateBucket are validated against strict regexes
 * before any I/O; a poisoned index bucket (e.g. `../etc`) is rejected
 * here just as file_id path-escape attempts are.
 */
export function pathForExistingBlob(dateBucket: string, fileId: string, ext: string, opts: { uploadsRoot?: string } = {}): GeneratedFile {
  if (!FILE_ID_REGEX.test(fileId)) throw new Error(`file_id "${fileId}" is invalid`);
  if (!isValidExtToken(ext)) throw new Error(`ext "${ext}" is invalid`);
  if (typeof dateBucket !== "string" || !DATE_BUCKET_REGEX.test(dateBucket)) {
    throw new Error(`date_bucket "${dateBucket}" is invalid`);
  }
  const root = opts.uploadsRoot ?? getUploadsRoot();
  const relativePath = join(dateBucket, fileId + ext);
  const absolutePath = join(root, relativePath);
  return { fileId, ext, dateBucket, relativePath, absolutePath };
}

export type UploadIndexEntry = {
  file_id: string;
  date_bucket: string; // YYYY-MM-DD
  ext: string;         // ".png" / ".pdf" / etc., including the leading dot, lowercase
  name: string;        // original filename — stored as metadata only, NEVER used in paths
  mime: string;        // best-effort mime from the multipart Content-Type
  size: number;        // byte length of the binary
  owner?: string;      // upload token id / username, for traceability
  // Written by the upload handler as `authCtx?.userId ?? null`, so `null`
  // is a real on-disk value — the type must say so rather than pretend
  // the field is `string | undefined`.
  owner_id?: string | null;
  // #503 — network the upload is attributed to. The key is OMITTED (not
  // written as null) when there is no attribution, so "absent" and
  // "unattributed" are the same on-disk shape and legacy entries written
  // before #503 are indistinguishable from new unattributed ones.
  network_id?: string;
  uploaded_at: string; // ISO 8601
};

/** Path to the index entry file for a given file_id. Lives in
 * `<uploadsRoot>/.index/<file_id>.json` so /api/files/:file_id can do
 * an O(1) lookup without scanning every date bucket. */
export function indexEntryPath(fileId: string, opts: { uploadsRoot?: string } = {}): string | null {
  if (!FILE_ID_REGEX.test(fileId)) return null;
  const root = opts.uploadsRoot ?? getUploadsRoot();
  return join(root, ".index", fileId + ".json");
}

/** Validate an index entry shape before serving a download. Defends
 * against a malformed/tampered .index file by re-checking the same
 * invariants the upload handler enforces. */
export function validateIndexEntry(entry: unknown): entry is UploadIndexEntry {
  if (!entry || typeof entry !== "object") return false;
  const e: any = entry;
  // #503 — if the network_id key is present it must be a non-empty string.
  // An absent key is valid (legacy entries + unattributed uploads); that
  // keeps this in sync with the writer, which omits the key entirely
  // rather than writing null. owner_id is deliberately NOT constrained
  // here — existing entries legitimately carry owner_id=null.
  if ("network_id" in e && !(typeof e.network_id === "string" && e.network_id.length > 0)) return false;
  return (
    typeof e.file_id === "string" && FILE_ID_REGEX.test(e.file_id) &&
    typeof e.date_bucket === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e.date_bucket) &&
    isValidExtToken(e.ext) &&
    typeof e.size === "number" && e.size >= 0 && e.size <= MAX_UPLOAD_BYTES
  );
}

/**
 * Defence-in-depth: confirm a resolved absolute path falls within
 * the uploads root. The HTTP handler calls this after constructing
 * the download path; if it ever reports `false` we hard-fail the
 * request rather than serve whatever the resolved path points at.
 */
export function isPathInsideUploadsRoot(absPath: string, uploadsRoot?: string): boolean {
  const root = uploadsRoot ?? getUploadsRoot();
  const rel = relative(root, absPath);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

// ── Rate limit (in-memory, per token/IP) ────────────────────────────

type UploadRateState = { count: number; resetAt: number };

export class UploadRateLimiter {
  private state = new Map<string, UploadRateState>();

  constructor(
    private readonly windowMs: number = UPLOAD_RATE_WINDOW_MS,
    private readonly maxPerWindow: number = UPLOAD_RATE_MAX_PER_WINDOW,
    private readonly maxEntries: number = UPLOAD_RATE_MAX_ENTRIES,
  ) {}

  /**
   * Attempt to consume one upload quota slot for `key` (typically the
   * caller's token id, falling back to IP for legacy auth). Returns
   * `{ allowed: true }` when the upload may proceed and
   * `{ allowed: false, retryAfterMs }` when the caller is rate-limited.
   * Window is rolling on first touch (not aligned to wall-clock hours).
   */
  check(key: string, nowMs: number = Date.now()): { allowed: boolean; remaining: number; resetAt: number; retryAfterMs?: number } {
    // Before inserting a brand-new key into a full map, sweep expired
    // entries and (if still over cap) evict the oldest by insertion order.
    // Existing-key updates skip the eviction path so an attacker who
    // keeps hitting the same key can't push out other callers.
    if (this.state.size >= this.maxEntries && !this.state.has(key)) {
      this.pruneExpired(nowMs);
      this.evictOldestUntilBelowCap();
    }
    const entry = this.state.get(key);
    if (!entry || nowMs >= entry.resetAt) {
      const resetAt = nowMs + this.windowMs;
      this.state.set(key, { count: 1, resetAt });
      return { allowed: true, remaining: this.maxPerWindow - 1, resetAt };
    }
    if (entry.count >= this.maxPerWindow) {
      return { allowed: false, remaining: 0, resetAt: entry.resetAt, retryAfterMs: entry.resetAt - nowMs };
    }
    entry.count++;
    return { allowed: true, remaining: this.maxPerWindow - entry.count, resetAt: entry.resetAt };
  }

  /** Visible for tests — clear all rate-limit state. */
  reset(): void {
    this.state.clear();
  }

  /** Visible for tests — current bucket count. */
  size(): number {
    return this.state.size;
  }

  private pruneExpired(nowMs: number): void {
    for (const [key, entry] of this.state) {
      if (nowMs >= entry.resetAt) this.state.delete(key);
    }
  }

  private evictOldestUntilBelowCap(): void {
    while (this.state.size >= this.maxEntries) {
      const oldest = this.state.keys().next().value as string | undefined;
      if (!oldest) return;
      this.state.delete(oldest);
    }
  }
}

/** Module-level singleton shared by the HTTP /api/upload handler. */
export const sharedUploadRateLimiter = new UploadRateLimiter();

// ── Attachment schema (shared between REST /api/task and MCP send_task) ───

/**
 * Canonical shape for the `attachments` field on tasks. Both the REST
 * /api/task body and the MCP send_task tool accept this same array;
 * server persistence routes through `tasks.meta_json` so the storage
 * layout is identical regardless of transport.
 */
export type TaskAttachment = {
  type: "file";
  file_id: string;
  name?: string;
  mime?: string;
  size?: number;
};

/**
 * #222 cross-host attachment safety — strip `path` from meta.attachments
 * entries that ALSO carry a `file_id`. Reason: the hub's /api/upload
 * returns `{file_id, path}` where `path` is a hub-machine-local
 * absolute path. Senders sometimes echo `path` back into meta.attachments.
 * When the receiving agent runs on a different host (Vincent 2026-06-30
 * toodadev2 case), that path string is meaningless. agent-node's
 * fetch-attachment.ts will fetch via `file_id` regardless, but leaving
 * the stale `path` in the JSON misleads any tooling that reads it.
 *
 * CRITICAL — conditional, not unconditional (通信龙 PR #222 pre-review
 * nit): feishu-bridge currently writes `/work/feishu-attachments/<conn>/
 * <chat>/` directly and ships path-only attachments (NO file_id). If we
 * strip path unconditionally those break too. Only strip when file_id
 * is present (the "safe to drop" signal). Single-host feishu fallback
 * preserved.
 *
 * Shared by tools.ts (MCP send_task) and index.ts (REST /api/task) so
 * both transports apply the same sanitization to meta.
 */
export function stripHostLocalPathsForCrossHostSafe(meta: any): any {
  if (!meta || typeof meta !== "object") return meta;
  if (!Array.isArray((meta as any).attachments)) return meta;
  let mutated = false;
  const sanitized = (meta as any).attachments.map((a: any) => {
    if (a && typeof a === "object" && typeof a.file_id === "string" && a.file_id && typeof a.path === "string") {
      mutated = true;
      const { path: _stripped, ...rest } = a;
      return rest;
    }
    return a;
  });
  if (!mutated) return meta;
  return { ...meta, attachments: sanitized };
}

/** Light validator usable from the REST handler. Returns null on success or an error message string. */
export function validateAttachments(input: unknown): { ok: true; attachments: TaskAttachment[] } | { ok: false; error: string } {
  if (input === undefined || input === null) return { ok: true, attachments: [] };
  if (!Array.isArray(input)) return { ok: false, error: "attachments must be an array" };
  if (input.length > 20) return { ok: false, error: "too many attachments (max 20)" };
  const out: TaskAttachment[] = [];
  for (let i = 0; i < input.length; i++) {
    const a: any = input[i];
    if (!a || typeof a !== "object") return { ok: false, error: `attachments[${i}] is not an object` };
    if (a.type !== "file") return { ok: false, error: `attachments[${i}].type must be "file"` };
    if (typeof a.file_id !== "string" || !FILE_ID_REGEX.test(a.file_id)) {
      return { ok: false, error: `attachments[${i}].file_id is invalid` };
    }
    if (a.name !== undefined && (typeof a.name !== "string" || a.name.length > 255)) {
      return { ok: false, error: `attachments[${i}].name must be a string ≤ 255 chars` };
    }
    if (a.mime !== undefined && (typeof a.mime !== "string" || a.mime.length > 100)) {
      return { ok: false, error: `attachments[${i}].mime must be a string ≤ 100 chars` };
    }
    if (a.size !== undefined && (typeof a.size !== "number" || a.size < 0 || a.size > MAX_UPLOAD_BYTES)) {
      return { ok: false, error: `attachments[${i}].size must be a non-negative number ≤ ${MAX_UPLOAD_BYTES}` };
    }
    out.push({ type: "file", file_id: a.file_id, name: a.name, mime: a.mime, size: a.size });
  }
  return { ok: true, attachments: out };
}
