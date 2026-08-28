import type { CodexAppServerRuntimeSession } from "../codex-app-server/runtime";

type OpenOwned = () => Promise<CodexAppServerRuntimeSession>;

/**
 * BTW never executes through the human TUI's shared WebSocket client. When
 * the ordinary bridge is shared, open a process-owned app-server and require
 * it to resume the exact same source thread. A stale/fallback identity is
 * closed before it can be published as capable.
 */
export async function selectOwnedSideThreadSession(
  shared: CodexAppServerRuntimeSession,
  openOwned: OpenOwned,
): Promise<{ session: CodexAppServerRuntimeSession; dedicated: boolean }> {
  if (shared.proc) return { session: shared, dedicated: false };
  const owned = await openOwned();
  if (!owned.proc || owned.threadId !== shared.threadId) {
    owned.client.close();
    owned.proc?.kill("SIGTERM");
    throw new Error("dedicated side-thread app-server did not resume the exact source thread");
  }
  return { session: owned, dedicated: true };
}
