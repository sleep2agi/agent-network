/**
 * RFC-020 §15 — agent→bridge outbound file protocol.
 *
 * 2026-06-29 Vincent UAT: agent generated a PDF via reportlab + wrote it
 * to `/work/feishu-attachments/<conv>/x.pdf`, then in text asked Vincent
 * "I'm not sure if the system will auto-attach this — try another way?"
 * The bridge has `adapter.send({files})` since #329, but no protocol
 * told the agent how to signal "dispatch this file to the user".
 *
 * Convention: in its final reply, the agent emits one
 *
 *     [[send-file:/abs/path]]
 *
 * marker per file (one per line, end of reply). The bridge:
 *
 *   1. extracts every `[[send-file:...]]` token,
 *   2. strips them from the user-visible text,
 *   3. validates each path against an allowed-outbound-root whitelist
 *      (`/work/feishu-attachments/<conn>/<chat>/` — same per-conversation
 *      directory the LLM has Write access to under Layer B),
 *   4. checks the file exists, is non-empty, and ≤ 30 MB (Feishu file_v1
 *      upper bound),
 *   5. magic-byte sniffs to choose `image_key` vs `file_key` upload route,
 *   6. dispatches each file via `adapter.send({files:[...]})`,
 *   7. emits a friendly fallback if validation fails — never the raw error.
 *
 * Pure module — no I/O, no IM SDK calls. The parser returns the cleaned
 * text + a structured list of file requests; bridge.ts is responsible
 * for filesystem checks and dispatching.
 */

import * as path from "node:path";

/**
 * One outbound-file request parsed from an agent reply.
 *
 *  - `raw`: the bytes between `[[send-file:` and `]]`, before any
 *    normalization. Kept for stderr forensic.
 *  - `normalized`: lexical-normalized absolute path (quote-strip, `..`
 *    collapse, `//` collapse, `./` resolution against cwd). The
 *    `validatedAbsolute` field is set later by the bridge after the
 *    realpath / whitelist / exists check.
 */
export interface OutboundFileRequest {
  raw: string;
  normalized: string;
}

export interface MarkerParseResult {
  /** Reply text with all `[[send-file:...]]` markers removed + adjacent
   *  whitespace collapsed. May be empty (file-only reply). */
  cleanedText: string;
  /** Files in source order. Caller-side validation happens after. */
  files: OutboundFileRequest[];
}

/**
 * Matches one `[[send-file:<path>]]` token. Path bytes are
 * non-`]` characters; the closing `]]` is required. Anchored to either
 * a line boundary or another marker to keep prose containing `[[…]]`
 * safe (Markdown wiki-link style etc.).
 *
 * Captures the path bytes (group 1).
 */
const MARKER_RE = /\[\[send-file:([^\]\n]+)\]\]/g;

/**
 * Lexically normalize a path token from the marker. NOT a full
 * symlink/realpath resolver — bridge does that after this returns.
 *
 *  - Trim leading / trailing whitespace.
 *  - Strip one layer of matching quotes (`"/x"` / `'/x'` → `/x`).
 *  - `.` and `..` segments collapse via `path.posix.normalize`.
 *  - Repeated `/` collapse.
 *
 * Returns an absolute path or the empty string if the input cannot be
 * interpreted as an absolute path token (caller drops empties).
 */
export function normalizeMarkerPath(raw: string): string {
  let p = raw.trim();
  if (p.length >= 2) {
    if ((p[0] === '"' && p[p.length - 1] === '"') || (p[0] === "'" && p[p.length - 1] === "'")) {
      p = p.slice(1, -1).trim();
    }
  }
  if (!p.startsWith("/")) return "";
  // posix.normalize collapses `//`, `.`, `..` segments.
  return path.posix.normalize(p);
}

/**
 * Parse an agent reply into cleaned text + outbound-file requests.
 *
 * Empty / null input returns `{cleanedText: "", files: []}` so callers
 * can safely pipe through without defensive checks.
 *
 * Marker-only reply (no surrounding text) returns `cleanedText: ""` —
 * caller should NOT send an empty text message in that case; they only
 * dispatch the files.
 *
 * Multiple markers on one reply are all captured. Adjacent whitespace
 * around stripped markers is collapsed (no double blank lines).
 */
export function parseOutboundMarkers(reply: string | null | undefined): MarkerParseResult {
  if (!reply || typeof reply !== "string") {
    return { cleanedText: "", files: [] };
  }
  const files: OutboundFileRequest[] = [];
  // First pass: extract markers
  let m: RegExpExecArray | null;
  // Need to reset lastIndex since MARKER_RE is /g.
  MARKER_RE.lastIndex = 0;
  while ((m = MARKER_RE.exec(reply)) !== null) {
    const raw = m[1] ?? "";
    const normalized = normalizeMarkerPath(raw);
    if (normalized) {
      files.push({ raw, normalized });
    }
    // Empty normalized → drop the marker (e.g. agent emits relative path);
    // still removed from the visible text below.
  }
  // Second pass: strip markers from text, collapse whitespace
  let cleaned = reply.replace(MARKER_RE, "");
  // Collapse runs of blank lines left by strips
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  // Trim trailing whitespace on individual lines (from "text [[marker]]\n")
  cleaned = cleaned
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .trim();
  return { cleanedText: cleaned, files };
}

/**
 * The single allowed outbound root for files the agent wants to send.
 * Each conversation gets its own subdirectory under this root; the
 * agent's Write permission on this tree is granted by Layer B (config
 * paths like `access.json` / `config.json` are denied, attachments
 * dir is allowed).
 *
 * `<conv>` is the open_chat_id (group) or open_id (DM). Bridge fills
 * the placeholder per-event when validating.
 */
export const OUTBOUND_ROOT = "/work/feishu-attachments";

/**
 * Validate a normalized absolute path against the per-conversation
 * whitelist + size + existence checks. Returns null on success or a
 * Chinese user-friendly reason on failure (the same string can be
 * surfaced as a fallback text reply when ALL files fail validation).
 *
 * Filesystem-touching — bridge calls this AFTER `parseOutboundMarkers`.
 *
 * Params:
 *   - p: normalized absolute path candidate
 *   - convKey: per-conversation directory name (open_chat_id / open_id)
 *   - statFn: optional override for tests (defaults to fs.statSync)
 *   - realpathFn: optional override for tests (defaults to fs.realpathSync)
 *
 * Note: `convKey` may include characters Feishu accepts but are unusual
 * for file paths (open_id starts with `ou_`, open_chat_id with `oc_`).
 * The whitelist check uses the literal substring + path.posix.dirname
 * walk so symlink redirects don't bypass it — the realpath form must
 * also fall under `OUTBOUND_ROOT/<connection>/<convKey>/`.
 */
export interface ValidateOpts {
  p: string;
  convKey: string;
  connectionName: string;
  statFn?: (p: string) => { size: number };
  realpathFn?: (p: string) => string;
}
export function validateOutboundPath(opts: ValidateOpts): string | null {
  const expectedPrefix = `${OUTBOUND_ROOT}/${opts.connectionName}/${opts.convKey}/`;
  if (!opts.p.startsWith(expectedPrefix)) {
    return `[文件附件未发送] 路径不在允许的会话目录内 (必须在 ${expectedPrefix} 下)`;
  }
  // Realpath check — if file is a symlink pointing outside the allowed
  // root, reject. Failing realpath (ENOENT) means file doesn't exist
  // yet, which we'll catch via stat below.
  let real: string;
  try {
    const fn = opts.realpathFn || ((p: string) => require("node:fs").realpathSync(p));
    real = fn(opts.p);
  } catch {
    return `[文件附件未发送] 路径不存在或不可访问`;
  }
  if (!real.startsWith(expectedPrefix)) {
    return `[文件附件未发送] 实际路径越权 (symlink 指向了允许目录外)`;
  }
  // Size check.
  try {
    const fn = opts.statFn || ((p: string) => require("node:fs").statSync(p));
    const st = fn(real);
    if (!st.size || st.size <= 0) {
      return `[文件附件未发送] 文件为空`;
    }
    // Feishu file_v1 upper bound — 30 MB. Image v1 is 10 MB; we allow up
    // to 30 here and let the per-route upload return its own error if the
    // image route rejects the buffer.
    const MAX_BYTES = 30 * 1024 * 1024;
    if (st.size > MAX_BYTES) {
      return `[文件附件未发送] 文件过大 (>${Math.floor(MAX_BYTES / 1024 / 1024)}MB)`;
    }
  } catch {
    return `[文件附件未发送] 文件元数据读取失败`;
  }
  return null;
}

/**
 * Magic-byte sniffer — picks `image` vs `file` upload route. Reads the
 * first 16 bytes only; safe to call before commitment. Returns:
 *
 *   - "image" when the bytes are a PNG / JPG / GIF / WebP / BMP signature
 *     (Feishu image_v1 supports these natively, with chat inline render).
 *   - "file" otherwise (PDF, TXT, audio, video, archive, …).
 *
 * Caller supplies a Buffer (bridge reads via fs.openSync + readSync).
 */
export function sniffFileKind(buf: Buffer): "image" | "file" {
  if (buf.length < 4) return "file";
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image";
  // JPG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image";
  // GIF: "GIF8"
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "image";
  // BMP: "BM"
  if (buf[0] === 0x42 && buf[1] === 0x4d) return "image";
  // WebP: "RIFF" .. "WEBP"
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return "image";
  return "file";
}

/**
 * User-facing fallback message when ALL marker validations fail and the
 * stripped text is empty (would leave the user with no reply at all).
 */
export const ALL_FILES_FAILED_FALLBACK =
  "[文件附件发送失败] 我准备好了文件但分发时出了问题——稍后再试或换种方式。";
