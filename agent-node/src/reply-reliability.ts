// #168 reply-reliability primitives — extracted from cli.ts so they can
// be unit-tested without spinning up the whole agent-node process.
//
// Three responsibilities live here:
//
//   1. `CommHubError` — typed error class that lets callers distinguish
//      transport / transient failures from app-level rejections.
//
//   2. `classifyCommHubResponse(data)` — pure classifier over a JSON-RPC
//      response payload. Returns the parsed application payload on
//      success; throws `CommHubError` when the server signalled an error
//      via the JSON-RPC error envelope, the MCP `result.isError` flag,
//      or an application-level `ok: false` field.
//
//   3. `PendingReplyQueue` — disk-backed queue keyed by `(to, task_id)`
//      that holds replies which could not be delivered immediately
//      because of transient failures. The queue is drained on every
//      `processInbox()` tick (and on process restart). Every serialization
//      crosses the shared credential redactor and is atomically written 0600.
//
// The design intent is that cli.ts wires these into the inbox loop with
// "persist before send, ack after deliver" ordering so a crash, an SSE
// drop, or a transient hub outage never silently loses a reply.

import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { randomBytes } from "crypto";
import {
  createCredentialRedactor,
  type CredentialRedactionOptions,
  type CredentialRedactor,
} from "./credential-redaction";

export class CommHubError extends Error {
  code?: number | string;
  payload?: any;
  /**
   * `true` if the server told us "no" with a structured reason
   * (e.g. #212 duplicate_send, send_reply to a closed task, target
   * offline). Non-retryable — retrying would not change the outcome.
   *
   * `false` for transport / transient failures (HTTP 5xx, JSON-RPC
   * envelope error, MCP `result.isError`). Worth retrying with backoff.
   */
  appLevel: boolean;

  constructor(
    message: string,
    opts: { code?: number | string; payload?: any; appLevel?: boolean } = {},
  ) {
    super(message);
    this.name = "CommHubError";
    this.code = opts.code;
    this.payload = opts.payload;
    this.appLevel = opts.appLevel ?? false;
  }
}

export type ClassifyResult =
  | { kind: "ok"; payload: any }
  | { kind: "retryable"; error: CommHubError }
  | { kind: "appLevel"; error: CommHubError };

/**
 * Classify a parsed JSON-RPC response from commhub. This is the core of
 * the #168 RC-B1 + RC-B2 fix — the prior implementation accepted any
 * HTTP-200 response as success, silently masking three distinct server
 * failure modes that the designer-poster incident on 2026-05-21 exposed.
 *
 * The classifier is pure — it does no I/O, no retries, no logging. The
 * caller wraps this in their retry/backoff loop and observability.
 *
 * On `kind: "ok"` the caller forwards `payload` to the application.
 * On `kind: "retryable"` the caller may retry with backoff; if the retry
 * budget is exhausted, throw the contained error.
 * On `kind: "appLevel"` the caller must NOT retry; surface the error
 * directly so it can be routed (e.g. to the pending-reply queue's
 * drop-loud branch).
 */
export function classifyCommHubResponse(data: any): ClassifyResult {
  // Failure mode A — JSON-RPC error envelope. SQLite WAL busy, MCP
  // transport hiccup, etc. typically arrive here as a numeric -32xxx
  // code; retry.
  if (data?.error) {
    const msg = `${data.error.code ?? "?"}: ${data.error.message ?? "no message"}`;
    return {
      kind: "retryable",
      error: new CommHubError(`JSON-RPC error: ${msg}`, {
        code: data.error.code,
        payload: data.error,
      }),
    };
  }

  // Failure mode B — MCP result.isError. Tool said "no" inside a
  // successful JSON-RPC envelope. Treat as retryable since the
  // distinction between transient (server overload echoed as isError)
  // and permanent (app reject) lives in the content, not the flag.
  if (data?.result?.isError === true) {
    const text = data?.result?.content?.[0]?.text || "tool returned isError";
    // Older MCP servers surface an unknown tool as a successful JSON-RPC
    // envelope whose tool result isError text contains the protocol code,
    // e.g. `MCP error -32602: Tool send_peer_reply not found`. Preserve that
    // code so capability negotiation can distinguish a genuinely old Hub
    // from a transient tool failure without retrying forever.
    const mcpCode = typeof text === "string"
      ? text.match(/\bMCP error\s+(-?\d+)\s*:/i)?.[1]
      : undefined;
    return {
      kind: "retryable",
      error: new CommHubError(`tool isError: ${text.slice(0, 200)}`, {
        ...(mcpCode !== undefined ? { code: Number(mcpCode) } : {}),
        payload: data.result,
      }),
    };
  }

  // Unwrap the MCP tool payload — content[0].text is JSON-encoded.
  const text = data?.result?.content?.[0]?.text;
  let parsed: any;
  if (typeof text === "string") {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Tool returned non-JSON content; pass it through verbatim so
      // legacy callers that expect prose still work.
      return { kind: "ok", payload: text };
    }
  } else {
    parsed = data;
  }

  // Failure mode C — application-level rejection. Non-retryable.
  // Examples: #212 duplicate_send, send_reply to closed task, target
  // offline. Surface immediately so the caller can drop the reply or
  // route it elsewhere without burning retry budget.
  if (parsed && typeof parsed === "object" && parsed.ok === false) {
    const detail = parsed.error || parsed.message || "no detail";
    return {
      kind: "appLevel",
      error: new CommHubError(`app-level rejection: ${detail}`, {
        code: parsed.error,
        payload: parsed,
        appLevel: true,
      }),
    };
  }

  return { kind: "ok", payload: parsed };
}

// ── Pending-reply queue ──────────────────────────────────────────────

export type PendingReply = {
  to: string;
  text: string;
  taskId?: string;
  failed: boolean;
  queuedAt: number;
  lastTryAt?: number;
  lastError?: string;
  attempts: number;
};

export interface PendingReplyQueueOptions extends CredentialRedactionOptions {
  /** Reuse the process-wide log/persistence redactor when one already exists. */
  redactor?: CredentialRedactor;
}

/**
 * Deterministic 32-char hash for queue dedup keys when no task_id is
 * available. Not cryptographic — collisions only matter inside one
 * node's outbound queue, which is tiny.
 */
export function quickHash(s: string): string {
  let h1 = 0xdeadbeef ^ 0x9e3779b9;
  let h2 = 0x41c6ce57 ^ 0x9e3779b9;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0))
    .toString(16)
    .padStart(16, "0")
    .repeat(2)
    .slice(0, 32);
}

/**
 * Disk-backed FIFO-ish queue of pending replies. Each entry is keyed by
 * `(to, taskId)`; persisting an entry that matches an existing key
 * overwrites it (preserving the original attempt counter).
 *
 * All methods are synchronous because the queue lives next to the node's
 * config.json and the I/O is tiny.
 */
export class PendingReplyQueue {
  private readonly redactor: CredentialRedactor;

  constructor(
    private readonly filePath: string,
    redaction: PendingReplyQueueOptions = {},
  ) {
    this.redactor = redaction.redactor ?? createCredentialRedactor(redaction);
  }

  load(): PendingReply[] {
    if (!existsSync(this.filePath)) return [];
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Older direct-write versions could leave a truncated file after a
      // crash.  They already treated it as an empty queue; replace it rather
      // than retaining arbitrary (possibly credential-bearing) bytes.
      this.writeAtomic([]);
      return [];
    }

    if (!Array.isArray(parsed)) {
      this.writeAtomic([]);
      return [];
    }
    const sanitized = this.sanitize(parsed as PendingReply[]);
    const changed = JSON.stringify(parsed) !== JSON.stringify(sanitized);
    const mode = statSync(this.filePath).mode & 0o777;

    // Security migration for queue files written by older versions: scrub
    // their content at the first read and repair broad modes.  Do not merely
    // return a cleaned in-memory copy while leaving credential bytes on disk.
    if (changed) this.writeAtomic(sanitized);
    else if (mode !== 0o600) chmodSync(this.filePath, 0o600);
    return sanitized;
  }

  save(items: PendingReply[]): void {
    // Scrub at the final serialization boundary so callers cannot bypass it
    // by calling save() directly.  writeAtomic uses a fresh 0600 sibling,
    // fsyncs it, and then renames it over the queue.
    this.writeAtomic(this.sanitize(items));
  }

  private sanitize<T>(value: T): T {
    return this.redactor.redactValue(value);
  }

  private writeAtomic(items: PendingReply[]): void {
    const tmp = `${this.filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    let fd: number | undefined;
    try {
      // wx prevents a pre-created sibling/symlink from redirecting the write.
      fd = openSync(tmp, "wx", 0o600);
      fchmodSync(fd, 0o600);
      writeFileSync(fd, JSON.stringify(items, null, 2), "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tmp, this.filePath);
      // The temp inode is already 0600; reinforce the postcondition for
      // platforms/filesystems with unusual rename mode behaviour.
      chmodSync(this.filePath, 0o600);
    } catch (e) {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* ignore */ }
      }
      try { unlinkSync(tmp); } catch { /* ignore */ }
      throw e;
    }
  }

  /**
   * Add or update a pending reply. Idempotent on `(to, taskId)`: if an
   * entry already exists for the same key, its attempt counter is
   * preserved and the body/timestamp fields are refreshed.
   */
  persist(entry: Omit<PendingReply, "attempts">): void {
    const sanitized = this.sanitize(entry);
    const items = this.load();
    const idx = this.findIndex(items, sanitized.to, sanitized.taskId, sanitized.text);
    if (idx >= 0) {
      items[idx] = { ...items[idx], ...sanitized, attempts: items[idx].attempts };
    } else {
      items.push({ ...sanitized, attempts: 0 });
    }
    this.save(items);
  }

  /** Remove an entry by (to, taskId). No-op if not found. */
  clear(to: string, taskId?: string): void {
    if (!taskId) return;
    const items = this.load();
    const key = `${to}|task:${taskId}`;
    const next = items.filter((p) => keyFor(p) !== key);
    if (next.length !== items.length) this.save(next);
  }

  /**
   * Try to send every queued entry through `attempt`. Returns counters
   * for caller-side logging. Entries that succeed are removed. Entries
   * that fail with an app-level CommHubError are dropped (server told
   * us "no" with a reason — retrying would not help). Entries that fail
   * transiently stay queued with their attempt counter bumped.
   */
  async drain(attempt: (entry: PendingReply) => Promise<void>): Promise<{
    delivered: number;
    dropped: number;
    requeued: number;
  }> {
    const items = this.load();
    let delivered = 0;
    let dropped = 0;
    const remaining: PendingReply[] = [];

    for (const entry of items) {
      try {
        await attempt(entry);
        delivered++;
      } catch (e: any) {
        if (e instanceof CommHubError && e.appLevel) {
          dropped++;
          continue;
        }
        remaining.push({
          ...entry,
          attempts: entry.attempts + 1,
          lastTryAt: Date.now(),
          lastError: e?.message ?? String(e),
        });
      }
    }

    // Persist the new state whenever ANYTHING happened — including a
    // pure transient-failure round where the only change is the
    // attempts counter / lastError on the requeued entries. Skipping
    // the save in that case would lose the retry-state across restarts.
    if (items.length > 0) this.save(remaining);
    return { delivered, dropped, requeued: remaining.length };
  }

  private findIndex(items: PendingReply[], to: string, taskId?: string, text?: string): number {
    const key = taskId ? `${to}|task:${taskId}` : `${to}|sha:${quickHash(text ?? "")}`;
    return items.findIndex((p) => keyFor(p) === key);
  }
}

function keyFor(p: PendingReply): string {
  return p.taskId ? `${p.to}|task:${p.taskId}` : `${p.to}|sha:${quickHash(p.text)}`;
}
