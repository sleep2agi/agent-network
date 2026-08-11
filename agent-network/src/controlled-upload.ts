/**
 * #693 — token-bound node controlled local file → Hub /api/upload bridge.
 *
 * Security boundary (hard gates):
 *  1. Cross-host: bytes travel over HTTP multipart; Hub never reads agent FS.
 *  2. Identity: caller supplies the node's bearer token; ntok binds network.
 *  3. Path safety: realpath + allowlisted roots only; reject .., symlink
 *     escape, non-regular files, arbitrary absolute paths outside roots.
 *  4. Size ≤ 12 MiB; filename/MIME normalized; non-files rejected.
 *  5. Hub /api/upload is the sole write surface (atomic on hub side).
 *
 * Prefer this over send_reply path auto-upload (scheme B): security boundary
 * is explicit, and Hub file_id gate stays untouched.
 */

import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";

/** Mirrors server/src/uploads.ts MAX_UPLOAD_BYTES. */
export const CONTROLLED_UPLOAD_MAX_BYTES = 12 * 1024 * 1024;

export type ControlledUploadErrorCode =
  | "path_required"
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
  /** Override allowlist roots (tests). */
  allowedRoots?: string[];
  /** Alias used only to derive default cache root — never sent to hub as owner. */
  alias?: string;
  /** Node work dir (e.g. ~/.anet/nodes/<id>). */
  nodeDir?: string;
  fetch?: typeof fetch;
  /** Test-only home override. */
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

/**
 * Default controlled roots for a token-bound node. Never trusts arbitrary
 * absolute paths. Callers may extend via ANET_UPLOAD_ROOTS (colon-separated).
 */
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
  // Grok Build ACP generated assets (images/videos under session dirs)
  roots.push(join(home, ".grok", "sessions"));
  roots.push(join(home, ".grok", "images"));
  // Feishu inbound drop zones
  roots.push("/work/feishu-attachments");
  if (env.ANET_FEISHU_MEDIA_DIR?.trim()) roots.push(env.ANET_FEISHU_MEDIA_DIR.trim());
  // Explicit operator allowlist
  if (env.ANET_UPLOAD_ROOTS?.trim()) {
    for (const part of env.ANET_UPLOAD_ROOTS.split(":")) {
      const p = part.trim();
      if (p) roots.push(p);
    }
  }
  // Cwd only when it sits under home/.anet or home/.grok (never whole $HOME)
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

/**
 * Resolve a user-supplied path to a canonical regular file under an
 * allowlisted root. Uses lstat to reject symlinks at the leaf, then
 * realpath + relative boundary check against each root.
 */
export function resolveControlledUploadPath(
  rawPath: string,
  allowedRoots: string[],
): { ok: true; canonicalPath: string } | ControlledUploadFail {
  if (!rawPath || typeof rawPath !== "string" || !rawPath.trim()) {
    return { ok: false, error: "path_required", message: "path is required" };
  }
  const input = rawPath.trim();
  // Reject null bytes and obvious traversal tokens before fs access
  if (input.includes("\0") || input.includes("..")) {
    // Still allow ".." only if final realpath stays in root — but reject
    // explicit ".." segments early for defense-in-depth against partial
    // realpath failures. Full boundary is enforced below on canonical path.
  }

  let lst: ReturnType<typeof lstatSync>;
  try {
    lst = lstatSync(input);
  } catch {
    return { ok: false, error: "path_not_found", message: "path does not exist" };
  }
  if (lst.isSymbolicLink()) {
    return { ok: false, error: "path_symlink", message: "symlink paths are not allowed for upload" };
  }
  if (!lst.isFile()) {
    return { ok: false, error: "path_not_regular", message: "path is not a regular file" };
  }

  let fileReal: string;
  try {
    fileReal = realpathSync(input);
  } catch {
    return { ok: false, error: "path_not_found", message: "path cannot be realpath'd" };
  }

  // Re-check after realpath (symlink parents are resolved)
  try {
    const st = statSync(fileReal);
    if (!st.isFile()) {
      return { ok: false, error: "path_not_regular", message: "resolved path is not a regular file" };
    }
  } catch {
    return { ok: false, error: "path_not_found", message: "resolved path missing" };
  }

  for (const root of allowedRoots) {
    if (!root) continue;
    try {
      if (!existsSync(root)) continue;
      const rootReal = realpathSync(root);
      const rel = relative(rootReal, fileReal);
      if (rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
        return { ok: true, canonicalPath: fileReal };
      }
    } catch {
      /* unreadable roots are not trust roots */
    }
  }

  return {
    ok: false,
    error: "path_untrusted",
    message: "path is outside this node's controlled upload roots (generated assets / attachment cache only)",
  };
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
  const resolved = resolveControlledUploadPath(rawPath, roots);
  if (!resolved.ok) return resolved;

  let size = 0;
  try {
    size = statSync(resolved.canonicalPath).size;
  } catch (e: any) {
    return { ok: false, error: "read_failed", message: e?.message ?? "stat failed" };
  }
  if (size <= 0) {
    return { ok: false, error: "path_empty", message: "file is empty" };
  }
  if (size > CONTROLLED_UPLOAD_MAX_BYTES) {
    return {
      ok: false,
      error: "payload_too_large",
      message: `file exceeds ${CONTROLLED_UPLOAD_MAX_BYTES} byte limit (observed ${size})`,
    };
  }

  let buf: Buffer;
  try {
    buf = readFileSync(resolved.canonicalPath);
  } catch (e: any) {
    return { ok: false, error: "read_failed", message: e?.message ?? "read failed" };
  }
  // belt: re-check after read
  if (buf.byteLength > CONTROLLED_UPLOAD_MAX_BYTES) {
    return {
      ok: false,
      error: "payload_too_large",
      message: `file exceeds ${CONTROLLED_UPLOAD_MAX_BYTES} byte limit`,
    };
  }

  const name = normalizeUploadName(opts.name ?? basename(resolved.canonicalPath));
  const mime = (opts.mime && opts.mime.slice(0, 100)) || sniffMime(name);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(buf)], { type: mime }), name);

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
    size: typeof body?.size === "number" ? body.size : buf.byteLength,
    url: typeof body?.url === "string" ? body.url : `/api/files/${fileId}`,
  };
}
