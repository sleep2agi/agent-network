// Boundary validation for node DISPLAY attributes (display_name / team /
// tags). Mirrors `avatar-validate.ts` in spirit: this is the only place
// that decides what a client is allowed to store, and it trusts nothing.
//
// Two different postures on purpose:
//
//   display_name / team — SCALAR fields the user typed. A wrong TYPE here
//     is a client bug, so it is REJECTED (400) rather than coerced: silently
//     turning `{}` into "[object Object]" would persist garbage the user
//     never typed and can't explain.
//
//   tags — a LIST. Same reasoning as the `channels` patch in tools.ts: the
//     wire contract wants junk dropped instead of failing the whole request,
//     so one fat-fingered entry from a dashboard doesn't 400 the save. Each
//     element is narrowed independently (typeof → trim → length cap →
//     dedup), so nothing non-string can reach the database.

/** Max stored length of display_name / team. */
export const MAX_ATTR_LEN = 120;
/** Max stored length of a single tag. */
export const MAX_TAG_LEN = 64;
/** Max number of tags kept per node. */
export const MAX_TAGS = 16;

export type ScalarAttrResult =
  | { ok: true; value: string | null }
  | { ok: false; reason: string };

/**
 * Narrow an optional scalar display attribute.
 *   undefined      → not part of this patch (caller leaves the column alone)
 *   null / ""      → explicit clear
 *   non-string     → rejected (never coerced)
 *   over-long      → rejected (the user should see it, not silently lose text)
 */
export function validateScalarAttr(raw: unknown, field: string): ScalarAttrResult {
  if (raw === undefined) return { ok: true, value: null };
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") {
    return { ok: false, reason: `${field} must be a string or null` };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  if (trimmed.length > MAX_ATTR_LEN) {
    return { ok: false, reason: `${field} exceeds ${MAX_ATTR_LEN} characters` };
  }
  // Control characters would corrupt any log line / table cell that renders
  // the value; strip rather than reject (they are almost always a paste
  // artefact, not user intent).
  // eslint-disable-next-line no-control-regex
  const clean = trimmed.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return { ok: true, value: clean.length > 0 ? clean : null };
}

/**
 * Narrow an untrusted tags array. NEVER throws, never rejects the request:
 * unusable entries are dropped. Returns the canonical list to store.
 */
export function narrowTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue; // numbers/objects/arrays/null
    // eslint-disable-next-line no-control-regex
    const t = item.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
    if (t.length === 0) continue;
    if (t.length > MAX_TAG_LEN) continue; // absurd entry — drop, don't truncate
    const key = t.toLowerCase(); // case-fold for dedup, keep first spelling
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** Parse the stored tags column back into an array. Storage is JSON text;
 *  anything unparseable (hand-edited DB, older format) reads as empty so a
 *  dashboard can always `.map()` without a guard. */
export function parseStoredTags(stored: unknown): string[] {
  if (typeof stored !== "string" || stored.length === 0) return [];
  try {
    return narrowTags(JSON.parse(stored));
  } catch {
    return [];
  }
}

/**
 * 节点「职责介绍」(admin 2026-11-15「每个节点的职责需要让其他节点也能看到;desc 里放介绍而不是 AGENTS.md,
 * AGENTS.md 是给自己看的,需要设计个给其他节点看的自己的职责、能干什么」)。
 *
 * 和 display_name / team 同一种姿态(类型错 → 400,不强转),但它是一段多行文字:
 *   - 保留换行和制表(写「能干什么 / 不干什么 / 怎么找我」要分行);其余控制字符换成空格;
 *   - 每行去掉行尾空白,连续空行最多留一行;
 *   - 上限 MAX_DESCRIPTION_LEN 字符(按 Unicode 码点数),超了拒绝 —— 让人看到,而不是悄悄截掉。
 */
export const MAX_DESCRIPTION_LEN = 1000;

export function validateDescription(raw: unknown): ScalarAttrResult {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, reason: "description must be a string or null" };
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, " ")
    .split("\n").map(line => line.replace(/\s+$/u, "")).join("\n")
    .replace(/\n{3,}/g, "\n\n").trim();
  if (clean.length === 0) return { ok: true, value: null };
  if ([...clean].length > MAX_DESCRIPTION_LEN) {
    return { ok: false, reason: `description exceeds ${MAX_DESCRIPTION_LEN} characters` };
  }
  return { ok: true, value: clean };
}

/** 状态列表里只放一行摘要(整段在 get_session_status / GET /api/nodes 里):第一段非空行,最多 n 个字。 */
export function descriptionSummary(description: string | null | undefined, n = 120): string | null {
  if (!description) return null;
  const first = description.split("\n").map(s => s.trim()).find(Boolean) ?? "";
  if (!first) return null;
  const chars = [...first];
  return chars.length > n ? `${chars.slice(0, n - 1).join("")}…` : first;
}
