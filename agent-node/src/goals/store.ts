// Phase 1 of #184 — GoalStore: single-writer persistence for `goals.json`.
//
// Design points addressed (per 通信牛 design review):
//   #1 Single write entry — every mutation goes through `_flush()`, which
//      writes `goals.json.tmp.<pid>.<uuid>` then `rename()`s into place.
//      POSIX rename is atomic on the same filesystem, so a reader either
//      sees the old file or the new file, never a half-written one.
//   #2 Corruption recovery — `load()` returns `{ ok: false, recovered }`
//      when the existing file fails to parse or has an unknown schema.
//      The corrupt bytes are preserved at `<path>.corrupt.<iso-ts>` and the
//      store starts empty so agent-node startup is never blocked.
//   #3 In-process mutex — Bun/Node is single-threaded but `await` inside
//      a read-modify-write is a yield point; a promise-chain `Mutex`
//      serialises mutating callers so the scheduler tick (Phase 2) cannot
//      race with `/goal cancel` / `/goal complete` from the inbox loop.

import { readFileSync, writeFileSync, renameSync, existsSync, copyFileSync, mkdirSync, unlinkSync } from "fs";
import { dirname } from "path";
import { randomUUID } from "crypto";
import type { AgentGoal, GoalStatus, GoalsFile } from "./types";
import { GOALS_SCHEMA_VERSION } from "./types";

// #144 round-6 — runtime bucket mapping (no more "claude is special" gate).
//
// History: v0.4 §3.4 P0 (#184 commit 45c7909) introduced a runtime gate
// that rejected the claude bucket entirely, on the assumption that
// claude-agent-sdk agents use Claude Code's native /loop (CronCreate +
// ScheduleWakeup skill). That assumption is FALSE for SDK-spawned claude:
// `processWithClaude` invokes `query()` from @anthropic-ai/claude-agent-sdk
// which is a one-shot Promise — not a long-running interactive REPL — so
// the native /loop machinery (which requires a persistent CC session) has
// no host to fire from. The result was: claude-agent-sdk users sent /loop
// commands that were silently rejected at the inbox gate and never wired
// to anything; "loop doesn't fire" for that runtime.
//
// Refined-B (this PR): no per-bucket scheduler skip. ALL recognized
// runtimes get the anet scheduler. The bucket helpers stay for the
// remaining concern that's still real — codex thread IDs are NOT
// translatable to grok and vice versa, so a node that switches SDK
// runtime mid-life shouldn't silently re-feed old thread IDs across
// SDK boundaries. The cross-bucket recovery is now "archive + skip"
// (formerly hostile-UX `fatal exit(1)` that crashed the node without
// guidance).
//
// Recognized names mirror cli.ts:280 RUNTIME_MAP.
const CLAUDE_RUNTIME_NAMES = new Set([
  "claude",
  "claude-agent-sdk",
  "claude-sdk",
  "agent-sdk",
]);

const CODEX_RUNTIME_NAMES = new Set([
  "codex",
  "codex-sdk",
  // RFC-030 — codex TUI bridge (standalone `codex app-server`). Same
  // non-claude bucket as codex-sdk: it has a native host process, so
  // self-loop management is host-driven (not the SDK-spawned claude path).
  "codex-app-server",
  "codex-appserver",
  "codex-tui",
]);

const GROK_RUNTIME_NAMES = new Set([
  "grok",
  "grok-build-acp",
  "grok-build",
]);

// RFC-029 — public sst/opencode CLI. `opencode-cli` is the canonical
// launcher name; `opencode` is the internal bucket + short alias.
const OPENCODE_RUNTIME_NAMES = new Set([
  "opencode",
  "opencode-cli",
]);

export type RuntimeBucket = "claude" | "codex" | "grok" | "opencode" | "unknown";

/** Map any user-facing runtime name to its canonical bucket (mirrors cli.ts RUNTIME_MAP). */
export function runtimeBucket(rt: string | undefined | null): RuntimeBucket {
  if (!rt) return "unknown";
  if (CLAUDE_RUNTIME_NAMES.has(rt)) return "claude";
  if (CODEX_RUNTIME_NAMES.has(rt)) return "codex";
  if (GROK_RUNTIME_NAMES.has(rt)) return "grok";
  if (OPENCODE_RUNTIME_NAMES.has(rt)) return "opencode";
  return "unknown";
}

export function isClaudeRuntime(rt: string | undefined | null): boolean {
  return runtimeBucket(rt) === "claude";
}

// Promise-chain mutex. Every `lock()` waits for the previous one to
// settle, so callers run strictly in arrival order. Errors thrown inside
// the critical section release the lock (no deadlock on failure).
class Mutex {
  private chain: Promise<void> = Promise.resolve();
  async lock<T>(fn: () => Promise<T> | T): Promise<T> {
    const prev = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>((resolve) => { release = resolve; });
    try {
      await prev;
      return await fn();
    } finally {
      release();
    }
  }
}

export interface LoadResult {
  ok: boolean;
  /** path of the preserved corrupt file (set when ok=false) */
  recovered?: string;
  /** error message (set when ok=false) */
  error?: string;
}

export class GoalStore {
  private goals: Map<string, AgentGoal> = new Map();
  private mutex = new Mutex();
  private loaded = false;

  constructor(private readonly filePath: string) {}

  /** Path the store reads from / writes to (for diagnostics). */
  get path(): string {
    return this.filePath;
  }

  /**
   * Read `goals.json` from disk. Safe to call multiple times — repeated
   * loads do not re-import; once loaded the in-memory map is authoritative.
   *
   * Returns `{ ok: true }` on success (including the empty/no-file case).
   * On corruption, returns `{ ok: false, recovered }` and starts the
   * store in an empty state so the host process can continue.
   */
  async load(): Promise<LoadResult> {
    return this.mutex.lock(() => this._loadSync());
  }

  private _loadSync(): LoadResult {
    if (this.loaded) return { ok: true };

    if (!existsSync(this.filePath)) {
      this.loaded = true;
      return { ok: true };
    }

    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf-8");
    } catch (e: any) {
      this.loaded = true;
      return { ok: false, error: `read failed: ${e?.message || e}` };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e: any) {
      const backup = this._preserveCorrupt(raw);
      this.loaded = true;
      return { ok: false, recovered: backup, error: `invalid JSON: ${e?.message || e}` };
    }

    const file = parsed as GoalsFile | null;
    if (!file || file.version !== GOALS_SCHEMA_VERSION || !Array.isArray(file.goals)) {
      const backup = this._preserveCorrupt(raw);
      this.loaded = true;
      return {
        ok: false,
        recovered: backup,
        error: `unknown schema (expected version=${GOALS_SCHEMA_VERSION})`,
      };
    }

    for (const g of file.goals) {
      if (g && typeof g.goal_id === "string") this.goals.set(g.goal_id, g);
    }
    this.loaded = true;
    return { ok: true };
  }

  private _preserveCorrupt(_raw: string): string | undefined {
    // We re-read from disk via copy rather than re-write the buffer so the
    // bytes match exactly (no JSON re-stringify, no encoding round-trip).
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const backup = `${this.filePath}.corrupt.${ts}`;
      copyFileSync(this.filePath, backup);
      return backup;
    } catch {
      return undefined;
    }
  }

  /** Snapshot of all goals (in insertion order). */
  async list(): Promise<AgentGoal[]> {
    return this.mutex.lock(() => Array.from(this.goals.values()));
  }

  async get(goal_id: string): Promise<AgentGoal | undefined> {
    return this.mutex.lock(() => this.goals.get(goal_id));
  }

  /**
   * Insert or replace a goal. Bumps `updated_at` and flushes to disk
   * atomically before returning.
   *
   * #144: no runtime gate. The pre-#144 `assertNonClaudeRuntime(goal.runtime)`
   * check was removed because the claude-bucket "skip" premise was false
   * (SDK-spawned claude has no native /loop host — see runtimeBucket
   * comment above for the full rationale).
   */
  async upsert(goal: AgentGoal): Promise<void> {
    return this.mutex.lock(async () => {
      goal.updated_at = new Date().toISOString();
      this.goals.set(goal.goal_id, goal);
      await this._flush();
    });
  }

  /**
   * P0 runtime gate — runtime-switch recovery.
   *
   * Used when the host starts under a runtime that's incompatible with the
   * goals currently persisted (e.g. node was on codex, switched to claude;
   * claude has its own /loop and anet must stay hands-off). Atomically:
   *
   *   1. Copy the live `goals.json` to `<path>.runtime-switched.<iso-ts>`
   *      so the cancelled goals are recoverable.
   *   2. Clear the in-memory map.
   *   3. Flush an empty store so the scheduler tick sees zero work.
   *
   * Returns the archive path on success, `undefined` if the live file
   * doesn't exist (nothing to archive).
   *
   * The mutex serialises this against any concurrent upsert/mutate/wake.
   */
  async archiveAndClear(reason: string): Promise<string | undefined> {
    return this.mutex.lock(async () => {
      if (!this.loaded) throw new Error("GoalStore not loaded — call load() first");
      let backup: string | undefined;
      if (existsSync(this.filePath)) {
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        backup = `${this.filePath}.runtime-switched.${ts}`;
        copyFileSync(this.filePath, backup);
      }
      this.goals.clear();
      await this._flush();
      // Reason is captured in the backup filename indirectly (timestamp +
      // suffix); the caller logs the human-readable reason. Touching the
      // backup with a sibling .reason file is overkill for P0.
      void reason;
      return backup;
    });
  }

  /**
   * Apply a status change atomically. Returns the post-update goal, or
   * `undefined` if the id is unknown.
   */
  async setStatus(goal_id: string, status: GoalStatus): Promise<AgentGoal | undefined> {
    return this.mutex.lock(async () => {
      const g = this.goals.get(goal_id);
      if (!g) return undefined;
      g.status = status;
      g.updated_at = new Date().toISOString();
      await this._flush();
      return g;
    });
  }

  /**
   * Mutate a goal under the store's mutex. Returns the (possibly mutated)
   * goal so the caller can read fields without a second lock. Returns
   * `undefined` when the id is unknown; the mutation function is *not*
   * invoked in that case so callers can rely on its no-side-effect
   * contract for non-existent ids.
   */
  async mutate(
    goal_id: string,
    mutator: (g: AgentGoal) => void | Promise<void>,
  ): Promise<AgentGoal | undefined> {
    return this.mutex.lock(async () => {
      const g = this.goals.get(goal_id);
      if (!g) return undefined;
      await mutator(g);
      g.updated_at = new Date().toISOString();
      await this._flush();
      return g;
    });
  }

  async delete(goal_id: string): Promise<boolean> {
    return this.mutex.lock(async () => {
      const existed = this.goals.delete(goal_id);
      if (existed) await this._flush();
      return existed;
    });
  }

  // Atomic write: tmp + rename. Same filesystem so rename is atomic on
  // POSIX. The tmp filename embeds pid + uuid to avoid clashes between
  // concurrent processes that share the same goals directory (the mutex
  // only protects within-process concurrency).
  private async _flush(): Promise<void> {
    if (!this.loaded) throw new Error("GoalStore not loaded — call load() first");
    const payload: GoalsFile = {
      version: GOALS_SCHEMA_VERSION,
      goals: Array.from(this.goals.values()),
    };
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp.${process.pid}.${randomUUID()}`;
    // If renameSync throws (cross-filesystem, EACCES on dest, etc.) the
    // tmp file would otherwise be left behind — uuid in the name keeps
    // it from colliding with future flushes, but the litter accumulates
    // forever. Best-effort unlink on failure so a broken flush doesn't
    // silently grow the directory.
    try {
      writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n");
      renameSync(tmp, this.filePath);
    } catch (e) {
      try { unlinkSync(tmp); } catch { /* ignore — tmp may not exist if writeFileSync threw */ }
      throw e;
    }
  }
}

/**
 * Build a fresh `AgentGoal` with sane defaults — `goal_id` is a UUID,
 * timestamps are now, status is `active`, `next_wake_at` is now + interval.
 *
 * P0 runtime gate: rejects claude-bucket runtime up front so the calling
 * `/loop` slash handler surfaces a clear "use Claude Code native /loop"
 * error instead of silently persisting a goal anet won't wake.
 */
export function newGoal(opts: {
  text: string;
  interval_ms: number;
  runtime: string;
  parent_task_id?: string;
  report_to?: string;
  // RFC-025 M1b — optional cron-lite schedule. When present, the
  // scheduler uses it (via computeNextWakeAt) to advance next_wake_at
  // every wake; when absent, behaviour falls back to interval_ms (the
  // pre-RFC-025 path) — existing goals.json files keep working unchanged.
  schedule?: import("./types").AgentGoalSchedule;
  // Optional node-default timezone for schedule.time_of_day / weekday
  // when the schedule itself didn't specify one. Caller passes the
  // resolved value (e.g. config.flags.timezone || 'Asia/Shanghai').
  default_tz?: string;
}): AgentGoal {
  // #144: no runtime gate. Pre-#144 this asserted the runtime was non-claude
  // on the (incorrect) premise that claude-agent-sdk had a native /loop.
  const now = new Date();
  // computeNextWakeAt: lazy import to keep `newGoal` zero-dep at module
  // load (store.ts already exports newGoal early). The pure schedule.ts
  // module has no transitive side-effects, so this require is safe.
  const { computeNextWakeAt } = require("./schedule") as typeof import("./schedule");
  const next = computeNextWakeAt(
    opts.schedule,
    now,
    opts.default_tz || "Asia/Shanghai",
    { fallback_interval_ms: opts.interval_ms },
  );
  return {
    goal_id: randomUUID(),
    text: opts.text,
    status: "active",
    interval_ms: opts.interval_ms,
    ...(opts.schedule ? { schedule: opts.schedule } : {}),
    next_wake_at: next.toISOString(),
    parent_task_id: opts.parent_task_id,
    report_to: opts.report_to,
    runtime: opts.runtime,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    progress_log: [],
  };
}

// ─────────────────────────────────────────────────────────────────────
// #144 round-6 — startup runtime dispatch (refined-B matrix).
//
// At agent-node boot, after `goalStore.load()`, the host inspects which
// runtime bucket it is starting under and what — if anything — is in
// `goals.json`. The result drives one of three actions:
//
//   - `ok`      : current runtime matches every persisted goal (or the
//                 store is empty). Boot normally, run the scheduler.
//                 This is the new claude-bucket behaviour too — see
//                 runtimeBucket comment above for why removing the
//                 claude skip is safe (SDK-spawned claude has no native
//                 /loop host).
//   - `archive` : current bucket can run, but goals.json holds goals
//                 for a DIFFERENT bucket (the alias was previously
//                 running under another SDK runtime). Caller archives +
//                 clears the store + boots clean, so we don't try to
//                 reuse thread/session IDs across incompatible SDKs.
//                 (Pre-#144 this was `fatal exit(1)` for codex↔grok,
//                 which crashed the user's node without guidance —
//                 hostile UX. Now: log + archive + continue.)
//   - `skip`    : unknown runtime bucket — refuse to schedule without
//                 a clear name → bucket mapping. Operator should check
//                 --runtime / RUNTIME env / config.runtime.
//
// This is a pure function over (current bucket, goal list); cli.ts
// dispatches on the verdict. Fully unit-covered.
// ─────────────────────────────────────────────────────────────────────

export type StartupAction =
  | { kind: "ok"; runScheduler: true }
  | { kind: "skip"; runScheduler: false; reason: string }
  | { kind: "archive"; runScheduler: true; reason: string; foreignCount: number; foreignBuckets: RuntimeBucket[] };

/**
 * Decide what to do at startup given the runtime the host is booting under
 * and the goals currently persisted. Pure; no I/O.
 */
export function decideStartupAction(
  currentBucket: RuntimeBucket,
  goals: AgentGoal[],
): StartupAction {
  // Unknown runtime label — refuse to schedule. Don't auto-archive
  // either; we don't know what bucket this is, so we can't safely
  // judge what's "foreign".
  if (currentBucket === "unknown") {
    return {
      kind: "skip",
      runScheduler: false,
      reason: `unknown runtime bucket — anet scheduler refuses to run; check --runtime / RUNTIME env / config.runtime`,
    };
  }

  // Only `active` goals matter — `complete` / `cancelled` / `failed` /
  // `paused` will not wake regardless of runtime, so they're not a
  // foreign-bucket concern.
  const activeGoals = goals.filter((g) => g.status === "active");

  // Any active goal whose runtime resolves to a DIFFERENT recognized
  // bucket is "foreign". An unknown-bucket goal (legacy / future SDK
  // label) is left alone — we already refuse to schedule unknown
  // buckets above, and an unknown-bucket goal in a known-bucket store
  // is harmless (it just won't have a matching runtime to dispatch).
  const foreign = activeGoals.filter((g) => {
    const b = runtimeBucket(g.runtime);
    return b !== currentBucket && b !== "unknown";
  });

  if (foreign.length > 0) {
    const foreignBuckets = uniqueBuckets(foreign);
    return {
      kind: "archive",
      runScheduler: true,
      reason: `${currentBucket} runtime started but goals.json holds ${foreign.length} ${foreignBuckets.join("/")} goal(s) — archiving + clearing so we don't reuse thread/session IDs across SDK boundaries. Backup recoverable on disk.`,
      foreignCount: foreign.length,
      foreignBuckets,
    };
  }

  return { kind: "ok", runScheduler: true };
}

function uniqueBuckets(goals: AgentGoal[]): RuntimeBucket[] {
  const out = new Set<RuntimeBucket>();
  for (const g of goals) out.add(runtimeBucket(g.runtime));
  return Array.from(out);
}
