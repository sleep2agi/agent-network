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

/**
 * Build the per-upload storage path. The file_id and ext are validated
 * against strict regexes; any path-separator or `..` segment from a
 * malicious client gets rejected at the regex layer before any I/O.
 */
export function buildStoragePath(fileId: string, ext: string, opts: { uploadsRoot?: string; now?: Date } = {}): GeneratedFile {
  if (!FILE_ID_REGEX.test(fileId)) throw new Error(`file_id "${fileId}" is invalid`);
  if (ext && !/^\.[A-Za-z0-9]{1,16}$/.test(ext)) throw new Error(`ext "${ext}" is invalid`);
  const dateBucket = getDateBucket(opts.now);
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
  return (
    typeof e.file_id === "string" && FILE_ID_REGEX.test(e.file_id) &&
    typeof e.date_bucket === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e.date_bucket) &&
    typeof e.ext === "string" && (e.ext === "" || /^\.[A-Za-z0-9]{1,16}$/.test(e.ext)) &&
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
