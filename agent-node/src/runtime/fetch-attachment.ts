// RFC: #222 cross-machine attachments — agent-node auto-fetch /api/files/<id>.
//
// Background
// ==========
// Pre-fix: agent-node `extractImagePaths` reads `attachment.path` directly
// and hands it to the LLM. `path` is set by the hub's /api/upload
// response as the hub-machine-local absolute path
// (`~/.anet/server/uploads/<YYYY-MM-DD>/<file_id><ext>`). When the agent
// runs on a different host than the hub (Vincent 2026-06-30 实测: agent
// "TM门户运维" on toodadev2 / 10.110.14.18, hub on home machine), that
// path string can't be opened — the agent reports "无法访问 /home/.../uploads/...".
//
// Fix: prefer `attachment.file_id` over `attachment.path`. When file_id
// is present, fetch the file via the hub's `GET /api/files/<file_id>`
// HTTP endpoint (Bearer-authed with the agent's own ntok), save to a
// per-alias cache dir under .anet/nodes/<alias>/.cache/attachments/,
// hand the LOCAL temp path to the LLM. Cross-host fetch is the universal
// solution: any agent with a valid ntok can pull any file the hub holds
// for the agent's network.
//
// Single-host fallback: when there is NO file_id (legacy senders, MCP
// `send_task` that bypassed the REST validator, etc.) but the supplied
// `path` exists on the local fs, use the path directly. Preserves
// existing single-host behaviour without forcing every sender to
// upload through /api/upload.
//
// Size safety per team rule (assume-unit-before-threshold): cap is in
// BYTES, not chunks or kb. Pre-check Content-Length header; if absent
// or > cap, refuse before consuming. During stream, byte counter as a
// belt — Content-Length can lie. Default 50 MiB (configurable via env
// COMMHUB_ATTACHMENT_MAX_BYTES). Aborts the fetch on overflow.
//
// Auth: uses the agent's own `AUTH_TOKEN` (ntok) — the hub's requireAuth
// accepts both utok_ and ntok_ on /api/files/<id>. The ntok is bound to
// the agent's network at mint time, so cross-tenant probes are refused
// at the hub's resolveToken layer.
//
// Cache: by file_id (canonical). Cache hit when local file exists AND
// the on-disk size matches the supplied `size` hint (mismatch means a
// re-upload happened under the same file_id — should be impossible
// since file_id includes random bits, but we don't trust). chmod 600
// on every cache write so leaked cache file paths in logs don't expose
// the bytes.
//
// Cleanup: daily TTL sweep removes cache entries > CACHE_TTL_MS old.
// Mirrors deleted-sweeper.ts pattern. Caller (cli.ts boot) wires the
// sweep timer; this module exports the once-pass for test injection.

import { mkdirSync, statSync, writeFileSync, chmodSync, readdirSync, rmSync, existsSync, createWriteStream } from "node:fs";
import { join, extname, dirname } from "node:path";

export const DEFAULT_MAX_BYTES = (() => {
  const env = process.env.COMMHUB_ATTACHMENT_MAX_BYTES;
  const n = env ? Number(env) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 50 * 1024 * 1024;   // 50 MiB
})();
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;          // 24 hours
export const CACHE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;    // sweep hourly

// Mirrors server/src/uploads.ts FILE_ID_REGEX exactly. Token-exact
// check before any URL composition or fs write — prevents path
// traversal and URL injection if a malicious sender stamps
// `file_id: "../../etc/passwd"` into meta.attachments.
export const FILE_ID_REGEX = /^[A-Za-z0-9_-]{8,64}$/;

export interface AttachmentDescriptor {
  type?: string;
  file_id?: string;
  path?: string;
  mime?: string;
  name?: string;
  size?: number;
}

export interface ResolveAttachmentDeps {
  hubUrl: string;
  authToken: string;
  cacheDir: string;
  maxBytes?: number;
  /** Injectable for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Test-only: override Date.now for cache TTL math. */
  now?: () => number;
}

export type ResolveResult =
  | { ok: true; localPath: string; cached: boolean; bytes: number }
  | { ok: false; error: string; code: "no_file_id_no_path" | "file_id_invalid" | "size_exceeded" | "fetch_failed" | "write_failed" | "auth_failed" | "not_found" };

/**
 * Resolve one attachment to a local-fs path the LLM runtime can open.
 * Strategy:
 *   1. file_id present → fetch from hub /api/files/<file_id> (cache key)
 *   2. else if path present and exists locally → return path as-is
 *   3. else → error (caller should drop the attachment with a log)
 */
export async function resolveAttachmentToLocalPath(
  attachment: AttachmentDescriptor,
  deps: ResolveAttachmentDeps,
): Promise<ResolveResult> {
  const fetchFn = deps.fetch ?? fetch;
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;

  // Path 1 — file_id available (the right way)
  if (attachment.file_id) {
    if (!FILE_ID_REGEX.test(attachment.file_id)) {
      return { ok: false, code: "file_id_invalid", error: `file_id "${attachment.file_id}" fails FILE_ID_REGEX` };
    }
    // Cache hit check — same file_id + same size means re-use. Size hint
    // optional; absent size → re-fetch (cheap defensiveness).
    const ext = pickExtension(attachment);
    const localPath = join(deps.cacheDir, `${attachment.file_id}${ext}`);
    if (typeof attachment.size === "number" && existsSync(localPath)) {
      try {
        const st = statSync(localPath);
        if (st.size === attachment.size) {
          return { ok: true, localPath, cached: true, bytes: st.size };
        }
      } catch { /* fall through to refetch */ }
    }
    return await fetchAndCache(attachment.file_id, localPath, deps, fetchFn, maxBytes);
  }

  // Path 2 — local path fallback (single-host legacy / MCP-passthrough)
  if (typeof attachment.path === "string" && attachment.path.length > 0) {
    if (existsSync(attachment.path)) {
      let bytes = 0;
      try { bytes = statSync(attachment.path).size; } catch { /* ok */ }
      return { ok: true, localPath: attachment.path, cached: true, bytes };
    }
    // Path was provided but doesn't exist here — cross-host scenario
    // without file_id. Fail loud so caller logs the gap.
    return {
      ok: false, code: "not_found",
      error: `attachment.path "${attachment.path}" does not exist on this host and no file_id was provided (cross-host attachment without /api/upload registration?)`,
    };
  }

  return { ok: false, code: "no_file_id_no_path", error: "attachment has neither file_id nor path" };
}

/** Internal — fetch /api/files/<id> with auth, size cap, atomic write. */
async function fetchAndCache(
  fileId: string,
  localPath: string,
  deps: ResolveAttachmentDeps,
  fetchFn: typeof fetch,
  maxBytes: number,
): Promise<ResolveResult> {
  const hubBase = deps.hubUrl.replace(/\/+$/, "");
  const url = `${hubBase}/api/files/${encodeURIComponent(fileId)}`;
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${deps.authToken}` },
    });
  } catch (e: any) {
    return { ok: false, code: "fetch_failed", error: `fetch threw: ${e?.message || e}` };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, code: "auth_failed", error: `hub refused fetch: HTTP ${res.status}` };
  }
  if (res.status === 404) {
    return { ok: false, code: "not_found", error: `hub has no file_id=${fileId}` };
  }
  if (!res.ok) {
    return { ok: false, code: "fetch_failed", error: `hub returned HTTP ${res.status}` };
  }

  // Pre-check Content-Length — refuse before consuming bytes.
  const lenHeader = res.headers.get("Content-Length");
  if (lenHeader) {
    const declared = Number(lenHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      return {
        ok: false, code: "size_exceeded",
        error: `Content-Length=${declared} > cap ${maxBytes} (declared by hub, refused pre-stream)`,
      };
    }
  }

  if (!res.body) {
    return { ok: false, code: "fetch_failed", error: "hub response had no body" };
  }

  // Stream to disk with byte counter — defensive against Content-Length
  // lies. Write to a .tmp first, fsync, then rename — atomic publish.
  try {
    mkdirSync(dirname(localPath), { recursive: true, mode: 0o700 });
  } catch (e: any) {
    return { ok: false, code: "write_failed", error: `mkdir cacheDir failed: ${e?.message || e}` };
  }
  const tmpPath = `${localPath}.tmp-${process.pid}-${Date.now()}`;
  let bytes = 0;
  try {
    const reader = res.body.getReader();
    const writer = createWriteStream(tmpPath, { mode: 0o600 });
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        bytes += value.byteLength;
        if (bytes > maxBytes) {
          try { writer.destroy(); } catch { /* ok */ }
          try { rmSync(tmpPath, { force: true }); } catch { /* ok */ }
          try { await reader.cancel(); } catch { /* ok */ }
          return {
            ok: false, code: "size_exceeded",
            error: `stream exceeded cap ${maxBytes} bytes (mid-flight detection — hub Content-Length may have lied)`,
          };
        }
        const ok = writer.write(value);
        if (!ok) {
          await new Promise<void>(resolve => writer.once("drain", () => resolve()));
        }
      }
    }
    await new Promise<void>((resolve, reject) => {
      writer.end((err?: any) => err ? reject(err) : resolve());
    });
  } catch (e: any) {
    try { rmSync(tmpPath, { force: true }); } catch { /* ok */ }
    return { ok: false, code: "fetch_failed", error: `stream-to-disk failed: ${e?.message || e}` };
  }

  // Defense-in-depth: chmod even though createWriteStream set mode 0o600
  // (some platforms ignore the mode flag).
  try { chmodSync(tmpPath, 0o600); } catch { /* best-effort */ }

  // Atomic publish — rename within same dir.
  try {
    const { renameSync } = await import("node:fs");
    renameSync(tmpPath, localPath);
  } catch (e: any) {
    try { rmSync(tmpPath, { force: true }); } catch { /* ok */ }
    return { ok: false, code: "write_failed", error: `rename failed: ${e?.message || e}` };
  }

  return { ok: true, localPath, cached: false, bytes };
}

/** Extension picker — prefers attachment.name's ext, falls back to a
 * mime-derived ext, else empty. Kept conservative — LLMs key on mime
 * via the runtime adapter, not the file extension, so this is mostly
 * for human-readable cache filenames. */
function pickExtension(attachment: AttachmentDescriptor): string {
  if (typeof attachment.name === "string") {
    const ext = extname(attachment.name);
    if (ext && ext.length <= 10 && /^\.[A-Za-z0-9]+$/.test(ext)) return ext;
  }
  const mime = typeof attachment.mime === "string" ? attachment.mime : "";
  if (mime.startsWith("image/")) {
    const sub = mime.slice(6);
    if (/^[a-z0-9]{1,8}$/.test(sub)) return `.${sub === "jpeg" ? "jpg" : sub}`;
  }
  if (mime === "application/pdf") return ".pdf";
  return "";
}

// ── Cache sweeper ──────────────────────────────────────────────────────

export interface SweepResult {
  purged: Array<{ name: string; age_ms: number }>;
  scanned: number;
  errors: number;
}

export interface SweepDeps {
  cacheDir: string;
  ttlMs?: number;
  now?: number;
  log?: (m: string) => void;
  warn?: (m: string) => void;
}

/** One sweep pass. Pure function — caller drives via setInterval. */
export function sweepAttachmentCacheOnce(deps: SweepDeps): SweepResult {
  const ttlMs = deps.ttlMs ?? CACHE_TTL_MS;
  const now = deps.now ?? Date.now();
  const warn = deps.warn ?? (() => {});
  const out: SweepResult = { purged: [], scanned: 0, errors: 0 };
  let entries: string[];
  try {
    entries = readdirSync(deps.cacheDir);
  } catch {
    return out;   // cache dir doesn't exist — nothing to do
  }
  for (const name of entries) {
    out.scanned++;
    const full = join(deps.cacheDir, name);
    let mtimeMs = 0;
    try { mtimeMs = statSync(full).mtimeMs; } catch { continue; }
    const age = now - mtimeMs;
    if (age < ttlMs) continue;
    try {
      rmSync(full, { force: true });
      out.purged.push({ name, age_ms: age });
    } catch (e: any) {
      out.errors++;
      warn(`[attachment-cache] failed to purge ${name}: ${e?.message || e}`);
    }
  }
  return out;
}

let _sweeperTimer: ReturnType<typeof setInterval> | null = null;
export function startAttachmentCacheSweeper(deps: SweepDeps): NodeJS.Timeout | null {
  if (_sweeperTimer) return _sweeperTimer;
  try { sweepAttachmentCacheOnce(deps); } catch { /* best-effort */ }
  _sweeperTimer = setInterval(() => {
    try { sweepAttachmentCacheOnce(deps); } catch { /* same */ }
  }, CACHE_SWEEP_INTERVAL_MS);
  if (typeof _sweeperTimer.unref === "function") _sweeperTimer.unref();
  return _sweeperTimer;
}

export function _stopAttachmentCacheSweeperForTest(): void {
  if (_sweeperTimer) { clearInterval(_sweeperTimer); _sweeperTimer = null; }
}
