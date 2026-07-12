// RFC-030 Wave 1B L3-R5 — upstream SESSION reconnect manager: eager boot +
// capped exponential backoff (B owns lifecycle.ts per A's protocol notes:
// "lifecycle.ts owns rejecting internal scheduler Promises after
// drainAll", "B / lifecycle.ts owns the concrete currentSnapshot()").
//
// Semantics:
//   - EAGER boot (dispatch item 4): `start()` opens the app-server session
//     immediately — not lazily on the first task — so the version/schema/
//     profile gates fire at node start and a broken baseline is visible
//     right away, not at first dispatch.
//   - Reconnect: on session loss the lifecycle (1) drains A's mux entirely
//     (upstream restart ⇒ every outstanding id is dead — proxied-TUI AND
//     internal) and reports how many internal resolvers were dropped,
//     (2) re-opens with exponential backoff + full jitter, capped, and
//     (3) NEVER resends anything itself — recovery of in-flight task
//     attempts is the ledger's `recover()` job, honoring no-blind-resend.
//   - Overload退避: repeated open failures stretch the delay (factor 2 up
//     to maxMs); a successful open resets the backoff to the initial step.
//   - `stop()` closes cleanly and suppresses the reconnect loop.
//
// The opener is dependency-injected (production: openCodexAppServerRuntime
// with its fail-closed gates). No env knobs — a config bypass would gut
// the gates.

import type { UpstreamRequestMux } from "./protocol";

export interface LifecycleSessionLike {
  /** EventEmitter surface of the underlying client ("close" events). */
  client: {
    on(event: "close", fn: (info: { code: number | null; reason: string }) => void): unknown;
  };
  threadId: string;
  readonly isRunning: boolean;
}

export interface SessionReconnectOptions<S extends LifecycleSessionLike> {
  /** Opens a fresh session — production passes openCodexAppServerRuntime
   *  (all Phase-1/baseline gates included). Throws on gate failure. */
  open: () => Promise<S>;
  /** A's shared mux — drained (drainAll) on upstream loss. */
  mux?: UpstreamRequestMux<unknown>;
  /** Called after every successful (re)open with the fresh session. */
  onSession?: (session: S, info: { reopenCount: number }) => void | Promise<void>;
  /** Called when the upstream is lost, before the backoff sleep. */
  onDisconnect?: (info: { droppedMuxPending: number; attempt: number }) => void;
  /** Connection-state hook (mirrors RuntimeStateEvent.connection). */
  onStateChange?: (state: "starting" | "running" | "recovering" | "disconnected") => void;
  backoff?: {
    initialMs?: number;
    maxMs?: number;
    factor?: number;
  };
  /** Injectable sleep + rng for tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  log?: (msg: string) => void;
  /** Give up after this many consecutive failed reopen attempts (0 = never). */
  maxConsecutiveFailures?: number;
}

export class SessionReconnectManager<S extends LifecycleSessionLike> {
  private readonly opts: SessionReconnectOptions<S>;
  private readonly initialMs: number;
  private readonly maxMs: number;
  private readonly factor: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly log: (msg: string) => void;

  private session: S | null = null;
  private stopped = false;
  private reopenCount = 0;
  private loopRunning = false;

  /** Delays actually used (exposed for tests / diagnostics). */
  readonly delaysUsed: number[] = [];

  constructor(opts: SessionReconnectOptions<S>) {
    this.opts = opts;
    this.initialMs = opts.backoff?.initialMs ?? 500;
    this.maxMs = opts.backoff?.maxMs ?? 30_000;
    this.factor = opts.backoff?.factor ?? 2;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
    this.log = opts.log ?? (() => {});
  }

  current(): S | null {
    return this.session;
  }

  /** EAGER boot: open now; throws if the very first open fails its gates
   *  (fail closed at node start — no silent lazy retry into a broken
   *  baseline). Reconnects after a once-successful boot DO retry. */
  async start(): Promise<S> {
    this.opts.onStateChange?.("starting");
    const s = await this.opts.open(); // gate failures propagate — fail closed
    this.adopt(s);
    return s;
  }

  stop(): void {
    this.stopped = true;
    this.opts.onStateChange?.("disconnected");
  }

  private adopt(s: S): void {
    this.session = s;
    this.opts.onStateChange?.("running");
    void this.opts.onSession?.(s, { reopenCount: this.reopenCount });
    s.client.on("close", () => {
      if (this.stopped) return;
      void this.reconnectLoop();
    });
  }

  private async reconnectLoop(): Promise<void> {
    if (this.loopRunning) return;
    this.loopRunning = true;
    this.session = null;
    this.opts.onStateChange?.("recovering");

    // Upstream restart: EVERYTHING outstanding on the old socket is dead.
    // drainAll is lifecycle's call (never the client's) — proxied-TUI and
    // internal alike; the count is surfaced so operators see the churn.
    const dropped = this.opts.mux?.pendingCount() ?? 0;
    this.opts.mux?.drainAll();

    let attempt = 0;
    let delay = this.initialMs;
    try {
      // eslint-disable-next-line no-constant-condition
      while (!this.stopped) {
        attempt++;
        this.opts.onDisconnect?.({ droppedMuxPending: dropped, attempt });
        // Full jitter: uniform in [delay/2, delay] — avoids thundering herd
        // while keeping the cap meaningful.
        const jittered = Math.floor(delay / 2 + this.random() * (delay / 2));
        this.delaysUsed.push(jittered);
        await this.sleep(jittered);
        if (this.stopped) return;
        try {
          const s = await this.opts.open();
          this.reopenCount++;
          this.log(`[lifecycle] reconnected (reopen #${this.reopenCount}, attempt ${attempt})`);
          this.adopt(s);
          return;
        } catch (e) {
          this.log(
            `[lifecycle] reopen attempt ${attempt} failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`,
          );
          const max = this.opts.maxConsecutiveFailures ?? 0;
          if (max > 0 && attempt >= max) {
            this.opts.onStateChange?.("disconnected");
            return;
          }
          delay = Math.min(delay * this.factor, this.maxMs); // overload退避
        }
      }
    } finally {
      this.loopRunning = false;
    }
  }
}
