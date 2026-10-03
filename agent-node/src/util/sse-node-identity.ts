// #507 — agent-node side of "at most one live copy per node identity".
//
// Hub (#2299) keeps only the NEWEST node-token SSE stream per
// `${network}:${alias}` and sends the older one a final frame:
//
//   { type: "node_connection_superseded",
//     reason: "superseded_by_new_connection" | "replaced_by_reconnect",
//     instance_match: "same" | "different" | "unknown",
//     by: { instance_id, remote } }
//
// `replaced_by_reconnect` is sent only when both connections carried the SAME
// instance id — i.e. this very process reconnected and the Hub reaped its old
// half-open stream. Nothing is wrong; behave exactly as before.
//
// `superseded_by_new_connection` means a DIFFERENT process (a copied node
// directory started elsewhere, same token + alias) took the stream. With the
// default 1 s SSE reconnect the two copies would steal the stream from each
// other every second ("flapping") and both would keep draining the inbox. So
// the superseded copy:
//   1. logs a loud error naming the alias (never a token),
//   2. waits 30 s → 60 s → … capped at 10 min before reconnecting,
//   3. stops fetching inbox rows until its own stream is back (see
//      `inboxSuspended`) — the copy that holds the stream owns the inbox.
//
// Older Hubs never send the frame, so none of this triggers there.
//
// The instance id is per process (random, stable for the process's life) and
// is sent as `X-Anet-Instance-Id` on every SSE connect. It must match the
// Hub's INSTANCE_ID_RE (`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`) or the Hub
// silently treats it as absent.

import { randomUUID } from "node:crypto";

export const NODE_CONNECTION_SUPERSEDED = "node_connection_superseded";
export const SUPERSEDED_BY_NEW_CONNECTION = "superseded_by_new_connection";
export const REPLACED_BY_RECONNECT = "replaced_by_reconnect";
export const INSTANCE_ID_HEADER = "X-Anet-Instance-Id";

/** Same shape the Hub accepts (server/src/server.ts INSTANCE_ID_RE). */
export const INSTANCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** A fresh per-process instance id. Random — never derived from the token. */
export function generateInstanceId(uuid: () => string = randomUUID): string {
  const id = `an-${uuid()}`;
  if (!INSTANCE_ID_RE.test(id)) throw new Error(`generated instance id does not match the Hub's format: ${id}`);
  return id;
}

/** Headers for the node's own `/events/<alias>` stream. */
export function buildNodeSseHeaders(authToken: string | null | undefined, instanceId: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "text/event-stream",
    "Cache-Control": "no-cache",
    [INSTANCE_ID_HEADER]: instanceId,
  };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  return headers;
}

export type SupersededFrame = {
  reason: string;
  instanceMatch: string | null;
  byInstanceId: string | null;
  byRemote: string | null;
};

/** null unless `ev` is a node_connection_superseded frame. */
export function parseSupersededFrame(ev: unknown): SupersededFrame | null {
  if (!ev || typeof ev !== "object") return null;
  const e = ev as Record<string, unknown>;
  if (e.type !== NODE_CONNECTION_SUPERSEDED) return null;
  const by = (e.by && typeof e.by === "object" ? e.by : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    reason: str(e.reason) ?? SUPERSEDED_BY_NEW_CONNECTION,
    instanceMatch: str(e.instance_match),
    byInstanceId: str(by.instance_id),
    byRemote: str(by.remote),
  };
}

export type SupersedeDecision =
  /** Same process reconnected; reconnect on the normal schedule, log only. */
  | { kind: "reconnect" }
  /** Another copy holds the stream; wait at least `waitMs` before reconnecting. */
  | { kind: "back_off"; waitMs: number; streak: number };

export type SupersedeBackoffOpts = {
  /** First wait after being superseded. Default 30 s. */
  baseMs?: number;
  /** Cap. Default 10 min. */
  maxMs?: number;
  /** A connection that survived this long before being superseded resets the
   *  streak (the duplicate went away for a while). Default 10 min. */
  streakResetMs?: number;
};

export const SUPERSEDE_BACKOFF_BASE_MS = 30_000;
export const SUPERSEDE_BACKOFF_MAX_MS = 10 * 60_000;

/**
 * Per-process state machine for the superseded path. Pure (time injected) so
 * the backoff schedule is testable without timers.
 */
export class SupersedeBackoff {
  readonly baseMs: number;
  readonly maxMs: number;
  readonly streakResetMs: number;
  private streak = 0;
  private connectedAt: number | null = null;
  private suspended = false;

  constructor(opts: SupersedeBackoffOpts = {}) {
    this.baseMs = opts.baseMs ?? SUPERSEDE_BACKOFF_BASE_MS;
    this.maxMs = opts.maxMs ?? SUPERSEDE_BACKOFF_MAX_MS;
    this.streakResetMs = opts.streakResetMs ?? SUPERSEDE_BACKOFF_MAX_MS;
  }

  /** The Hub sent `connected` on our stream: we own it again. */
  noteConnected(now: number): void {
    this.connectedAt = now;
    this.suspended = false;
  }

  onSuperseded(frame: SupersededFrame, now: number): SupersedeDecision {
    if (frame.reason === REPLACED_BY_RECONNECT) return { kind: "reconnect" };
    if (this.connectedAt !== null && now - this.connectedAt >= this.streakResetMs) this.streak = 0;
    this.streak += 1;
    this.connectedAt = null;
    this.suspended = true;
    const waitMs = Math.min(this.baseMs * 2 ** (this.streak - 1), this.maxMs);
    return { kind: "back_off", waitMs, streak: this.streak };
  }

  /** True between "another copy took our stream" and our next `connected`.
   *  While true this copy must not fetch inbox rows: the stream holder owns them. */
  get inboxSuspended(): boolean {
    return this.suspended;
  }

  get supersededStreak(): number {
    return this.streak;
  }
}

/** The error line a superseded copy prints. Alias + network origin only; no token. */
export function formatSupersededError(alias: string, myInstanceId: string, frame: SupersededFrame, waitMs: number, streak: number): string {
  const where = frame.byRemote ? ` from ${frame.byRemote}` : "";
  const other = frame.byInstanceId ? ` (instance ${frame.byInstanceId})` : " (instance id not reported — older agent-node?)";
  return `[node-identity] another copy of node "${alias}" is running and took this node's Hub stream${where}${other}; ` +
    `this copy is instance ${myInstanceId}. Two processes share one node identity (copied node directory?) — ` +
    `stop one of them. This copy stops taking inbox work and reconnects in ${Math.round(waitMs / 1000)}s ` +
    `(superseded ${streak}x in a row, backoff capped at ${Math.round(SUPERSEDE_BACKOFF_MAX_MS / 60_000)} min).`;
}
