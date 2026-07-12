// RFC-030 Wave 1B — single upstream request-id allocator (P0 fix).
//
// The production gateway holds exactly ONE connection to codex app-server,
// shared by two request origins:
//   - "internal": the gateway's own RPCs (initialize, thread/resume,
//     turn/start for agent tasks) issued through CodexAppServerClient,
//   - "tui": human TUI requests proxied by A's protocol layer (id-rewritten
//     onto the upstream socket).
//
// Two independent `nextId++` counters on one socket WILL collide. This mux
// is the single allocator both sides share; responses route back to their
// origin by id ownership. Unknown ids are refused (fail closed) — they
// surface as `orphan` so tests can assert nothing silently resolves.

export type UpstreamOrigin = "internal" | "tui";

export interface UpstreamRequestMux {
  /** Allocate the next unique upstream id for `origin`. */
  allocate(origin: UpstreamOrigin): number;
  /** Who owns this id (undefined → unknown/never allocated/already released). */
  ownerOf(id: number): UpstreamOrigin | undefined;
  /** Release after the response has been routed (or the request abandoned). */
  release(id: number): void;
}

export class SharedUpstreamMux implements UpstreamRequestMux {
  private next = 1;
  private owners = new Map<number, UpstreamOrigin>();

  allocate(origin: UpstreamOrigin): number {
    const id = this.next++;
    this.owners.set(id, origin);
    return id;
  }

  ownerOf(id: number): UpstreamOrigin | undefined {
    return this.owners.get(id);
  }

  release(id: number): void {
    this.owners.delete(id);
  }

  /**
   * TUI disconnect (Checkpoint-3 delta 4): release ONLY tui-owned ids.
   * Internal scheduler pendings survive — an in-flight agent turn keeps
   * its response routable across a TUI drop. Returns the released ids so
   * A's proxy can reject its local resolvers.
   */
  drainProxiedTui(): number[] {
    const released: number[] = [];
    for (const [id, origin] of this.owners) {
      if (origin === "tui") {
        this.owners.delete(id);
        released.push(id);
      }
    }
    return released;
  }

  /**
   * Upstream shutdown/restart ONLY (lifecycle-driven): drop everything.
   * The lifecycle layer is responsible for explicitly rejecting /
   * reconciling internal resolvers after calling this.
   */
  drainAll(): number[] {
    const released = [...this.owners.keys()];
    this.owners.clear();
    return released;
  }

  /** Introspection for tests. */
  outstanding(): number {
    return this.owners.size;
  }
}
