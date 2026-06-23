// #212 — commhub-server send_task dedup guardrail.
//
// Vincent's A站Grok ran away on 2026-06-10 and sent the same task to the
// same target 50+ times within five LLM turns (4692 chunks in a single
// turn). It ignored three STOP replies — by the time a reply landed back
// in its inbox the LLM had already decided to dispatch again. The dispatch
// path was the agent's own commhub_send_task MCP tool call against
// commhub-server's HTTP MCP transport (#204 preview.6 wiring), so the
// agent-node runtime never saw the bytes and could not intervene
// client-side.
//
// This module is the server-side guardrail: any `send_task` (whether
// through MCP `tools/call` or the REST `/api/task` endpoint) is checked
// against an in-memory dedup index keyed by `(from_session, target_alias,
// sha256(content))`. A second call to the same key within the configured
// window is rejected with a structured `duplicate_send` error containing
// a human-readable hint the LLM can act on ("change the task content or
// wait").
//
// Design notes:
//   - Keyed by content hash, not the raw content, so we never hold the
//     task body in memory longer than the request itself.
//   - In-memory only. Process restart wipes the index, which is the
//     desired failure mode (servers restart far more rarely than the
//     5-minute default window, and a fresh window after restart is safer
//     than rehydrating from disk).
//   - Opportunistic eviction during every `shouldDedup` call keeps the
//     map bounded without a separate sweep timer.
//   - Window = 0 disables the guardrail entirely (escape hatch for the
//     rare cases where a workflow genuinely needs to fan out the same
//     task repeatedly — e.g. a batch sweep that produces identical
//     payloads by design).
//   - The structured response shape is identical between MCP and REST
//     callers so the LLM gets the same parseable hint regardless of
//     transport.

import { createHash } from "crypto";

export type DedupConfig = {
  /** Window in ms; 0 disables guardrail. Default 300000 (5 min). */
  windowMs: number;
  /** Max keys to retain; opportunistically evicted past this. Default 4096. */
  maxKeys: number;
};

export function readDedupConfig(env: NodeJS.ProcessEnv = process.env): DedupConfig {
  // Parse-then-validate-then-clamp: `Number("abc")` is NaN and `Math.max(0, NaN)`
  // is ALSO NaN per spec, so the old inline `Math.max(0, Number(rawWindow))`
  // relied on the later `Number.isFinite` fallback to repair the result.
  // Hoisting the validity check first makes the intent explicit and removes
  // the risk that a future refactor drops the `isFinite` rescue.
  const parseClamped = (raw: string | undefined, min: number, fallback: number): number => {
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, n);
  };
  return {
    windowMs: parseClamped(env.COMMHUB_SEND_DEDUP_WINDOW_MS, 0, 300_000),
    maxKeys: parseClamped(env.COMMHUB_SEND_DEDUP_MAX_KEYS, 64, 4096),
  };
}

export type DedupCheck =
  | { duplicate: false }
  | { duplicate: true; lastSentMs: number; ageMs: number };

export class SendDedup {
  private last = new Map<string, number>();
  private cfg: DedupConfig;

  constructor(cfg: Partial<DedupConfig> = {}) {
    const fallback = readDedupConfig();
    this.cfg = { windowMs: cfg.windowMs ?? fallback.windowMs, maxKeys: cfg.maxKeys ?? fallback.maxKeys };
  }

  /** Whether the dedup guardrail is enabled at all. */
  get enabled(): boolean {
    return this.cfg.windowMs > 0;
  }

  get windowMs(): number {
    return this.cfg.windowMs;
  }

  /** Visible for tests only. */
  get size(): number {
    return this.last.size;
  }

  static key(from: string, to: string, content: string): string {
    const hash = createHash("sha256").update(content).digest("hex");
    return `${from}|${to}|${hash}`;
  }

  /**
   * Check whether (from, to, content) was sent recently. Returns
   * `{ duplicate: false }` when the call should proceed, or
   * `{ duplicate: true, lastSentMs, ageMs }` when the caller should be
   * rejected with a `duplicate_send` error.
   *
   * Does NOT record the new send — callers should call `record(...)`
   * AFTER the underlying side effect (inbox insert + pushEvent) succeeds,
   * so failed sends don't accidentally block legitimate retries.
   */
  check(from: string, to: string, content: string, nowMs: number = Date.now()): DedupCheck {
    if (!this.enabled) return { duplicate: false };
    this.evictExpired(nowMs);
    const k = SendDedup.key(from, to, content);
    const lastSentMs = this.last.get(k);
    if (lastSentMs === undefined) return { duplicate: false };
    const ageMs = nowMs - lastSentMs;
    if (ageMs >= this.cfg.windowMs) {
      this.last.delete(k);
      return { duplicate: false };
    }
    return { duplicate: true, lastSentMs, ageMs };
  }

  /** Record a successful send for future dedup checks. */
  record(from: string, to: string, content: string, nowMs: number = Date.now()): void {
    if (!this.enabled) return;
    const k = SendDedup.key(from, to, content);
    this.last.set(k, nowMs);
    if (this.last.size > this.cfg.maxKeys) this.evictOldest();
  }

  /** Visible for tests. Drops everything. */
  clear(): void {
    this.last.clear();
  }

  private evictExpired(nowMs: number): void {
    const cutoff = nowMs - this.cfg.windowMs;
    for (const [k, ts] of this.last) {
      if (ts < cutoff) this.last.delete(k);
    }
  }

  private evictOldest(): void {
    const target = Math.max(64, Math.floor(this.cfg.maxKeys * 0.9));
    if (this.last.size <= target) return;
    // CACHE toDelete BEFORE the deletion loop. Previously the loop bound
    // was `i < this.last.size - target`, which is re-evaluated every
    // iteration — and `this.last.size` shrinks by 1 per delete. The result
    // was that we only evicted ~half of the intended count (size landed
    // around 95 % of maxKeys instead of the documented ~90 %). The map
    // stayed bounded so this was efficiency-only, not a leak, but the
    // documented contract was being violated.
    const toDelete = this.last.size - target;
    const entries = Array.from(this.last.entries()).sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < toDelete; i++) this.last.delete(entries[i][0]);
  }
}

// Process-wide singleton consumed by both the MCP `send_task` tool and
// the REST `/api/task` endpoint so they share a single dedup index
// regardless of which transport the agent hits. Tests reach for it via
// `sharedSendDedup.clear()` to reset between cases.
export const sharedSendDedup = new SendDedup();

/**
 * Build the structured `duplicate_send` error payload returned to the
 * caller (MCP wraps it inside `content[0].text` JSON; REST returns it
 * directly with HTTP 429). The Chinese hint matches what 通信龙 specified
 * in the #212 dispatch so the LLM has a consistent piece of text to
 * reason about and rewrite around.
 */
export function buildDuplicateSendPayload(args: {
  from: string;
  to: string;
  ageMs: number;
  windowMs: number;
}): {
  ok: false;
  error: "duplicate_send";
  message: string;
  details: {
    from: string;
    target: string;
    age_ms: number;
    window_ms: number;
    hint_zh: string;
    hint_en: string;
  };
} {
  const windowMin = Math.round(args.windowMs / 60_000);
  const hintZh =
    `同内容任务 ${windowMin} 分钟内已发给 ${args.to}, ` +
    `如确需重发请改写内容或等待。 (Last sent ${args.ageMs}ms ago)`;
  const hintEn =
    `Same task content already sent to ${args.to} within the last ` +
    `${windowMin} min — change the content or wait. (Last sent ${args.ageMs}ms ago)`;
  return {
    ok: false,
    error: "duplicate_send",
    message: hintZh,
    details: {
      from: args.from,
      target: args.to,
      age_ms: args.ageMs,
      window_ms: args.windowMs,
      hint_zh: hintZh,
      hint_en: hintEn,
    },
  };
}
