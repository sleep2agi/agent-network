// #146 PR-4 — live alias resolver.
//
// The agent-node process used to freeze its display alias into a
// module-level `const ALIAS` at startup (resolveAlias() in cli.ts). Every
// subsequent commhub interaction — register / reportStatus / sendReply /
// inbox poll / commhub_send_task tool / #213 resume hint — read that
// const, so a rename committed on the server side never propagated to
// the node's outbound traffic until the next restart. The downstream
// effects fan out into #146 / #203 / #213 routing drift.
//
// PR-1 (commit 2dc166c) gave us the server-side handles we need to fix
// this: `tasks.from_node_id` / `inbox.node_id` columns, the
// `rename-committed` eventBus, and `list_tasks` accepting a
// `from_node_id` filter. PR-3 (commit e0aa4d8) exposes the immutable
// `COMMHUB_NODE_ID` env into every node-launched process. This module
// is the runtime piece that ties them together: a 30 s LRU cache around
// "what does the server currently call me?" so 42 ALIAS references in
// cli.ts can pick up the live value without each becoming its own diff.
//
// Design contract:
//   - current() is synchronous, returns the last-known alias. Use it
//     for log lines, file paths, and any hot path where waiting on a
//     network round-trip is unacceptable. It is bound to the startup
//     snapshot until the first refresh() lands.
//   - refresh() is async, returns the alias, hitting the cache when
//     warm and the server when stale. Use it for the 8 sender-side
//     commhub calls where staleness causes the #146 family of bugs.
//     A failed fetch keeps the cached value (graceful fallback) and
//     bumps the cache timestamp so we don't hammer a sick hub.
//   - set() force-installs the alias. Wire it to the `report_status`
//     server response so a successful register / heartbeat is treated
//     as canonical confirmation.
//   - The fetchCanonicalAlias hook is injected so unit tests can stub
//     it without spinning a server, and so cli.ts can choose its own
//     transport (REST `/api/status` or MCP `get_session_status`).

export type AliasDriftSource = "fetch" | "snapshot";

export type CurrentAliasOptions = {
  /** Startup snapshot — the alias the process resolved from
   * --alias flag / env / config at boot. Used until the first refresh() lands. */
  initialAlias: string;
  /** Immutable node identity. If empty / null, refresh() short-circuits
   * to the cached value because there is nothing to look up by. */
  nodeId: string | null;
  /** LRU cache TTL in ms. Default 30_000 (30 s). 0 disables caching. */
  cacheTtlMs?: number;
  /** Fetch hook — given a node_id, returns the server's canonical alias
   * for that node, or null when the server doesn't know.
   * MUST be allowed to throw; the resolver catches and falls back. */
  fetchCanonicalAlias: (nodeId: string) => Promise<string | null>;
  /** Drift hook — called when the resolved alias actually changes.
   * Use for `log()` / `warn()` so operators see the transition in node logs. */
  onDrift?: (oldAlias: string, newAlias: string, source: AliasDriftSource) => void;
  /** Optional logger for the "fetch failed, keeping cache" warning. */
  warn?: (msg: string) => void;
};

export class CurrentAliasResolver {
  private cachedAlias: string;
  private cachedAt: number;
  private fetchInFlight: Promise<string> | null = null;
  private readonly cacheTtlMs: number;

  constructor(private readonly opts: CurrentAliasOptions) {
    this.cachedAlias = opts.initialAlias;
    this.cachedAt = 0; // 0 means "never fetched", so the first refresh() will hit the server
    this.cacheTtlMs = opts.cacheTtlMs ?? 30_000;
  }

  /**
   * Synchronous read — returns the last-known alias without any I/O.
   * Cheap. Use for log lines, file paths, and any per-call hot path
   * where waiting on a network round-trip is unacceptable.
   */
  current(): string {
    return this.cachedAlias;
  }

  /**
   * Async read — returns the alias, refreshing from the server when
   * the cache is stale. NEVER throws: on fetch failure, keeps the
   * cached value and bumps the timestamp so we don't hammer a sick
   * hub. A `null` from the fetch hook is treated as "server doesn't
   * know yet" and is also fall-back-to-cache.
   *
   * Concurrent callers during a fetch dedupe onto the same promise,
   * so a burst of 8 sendReply calls just after expiry causes exactly
   * one /api/status round-trip, not eight.
   */
  async refresh(nowMs: number = Date.now()): Promise<string> {
    if (!this.opts.nodeId) return this.cachedAlias;
    // cachedAt === 0 is the "never fetched" sentinel — treat as always
    // stale so the first refresh() always hits the server even when
    // called at logical time 0 (which would otherwise look fresh under
    // a naive `nowMs - 0 < ttl` check).
    if (this.cacheTtlMs > 0 && this.cachedAt > 0 && nowMs - this.cachedAt < this.cacheTtlMs) {
      return this.cachedAlias;
    }
    if (this.fetchInFlight) return this.fetchInFlight;

    const inflight = (async () => {
      try {
        const fetched = await this.opts.fetchCanonicalAlias(this.opts.nodeId!);
        if (fetched && fetched.length > 0 && fetched !== this.cachedAlias) {
          this.opts.onDrift?.(this.cachedAlias, fetched, "fetch");
          this.cachedAlias = fetched;
        }
      } catch (e: any) {
        this.opts.warn?.(`currentAlias: fetch failed (${e?.message ?? e}); keeping cached value "${this.cachedAlias}"`);
      } finally {
        // Always bump cachedAt so a sick hub doesn't get hammered.
        this.cachedAt = nowMs;
        this.fetchInFlight = null;
      }
      return this.cachedAlias;
    })();

    this.fetchInFlight = inflight;
    return inflight;
  }

  /**
   * Force-install the alias. Use this when a server response (e.g.
   * report_status) authoritatively confirms the canonical alias for
   * this node, so we don't have to wait for the next refresh() tick
   * to pick it up.
   *
   * The drift hook fires with source = "snapshot" so log readers can
   * distinguish proactive server-push updates from cache-driven
   * refresh updates.
   */
  set(alias: string, nowMs: number = Date.now()): void {
    if (!alias) return;
    if (alias !== this.cachedAlias) {
      this.opts.onDrift?.(this.cachedAlias, alias, "snapshot");
      this.cachedAlias = alias;
    }
    this.cachedAt = nowMs;
  }

  // ── Visible for tests ──

  get nodeId(): string | null {
    return this.opts.nodeId;
  }

  /** Milliseconds since the last cache touch. Useful for assertions on TTL behaviour. */
  ageMs(nowMs: number = Date.now()): number {
    return this.cachedAt === 0 ? Number.POSITIVE_INFINITY : nowMs - this.cachedAt;
  }

  /** Whether the cache currently considers itself fresh. */
  isFresh(nowMs: number = Date.now()): boolean {
    return this.cachedAt !== 0 && nowMs - this.cachedAt < this.cacheTtlMs;
  }
}
