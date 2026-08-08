// Phase 1 of #184 — Agent Network scheduled-goal command parser.
//
// Strict per 通信牛 review #7: reject ambiguous input, no defaults. The
// minimum interval is implicitly enforced by accepting only minutes-and-up
// units (no `s`/`sec`/`秒`) so a user cannot accidentally provoke wake-storm
// load on the codex runtime. `MIN_INTERVAL_MS = 60_000` is also asserted
// post-parse as a defence-in-depth check.
//
// Accepted forms (case-insensitive on ASCII; locale-sensitive on CJK):
//   Single-letter: `5m`, `2h`, `1d` (matches what `anet node loop --every`
//                  emits — keep parser and CLI in lockstep).
//   English:       `5min`, `5 min`, `5 minute`, `5 minutes`,
//                  `1h`, `1 hour`, `2 hours`, `hourly`, `daily`, `1 day`
//   Chinese:       `5分钟`, `每5分钟`, `1小时`, `每小时`, `每天`
//
// Rejected: sub-minute units (`5s`, `30秒`), no interval at all, bare
// numbers without units (`/aloop 5 check` — unit-free 5 is ambiguous).
//
// #144 round-6 (this fix): added single-letter `m`/`h`/`d` so that
// `anet node loop <alias> "<task>" --every 5m` actually creates a goal
// instead of silent-failing. The CLI emits `5m` / `30s` / `2h` / `1d`
// straight from `--every` and previously the parser rejected all of them
// because INTERVAL_PATTERNS only matched word-form unit names.

export const MIN_INTERVAL_MS = 60_000;

export interface ParsedGoal {
  text: string;
  interval_ms: number;
}

export type ParseResult =
  | { ok: true; goal: ParsedGoal }
  | { ok: false; error: string };

// Ordered: longest English unit words first to avoid prefix capture (e.g.
// `minutes` before `min`). Word-boundary `\b` follows the unit on the
// English side so `5min` and `5 minute` both anchor correctly but `5minor`
// would not. CJK patterns don't need `\b` (no word-boundary semantics for
// Han characters).
const INTERVAL_PATTERNS: Array<{
  re: RegExp;
  toMs: (m: RegExpExecArray) => number;
}> = [
  // English keywords
  { re: /\bhourly\b/i, toMs: () => 60 * 60_000 },
  { re: /\bdaily\b/i, toMs: () => 24 * 60 * 60_000 },

  // Chinese keywords (no preceding number)
  { re: /每\s*小时/, toMs: () => 60 * 60_000 },
  { re: /每\s*天/, toMs: () => 24 * 60 * 60_000 },

  // Chinese: "每N分钟" / "每N小时" / "每N天"
  { re: /每\s*(\d+)\s*分钟?/, toMs: (m) => parseInt(m[1], 10) * 60_000 },
  { re: /每\s*(\d+)\s*小时/, toMs: (m) => parseInt(m[1], 10) * 60 * 60_000 },
  { re: /每\s*(\d+)\s*天/, toMs: (m) => parseInt(m[1], 10) * 24 * 60 * 60_000 },

  // Chinese: bare "N分钟" / "N小时" / "N天" (no "每" prefix)
  { re: /(\d+)\s*分钟/, toMs: (m) => parseInt(m[1], 10) * 60_000 },
  { re: /(\d+)\s*小时/, toMs: (m) => parseInt(m[1], 10) * 60 * 60_000 },
  { re: /(\d+)\s*天/, toMs: (m) => parseInt(m[1], 10) * 24 * 60 * 60_000 },

  // English: "5 minutes" / "5min" — longest first so `minutes` wins over `min`
  { re: /(\d+)\s*(?:minutes|minute|mins|min)\b/i, toMs: (m) => parseInt(m[1], 10) * 60_000 },
  { re: /(\d+)\s*(?:hours|hour|hrs|hr)\b/i, toMs: (m) => parseInt(m[1], 10) * 60 * 60_000 },
  { re: /(\d+)\s*(?:days|day)\b/i, toMs: (m) => parseInt(m[1], 10) * 24 * 60 * 60_000 },

  // Single-letter units — matches `anet node loop --every 5m` shape.
  // Anchored so `5m` isn't accidentally swallowed by `5min` / `5mins`
  // (those patterns above run FIRST per declaration order and use
  // `\b` to terminate, so `5m` here only matches when not part of a
  // word like `5min`). Lookahead `(?![a-zA-Z])` prevents `5min` from
  // matching the `5m` rule. Lookbehind `(?<!\w)` prevents `pm5h`-like
  // surprises (no digit/letter immediately before the number).
  { re: /(?<!\w)(\d+)m(?![a-zA-Z])/i,   toMs: (m) => parseInt(m[1], 10) * 60_000 },
  { re: /(?<!\w)(\d+)h(?![a-zA-Z])/i,   toMs: (m) => parseInt(m[1], 10) * 60 * 60_000 },
  { re: /(?<!\w)(\d+)d(?![a-zA-Z])/i,   toMs: (m) => parseInt(m[1], 10) * 24 * 60 * 60_000 },
];

// Patterns we recognise as *invalid* (sub-minute units) — surface a clear
// rejection rather than letting the input fall through as "no interval".
const SUB_MINUTE_PATTERNS = [
  /\d+\s*(?:seconds|second|secs|sec|s)\b/i,
  /\d+\s*秒/,
];

export function parseGoalCommand(input: string): ParseResult {
  if (typeof input !== "string") return { ok: false, error: "input must be a string" };

  // `/aloop` is canonical and `/agoal` is its namespaced alias. Keep the
  // historical `/loop` + `/goal` prefixes parseable for the non-Dashboard
  // compatibility window; routing.ts decides whether a surface may use them.
  let body = input.replace(/^\s*\/(?:aloop|agoal|loop|goal)\b\s*/i, "").trim();
  if (!body) return { ok: false, error: "goal text is empty" };

  // Explicit sub-minute rejection so the error message is informative.
  for (const re of SUB_MINUTE_PATTERNS) {
    if (re.test(body)) {
      return {
        ok: false,
        error: `intervals shorter than ${MIN_INTERVAL_MS / 1000}s are not allowed (prevents wake-storm)`,
      };
    }
  }

  // Find the first matching interval. Patterns are tried in declared order,
  // which prioritises longer/more-specific tokens.
  let intervalMs: number | undefined;
  let intervalSpan: { start: number; end: number } | undefined;
  for (const { re, toMs } of INTERVAL_PATTERNS) {
    const m = re.exec(body);
    if (m) {
      intervalMs = toMs(m);
      intervalSpan = { start: m.index, end: m.index + m[0].length };
      break;
    }
  }

  if (intervalMs === undefined || !intervalSpan) {
    return {
      ok: false,
      error: 'no recognised interval in goal text (try "每5分钟…" or "…hourly" or "5min …")',
    };
  }

  // Defence-in-depth: even if a future pattern accidentally produces a
  // sub-minute value, refuse it.
  if (intervalMs < MIN_INTERVAL_MS) {
    return {
      ok: false,
      error: `interval ${intervalMs}ms is below the ${MIN_INTERVAL_MS}ms minimum`,
    };
  }

  // Strip the interval phrase out of the text so the remaining body reads
  // as the *goal description*, not "5min check progress" verbatim.
  const text = (body.slice(0, intervalSpan.start) + body.slice(intervalSpan.end))
    .replace(/\s+/g, " ")
    .trim();

  if (!text) {
    return { ok: false, error: "goal text is empty after removing the interval phrase" };
  }

  return { ok: true, goal: { text, interval_ms: intervalMs } };
}
