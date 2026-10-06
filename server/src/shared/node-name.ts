// Board #652 — node name (= network alias) rules and the ASCII folder slug derived from it.
//
// Single source of truth for hub + daemon. This file is byte-identical in
// server/src/shared/node-name.ts and agent-node/src/shared/node-name.ts
// (node-name-drift.test.ts fails the build on any difference), and the app
// (sleep2agi/agent-network-app) keeps a copy pinned to NODE_NAME_CASES below.
//
// Before #652 the name had to match /^[a-z][a-z0-9_-]{0,63}$/, so the app
// wizard refused 「测试」 while the real fleet runs Chinese aliases started by
// hand. House rule: the alias may be Chinese, the working directory may not.
// So the name is now any Unicode letters/digits, and every directory derived
// from it uses nodeFolderSlug() (or the legacy name, for names the old rule
// already accepted — see nodeDirNameFor).

/** The old rule. Every name it accepts keeps its old directory (nodeDirNameFor). */
export const LEGACY_NODE_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;

/** Folder / slug rule: what a working directory or `.anet/nodes/<dir>` may be called. */
export const NODE_FOLDER_RE = /^[a-z][a-z0-9-]{0,63}$/;

export const NODE_NAME_MAX_CHARS = 64;

// First char: a letter, a digit or `_` (never `-`: `anet node start -x` reads as a flag;
// never `.`: hidden files, `..`). Rest: letters, digits, combining marks (Devanagari,
// Thai… need them), `_`, `-`. Nothing else — no whitespace, `/ \ :`, `.`, quotes,
// `$`, backticks, control characters: the name ends up in argv, tmux session names
// (tmux rewrites `.` and `:`), JSON, logs and file names in the trash directory.
const NODE_NAME_RE = /^[\p{L}\p{N}_][\p{L}\p{M}\p{N}_-]*$/u;

export type NodeNameError =
  | "empty"
  | "too_long"
  | "leading_dash"
  | "forbidden_char"
  | "not_nfc";

export type NodeNameCheck =
  | { ok: true; name: string }
  | { ok: false; error: NodeNameError; char?: string; message: string };

/** Trim + NFC. Callers store the returned `name`, not the raw input. */
export function normalizeNodeName(raw: string): string {
  return raw.trim().normalize("NFC");
}

function describeChar(ch: string): string {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp < 0x20 || cp === 0x7f) return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
  if (/\s/u.test(ch)) return "空格";
  return ch;
}

/**
 * Check a node name. `raw` is trimmed first; the trimmed, NFC form must be
 * 1..64 characters (code points) of letters / digits / `_` / `-`, not starting with `-`.
 */
export function checkNodeName(raw: unknown): NodeNameCheck {
  if (typeof raw !== "string") return { ok: false, error: "empty", message: "名字不能为空" };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, error: "empty", message: "名字不能为空" };
  const chars = [...trimmed];
  if (chars.length > NODE_NAME_MAX_CHARS) {
    return { ok: false, error: "too_long", message: `名字最多 ${NODE_NAME_MAX_CHARS} 个字符` };
  }
  if (trimmed !== trimmed.normalize("NFC")) {
    return { ok: false, error: "not_nfc", message: "名字需要是 Unicode NFC 规范形式" };
  }
  if (chars[0] === "-") {
    return { ok: false, error: "leading_dash", char: "-", message: "名字不能以 - 开头" };
  }
  if (!NODE_NAME_RE.test(trimmed)) {
    const bad = chars.find((ch, i) => !(i === 0 ? /^[\p{L}\p{N}_]$/u : /^[\p{L}\p{M}\p{N}_-]$/u).test(ch)) ?? chars[0]!;
    return {
      ok: false,
      error: "forbidden_char",
      char: bad,
      message: `名字里不能有「${describeChar(bad)}」：只能用文字、字母、数字、_ 和 -`,
    };
  }
  return { ok: true, name: trimmed };
}

export function isValidNodeName(raw: unknown): boolean {
  return checkNodeName(raw).ok;
}

/** FNV-1a 32-bit over the UTF-8 bytes, 8 hex digits. Tiny, dependency-free, and the
 *  app reimplements it byte for byte (no crypto module needed in the browser / RN). */
export function fnv1aHex(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * ASCII folder name for a node name. Pure-ASCII names are transliterated
 * (lowercase, runs of anything outside [a-z0-9] become one `-`, trimmed, `node-`
 * prefixed when they do not start with a letter); anything else — and anything the
 * transliteration empties — becomes `node-<first 6 hex of fnv1a(name)>`.
 * The result always matches NODE_FOLDER_RE.
 */
export function nodeFolderSlug(raw: string): string {
  const name = normalizeNodeName(raw);
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7f]*$/.test(name)) {
    let s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    if (s && !/^[a-z]/.test(s)) s = `node-${s}`;
    s = s.slice(0, NODE_NAME_MAX_CHARS).replace(/-+$/, "");
    if (NODE_FOLDER_RE.test(s)) return s;
  }
  return `node-${fnv1aHex(name).slice(0, 6)}`;
}

/**
 * The directory under `.anet/nodes/` a daemon-created node lives in.
 * Names the old rule accepted keep their old directory (= the name) so nothing that
 * worked before #652 moves; every other name gets nodeFolderSlug(name).
 */
export function nodeDirNameFor(name: string): string {
  return LEGACY_NODE_NAME_RE.test(name) ? name : nodeFolderSlug(name);
}

/** Shared test vectors — the app's copy must produce the same verdicts and slugs. */
export const NODE_NAME_CASES: ReadonlyArray<{ input: string; ok: boolean; error?: NodeNameError; slug?: string }> = [
  { input: "测试", ok: true, slug: "node-f78149" },
  { input: "研发助手A", ok: true, slug: "node-1d348f" },
  { input: "AB测试牛", ok: true, slug: "node-048250" },
  { input: "my-bot", ok: true, slug: "my-bot" },
  { input: "MyBot_2", ok: true, slug: "mybot-2" },
  { input: "  spaced  ", ok: true, slug: "spaced" },
  { input: "123", ok: true, slug: "node-123" },
  { input: "_x", ok: true, slug: "x" },
  { input: "Ünïcödé", ok: true, slug: "node-030667" },
  { input: "a".repeat(64), ok: true, slug: "a".repeat(64) },
  { input: "测".repeat(64), ok: true, slug: "node-50c3fb" },
  { input: "", ok: false, error: "empty" },
  { input: "   ", ok: false, error: "empty" },
  { input: "a".repeat(65), ok: false, error: "too_long" },
  { input: "测".repeat(65), ok: false, error: "too_long" },
  { input: "-x", ok: false, error: "leading_dash" },
  { input: "e\u0301", ok: false, error: "not_nfc" },
  { input: ".hidden", ok: false, error: "forbidden_char" },
  { input: "..", ok: false, error: "forbidden_char" },
  { input: "a/b", ok: false, error: "forbidden_char" },
  { input: "a\\b", ok: false, error: "forbidden_char" },
  { input: "a:b", ok: false, error: "forbidden_char" },
  { input: "a.b", ok: false, error: "forbidden_char" },
  { input: "a b", ok: false, error: "forbidden_char" },
  { input: "a\u0000b", ok: false, error: "forbidden_char" },
  { input: "a\nb", ok: false, error: "forbidden_char" },
  { input: "a$b", ok: false, error: "forbidden_char" },
  { input: "a`b", ok: false, error: "forbidden_char" },
  { input: "a'b", ok: false, error: "forbidden_char" },
  { input: "a\"b", ok: false, error: "forbidden_char" },
  { input: "a;b", ok: false, error: "forbidden_char" },
  { input: "a*b", ok: false, error: "forbidden_char" },
];
