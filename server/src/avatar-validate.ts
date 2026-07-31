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
 *   same-origin pool path /avatars/<name>.<ext>  → { ok, value: trimmed }
 *   valid absolute http(s) URL               → { ok, value: normalized }
 *   anything else                            → { ok: false, reason }
 *
 * Relative branch rationale (通信龙 裁定, avatar 接线单): the hub is
 * reached through several origins (localhost dev, public domains) — an
 * absolute URL would weld ONE hostname into the DB and break the image
 * for every other entry point; a same-origin relative path is portable.
 * 🔴 Trap this branch must block: "starts with /" ≠ "same-origin" —
 * "//evil.com/x.png" ALSO starts with "/" but is a protocol-relative URL
 * the browser resolves to evil.com. Hence: single leading slash with the
 * SECOND char not "/", then an exact value-set match (the /avatars/ pool
 * prefix + extension whitelist), not a shape match.
 */

// Exact allowed set for same-origin values: the dashboard's designed pool
// under /avatars/. Filename charset excludes "/" (no traversal, no nested
// paths) and "%" (no encoded surprises); extensions mirror the actual
// pool contents. Widen ONLY by extending this list deliberately.
const SAME_ORIGIN_AVATAR_RE = /^\/avatars\/[A-Za-z0-9._-]+\.(webp|png|svg)$/;
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
  // Same-origin relative branch (runs AFTER the whitespace/control gate
  // above — that check protects this branch too). Order of the two tests
  // matters for the reason string, not for safety: the exact-set regex
  // alone already rejects "//…" (second char is "/", first segment must
  // literally be "avatars"), the explicit double-slash check just names
  // the classic bypass in its own words.
  if (trimmed.startsWith("/")) {
    if (trimmed.startsWith("//")) {
      return { ok: false, reason: "avatar_url must not be protocol-relative (//host/…)" };
    }
    if (!SAME_ORIGIN_AVATAR_RE.test(trimmed)) {
      return { ok: false, reason: "relative avatar_url must match /avatars/<name>.(webp|png|svg)" };
    }
    return { ok: true, value: trimmed };
  }
  // Absolute http(s) branch — unchanged from #462 (do not touch while
  // relaxing: 通信龙 裁定 condition 3).
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "avatar_url must be an absolute URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "avatar_url protocol must be http or https" };
  }
  // Embedded credentials (https://user:pass@host/…) would be persisted,
  // leaked to the avatar host on every render, and can spoof the visible
  // origin in UIs. Reject outright rather than silently stripping — the
  // caller should know their input carried secrets (通信龙 review round-2
  // follow-up).
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "avatar_url must not contain credentials (userinfo)" };
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
