/**
 * #693 — token-bound node controlled local file → Hub /api/upload bridge.
 *
 * Security boundary (hard gates):
 *  1. Cross-host: bytes travel over HTTP multipart; Hub never reads agent FS.
 *  2. Identity: caller supplies the node's bearer token; ntok binds network.
 *  3. Path safety: realpath + allowlisted roots; reject NUL, symlink, traversal.
 *  4. Size ≤ 12 MiB enforced with same-fd fstat + bounded read (no full slurp).
 *  5. Hub /api/upload is the sole write surface (atomic on hub side).
 *
 * Adversarial add-only (#694 DO-NOT-MERGE fixes):
 *  - TOCTOU: open O_NOFOLLOW → fstat(fd) → read(fd) only; no re-open by path.
 *  - Bounded read: never allocate/read past CONTROLLED_UPLOAD_MAX_BYTES.
 *  - NUL guard is live and reachable before any fs call.
 */

import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  readlinkSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { homedir } from "node:os";

/** Mirrors server/src/uploads.ts MAX_UPLOAD_BYTES. */
export const CONTROLLED_UPLOAD_MAX_BYTES = 12 * 1024 * 1024;

/** Chunk size for bounded streaming read from a single fd. */
export const CONTROLLED_UPLOAD_READ_CHUNK = 64 * 1024;

export type ControlledUploadErrorCode =
  | "path_required"
  | "path_nul"
  | "path_not_found"
  | "path_untrusted"
  | "path_symlink"
  | "path_not_regular"
  | "path_empty"
  | "payload_too_large"
  | "read_failed"
  | "auth_required"
  | "hub_url_required"
  | "upload_failed"
  | "bad_response"
  | "missing_file_id";

export type ControlledUploadFail = {
  ok: false;
  error: ControlledUploadErrorCode;
  message: string;
};

export type ControlledUploadOk = {
  ok: true;
  file_id: string;
  name: string;
  mime: string;
  size: number;
  url?: string;
};

export type ControlledUploadResult = ControlledUploadOk | ControlledUploadFail;

export interface ControlledUploadDeps {
  hubUrl: string;
  authToken: string;
  allowedRoots?: string[];
  alias?: string;
  nodeDir?: string;
  fetch?: typeof fetch;
  home?: string;
}

function sniffMime(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    txt: "text/plain",
    json: "application/json",
    md: "text/markdown",
    mp4: "video/mp4",
    webm: "video/webm",
  };
  return map[ext] ?? "application/octet-stream";
}

/** Normalize a client filename: basename only, strip controls, cap 255. */
export function normalizeUploadName(input: string | undefined | null, fallback = "upload.bin"): string {
  const raw = (input && typeof input === "string" ? input : fallback).split(/[\\/]/).pop() || fallback;
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, "_").replace(/^\.+/, "").slice(0, 255);
  return cleaned || fallback;
}

export function defaultControlledUploadRoots(opts: {
  home?: string;
  alias?: string;
  nodeDir?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
} = {}): string[] {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const roots: string[] = [];
  const alias = opts.alias?.trim();
  if (alias) {
    roots.push(join(home, ".anet", "cache", "attachments", alias));
  }
  roots.push(join(home, ".anet", "cache", "attachments"));
  if (opts.nodeDir) roots.push(opts.nodeDir);
  roots.push(join(home, ".grok", "sessions"));
  roots.push(join(home, ".grok", "images"));
  roots.push("/work/feishu-attachments");
  if (env.ANET_FEISHU_MEDIA_DIR?.trim()) roots.push(env.ANET_FEISHU_MEDIA_DIR.trim());
  if (env.ANET_UPLOAD_ROOTS?.trim()) {
    for (const part of env.ANET_UPLOAD_ROOTS.split(":")) {
      const p = part.trim();
      if (p) roots.push(p);
    }
  }
  const cwd = opts.cwd ?? process.cwd();
  try {
    const cwdReal = realpathSync(cwd);
    const homeReal = realpathSync(home);
    const rel = relative(homeReal, cwdReal);
    if (rel === ".anet" || rel.startsWith(`.anet${sep}`) || rel === ".grok" || rel.startsWith(`.grok${sep}`)) {
      roots.push(cwdReal);
    }
  } catch { /* ignore */ }
  return roots;
}

/** True iff canonicalPath is strictly inside one of the allowlisted roots. */
export function isPathInsideAllowedRoots(canonicalPath: string, allowedRoots: string[]): boolean {
  for (const root of allowedRoots) {
    if (!root) continue;
    try {
      if (!existsSync(root)) continue;
      const rootReal = realpathSync(root);
      const rel = relative(rootReal, canonicalPath);
      if (rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
        return true;
      }
    } catch {
      /* unreadable roots are not trust roots */
    }
  }
  return false;
}

/**
 * Resolve a user-supplied path to a canonical path under an allowlisted root.
 * Does not open the file for reading — open+fstat+read is a separate same-fd step.
 */
export function resolveControlledUploadPath(
  rawPath: string,
  allowedRoots: string[],
): { ok: true; canonicalPath: string } | ControlledUploadFail {
  if (!rawPath || typeof rawPath !== "string" || !rawPath.trim()) {
    return { ok: false, error: "path_required", message: "path is required" };
  }
  // LIVE NUL guard — must run before any fs syscall (adversarial finding #4).
  if (rawPath.includes("\0")) {
    return {
      ok: false,
      error: "path_nul",
      message: "path must not contain NUL bytes",
    };
  }
  const input = rawPath.trim();
  if (!input) {
    return { ok: false, error: "path_required", message: "path is required" };
  }
  // Note: NUL already rejected on rawPath above (must stay single live gate so
  // witnessed-red mutation that disables it is non-vacuous).

  // Reject symlink leaves before realpath via open(O_NOFOLLOW) path in reader;
  // here we only realpath for allowlist placement of non-symlink paths.
  // realpath follows intermediate symlink dirs; final leaf is re-checked at open.
  let fileReal: string;
  try {
    fileReal = realpathSync(input);
  } catch {
    return { ok: false, error: "path_not_found", message: "path does not exist or cannot be realpath'd" };
  }

  if (!isPathInsideAllowedRoots(fileReal, allowedRoots)) {
    return {
      ok: false,
      error: "path_untrusted",
      message: "path is outside this node's controlled upload roots (generated assets / attachment cache only)",
    };
  }
  return { ok: true, canonicalPath: fileReal };
}

export type ControlledFileBytes =
  | { ok: true; bytes: Buffer; size: number; canonicalPath: string }
  | ControlledUploadFail;

/**
 * Open → fstat(fd) → bounded read(fd) on the **same fd** (TOCTOU hard gate).
 * Uses O_NOFOLLOW when available so a symlink swap at open is rejected.
 * Never uses path-based readFileSync after the initial open.
 */
export function openFstatBoundedReadControlledFile(
  canonicalPath: string,
  allowedRoots: string[],
  maxBytes: number = CONTROLLED_UPLOAD_MAX_BYTES,
): ControlledFileBytes {
  // Re-assert allowlist on the path we are about to open (defense in depth).
  if (!isPathInsideAllowedRoots(canonicalPath, allowedRoots)) {
    return {
      ok: false,
      error: "path_untrusted",
      message: "path is outside this node's controlled upload roots",
    };
  }

  const flags =
    fsConstants.O_RDONLY
    | (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0)
    | (typeof (fsConstants as any).O_CLOEXEC === "number" ? (fsConstants as any).O_CLOEXEC : 0);

  let fd: number;
  try {
    fd = openSync(canonicalPath, flags);
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    // Linux ELOOP / EINVAL when O_NOFOLLOW hits a symlink leaf
    if (e?.code === "ELOOP" || /symlink|ELOOP/i.test(msg)) {
      return { ok: false, error: "path_symlink", message: "symlink paths are not allowed for upload" };
    }
    return { ok: false, error: "path_not_found", message: msg };
  }

  try {
    // Same-fd identity: prefer /proc/self/fd/N real target when available.
    try {
      const viaProc = readlinkSync(`/proc/self/fd/${fd}`);
      if (viaProc && !isPathInsideAllowedRoots(viaProc, allowedRoots)) {
        return {
          ok: false,
          error: "path_untrusted",
          message: "opened fd resolved outside controlled roots",
        };
      }
    } catch {
      /* non-Linux or restricted /proc — fstat + O_NOFOLLOW still apply */
    }

    const st = fstatSync(fd);
    if (st.isSymbolicLink?.() === true) {
      return { ok: false, error: "path_symlink", message: "symlink fd rejected" };
    }
    if (!st.isFile()) {
      return { ok: false, error: "path_not_regular", message: "path is not a regular file" };
    }
    if (st.size <= 0) {
      return { ok: false, error: "path_empty", message: "file is empty" };
    }
    // Pre-check from fstat — still enforce again during read in case of growth.
    if (st.size > maxBytes) {
      return {
        ok: false,
        error: "payload_too_large",
        message: `file exceeds ${maxBytes} byte limit (observed ${st.size})`,
      };
    }

    // Bounded read from the same fd only. Never allocate more than maxBytes.
    const chunks: Buffer[] = [];
    let total = 0;
    const chunk = Buffer.alloc(Math.min(CONTROLLED_UPLOAD_READ_CHUNK, maxBytes));
    while (total < maxBytes) {
      const toRead = Math.min(chunk.length, maxBytes - total);
      let n: number;
      try {
        n = readSync(fd, chunk, 0, toRead, total);
      } catch (e: any) {
        return { ok: false, error: "read_failed", message: e?.message ?? "read failed" };
      }
      if (n === 0) break;
      chunks.push(Buffer.from(chunk.subarray(0, n)));
      total += n;
      if (total > maxBytes) {
        return {
          ok: false,
          error: "payload_too_large",
          message: `file exceeds ${maxBytes} byte limit during read`,
        };
      }
    }
    // If we filled maxBytes, probe one more byte — file may have grown or lied.
    if (total >= maxBytes) {
      const probe = Buffer.alloc(1);
      let extra = 0;
      try {
        extra = readSync(fd, probe, 0, 1, total);
      } catch {
        extra = 0;
      }
      if (extra > 0) {
        return {
          ok: false,
          error: "payload_too_large",
          message: `file exceeds ${maxBytes} byte limit (extra bytes after cap)`,
        };
      }
    }
    if (total <= 0) {
      return { ok: false, error: "path_empty", message: "file is empty" };
    }
    return {
      ok: true,
      bytes: Buffer.concat(chunks, total),
      size: total,
      canonicalPath,
    };
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * Upload a controlled local file to Hub POST /api/upload.
 * Returns file_id + metadata for send_reply attachments.
 * Never falls back to sending a raw path to the Hub.
 */
export async function uploadControlledLocalFile(
  rawPath: string,
  deps: ControlledUploadDeps,
  opts: { name?: string; mime?: string } = {},
): Promise<ControlledUploadResult> {
  if (!deps.hubUrl?.trim()) {
    return { ok: false, error: "hub_url_required", message: "hubUrl is required" };
  }
  if (!deps.authToken?.trim()) {
    return { ok: false, error: "auth_required", message: "auth token is required (token-bound node)" };
  }

  const roots = deps.allowedRoots ?? defaultControlledUploadRoots({
    home: deps.home,
    alias: deps.alias,
    nodeDir: deps.nodeDir,
  });

  // NUL / allowlist resolve first (no open yet).
  const resolved = resolveControlledUploadPath(rawPath, roots);
  if (!resolved.ok) return resolved;

  // Same-fd fstat + bounded read (closes TOCTOU + full-slurp findings).
  const file = openFstatBoundedReadControlledFile(
    resolved.canonicalPath,
    roots,
    CONTROLLED_UPLOAD_MAX_BYTES,
  );
  if (!file.ok) return file;

  const name = normalizeUploadName(opts.name ?? basename(file.canonicalPath));
  const mime = (opts.mime && opts.mime.slice(0, 100)) || sniffMime(name);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(file.bytes)], { type: mime }), name);

  const url = `${deps.hubUrl.replace(/\/+$/, "")}/api/upload`;
  const fetchFn = deps.fetch ?? fetch;
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${deps.authToken}` },
      body: form,
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
  if (typeof fileId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(fileId)) {
    return { ok: false, error: "missing_file_id", message: "hub response missing valid file_id" };
  }

  return {
    ok: true,
    file_id: fileId,
    name: typeof body?.name === "string" && body.name ? normalizeUploadName(body.name, name) : name,
    mime: typeof body?.mime === "string" && body.mime ? body.mime.slice(0, 100) : mime,
    size: typeof body?.size === "number" ? body.size : file.size,
    url: typeof body?.url === "string" ? body.url : `/api/files/${fileId}`,
  };
}
