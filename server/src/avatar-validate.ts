// #462 — validator for the user-set custom avatar URL (nodes.avatar_url).
//
// The value ends up in an <img src> on every dashboard client, so this is
// an XSS trust boundary: protocol MUST be http/https (rejects javascript:,
// data:, vbscript:, file:, blob:, …), no whitespace/control characters,
// bounded length. Pure function, unit-tested in avatar-validate.test.ts.

export const MAX_AVATAR_URL_LENGTH = 2048;

export type AvatarValidation =
  | { ok: true; value: string | null }
  | { ok: false; reason: string };

/**
 * Normalize + validate an untrusted avatar_url patch value.
 *
 *   null / undefined / "" / whitespace-only  → { ok, value: null }  (clear)
 *   valid absolute http(s) URL               → { ok, value: trimmed }
 *   anything else                            → { ok: false, reason }
 */
export function validateAvatarUrl(raw: unknown): AvatarValidation {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== "string") {
    return { ok: false, reason: "avatar_url must be a string or null" };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  if (trimmed.length > MAX_AVATAR_URL_LENGTH) {
    return { ok: false, reason: `avatar_url must be ≤ ${MAX_AVATAR_URL_LENGTH} chars` };
  }
  // Reject embedded whitespace + C0/C1 control chars outright. URL()
  // silently strips some of these (e.g. tabs/newlines), which would let
  // "java\tscript:" style payloads normalize into a hostile protocol —
  // so this check must run BEFORE parsing, on the raw trimmed string.
  if (/[\u0000-\u001f\u007f-\u009f\s]/.test(trimmed)) {
    return { ok: false, reason: "avatar_url must not contain whitespace or control characters" };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "avatar_url must be an absolute URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "avatar_url protocol must be http or https" };
  }
  // Persist the NORMALIZED href, not the raw input: href percent-encodes
  // markup-hostile characters (" < > ` → %22 %3C %3E %60), so what lands
  // in the DB is already safe to interpolate into an <img src> attribute.
  // The dashboard renderer lives in a different package this repo cannot
  // audit — the server must not bet on it escaping (审查修复 per 通信龙
  // #461/#462 review, finding 3).
  const normalized = parsed.href;
  // Belt-and-braces: reject anything href does NOT encode that could
  // still break out of an attribute context (WHATWG URL leaves ' and \
  // untouched in some positions).
  if (/["'<>\\`]/.test(normalized)) {
    return { ok: false, reason: "avatar_url contains characters not allowed in a URL" };
  }
  return { ok: true, value: normalized };
}
