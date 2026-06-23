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
   */
  async upsert(goal: AgentGoal): Promise<void> {
    return this.mutex.lock(async () => {
      goal.updated_at = new Date().toISOString();
      this.goals.set(goal.goal_id, goal);
      await this._flush();
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
 */
export function newGoal(opts: {
  text: string;
  interval_ms: number;
  runtime: string;
  parent_task_id?: string;
  report_to?: string;
}): AgentGoal {
  const now = new Date();
  return {
    goal_id: randomUUID(),
    text: opts.text,
    status: "active",
    interval_ms: opts.interval_ms,
    next_wake_at: new Date(now.getTime() + opts.interval_ms).toISOString(),
    parent_task_id: opts.parent_task_id,
    report_to: opts.report_to,
    runtime: opts.runtime,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    progress_log: [],
  };
}
