import { existsSync, readFileSync } from "node:fs";
import type { IMCorrelationStore, IMTaskCorrelation } from "./types";
import { atomicWritePrivateJson, repairPrivateFilePermissions } from "../private-state";

type TerminalStatus = "completed" | "failed" | "timeout";

interface SeenEntry {
  taskId: string;
  seenAt: number;
}

interface StoredCorrelation extends IMTaskCorrelation {
  updatedAt: number;
}

interface StoreFile {
  version: 1;
  seen: Record<string, SeenEntry>;
  correlations: Record<string, StoredCorrelation>;
}

export interface JsonIMCorrelationStoreOptions {
  now?: () => number;
  /** How long idempotency keys remain valid. Defaults to 24h. */
  seenTtlMs?: number;
  /** How long terminal correlations remain queryable. Defaults to 24h. */
  terminalTtlMs?: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const TERMINAL_STATUSES = new Set<string>(["completed", "failed", "timeout"]);

/**
 * Small durable store for RFC-020 §2.9④ / §4.4 correlation state.
 *
 * The first gateway PR needs this as a standalone data structure before the
 * bridge is rewired: idempotency keys survive process restart, and task replies
 * can be routed back to their originating IM conversation.
 */
export class JsonIMCorrelationStore implements IMCorrelationStore {
  private readonly now: () => number;
  private readonly seenTtlMs: number;
  private readonly terminalTtlMs: number;

  constructor(
    private readonly path: string,
    options: JsonIMCorrelationStoreOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.seenTtlMs = options.seenTtlMs ?? DEFAULT_TTL_MS;
    this.terminalTtlMs = options.terminalTtlMs ?? DEFAULT_TTL_MS;
  }

  async hasSeen(idempotencyKey: string): Promise<string | null> {
    const state = this.load();
    const entry = state.seen[idempotencyKey];
    if (!entry) return null;
    if (this.isExpired(entry.seenAt, this.seenTtlMs, this.now())) return null;
    return entry.taskId;
  }

  async recordSeen(idempotencyKey: string, taskId: string): Promise<void> {
    const state = this.load();
    state.seen[idempotencyKey] = { taskId, seenAt: this.now() };
    this.save(state);
  }

  async getCorrelation(taskId: string): Promise<IMTaskCorrelation | null> {
    const state = this.load();
    const entry = state.correlations[taskId];
    if (!entry) return null;
    const { updatedAt: _updatedAt, ...correlation } = entry;
    return correlation;
  }

  async putCorrelation(taskId: string, correlation: IMTaskCorrelation): Promise<void> {
    const state = this.load();
    state.correlations[taskId] = {
      ...correlation,
      updatedAt: this.now(),
    };
    this.save(state);
  }

  async updateStatus(taskId: string, status: IMTaskCorrelation["status"]): Promise<void> {
    const state = this.load();
    const entry = state.correlations[taskId];
    if (!entry) return;
    state.correlations[taskId] = {
      ...entry,
      status,
      updatedAt: this.now(),
    };
    this.save(state);
  }

  async gc(now: number): Promise<{ removed: number }> {
    const state = this.load();
    let removed = 0;

    for (const [key, entry] of Object.entries(state.seen)) {
      if (this.isExpired(entry.seenAt, this.seenTtlMs, now)) {
        delete state.seen[key];
        removed++;
      }
    }

    for (const [taskId, entry] of Object.entries(state.correlations)) {
      if (isTerminalStatus(entry.status) && this.isExpired(entry.updatedAt, this.terminalTtlMs, now)) {
        delete state.correlations[taskId];
        removed++;
      }
    }

    if (removed > 0) this.save(state);
    return { removed };
  }

  private isExpired(timestamp: number, ttlMs: number, now: number): boolean {
    return now - timestamp >= ttlMs;
  }

  private load(): StoreFile {
    if (!existsSync(this.path)) return emptyStore();
    repairPrivateFilePermissions(this.path);
    const parsed = JSON.parse(readFileSync(this.path, "utf-8")) as Partial<StoreFile>;
    return {
      version: 1,
      seen:
        parsed && typeof parsed.seen === "object" && parsed.seen
          ? parsed.seen as Record<string, SeenEntry>
          : {},
      correlations:
        parsed && typeof parsed.correlations === "object" && parsed.correlations
          ? parsed.correlations as Record<string, StoredCorrelation>
          : {},
    };
  }

  private save(state: StoreFile): void {
    atomicWritePrivateJson(this.path, state);
  }
}

export function createJsonIMCorrelationStore(
  path: string,
  options?: JsonIMCorrelationStoreOptions,
): IMCorrelationStore {
  return new JsonIMCorrelationStore(path, options);
}

function emptyStore(): StoreFile {
  return {
    version: 1,
    seen: {},
    correlations: {},
  };
}

function isTerminalStatus(status: IMTaskCorrelation["status"]): status is TerminalStatus {
  return TERMINAL_STATUSES.has(status);
}
