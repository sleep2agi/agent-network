export function bridgeClientHealthReceipt(remote: string, threadId: string): string {
  if (!remote || !threadId) throw new Error("bridge health receipt requires remote and thread");
  return `[codex-app-server] client-health role=bridge remote=${remote} thread=${threadId}`;
}

export interface MigratedCodexPendingThread {
  version: 1;
  threadId: string;
  serverUrl: string;
  marker: string;
}

const LOOPBACK_WS = /^wss?:\/\/127\.0\.0\.1:\d{1,5}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const THREAD_ID = /^[A-Za-z0-9_-]{8,200}$/;

/**
 * Move a crash-window deferred candidate onto the launcher's new owned
 * app-server generation. The old URL is an authority supplied by the same
 * private node config, not by the pending object itself; every mismatch is a
 * hard stop so restart never guesses or adopts a second thread.
 */
export function migrateCodexPendingThread(
  value: unknown,
  oldServerUrl: unknown,
  expectedOldMarker: unknown,
  newServerUrl: string,
  newMarker: string,
): MigratedCodexPendingThread {
  const p = value as Partial<MigratedCodexPendingThread> | null;
  if (!p || p.version !== 1 || typeof p.threadId !== "string" || !THREAD_ID.test(p.threadId)
    || typeof oldServerUrl !== "string" || !LOOPBACK_WS.test(oldServerUrl)
    || typeof p.serverUrl !== "string" || p.serverUrl !== oldServerUrl
    || typeof expectedOldMarker !== "string" || !UUID.test(expectedOldMarker)
    || typeof p.marker !== "string" || p.marker !== expectedOldMarker
    || !LOOPBACK_WS.test(newServerUrl) || !UUID.test(newMarker)) {
    throw new Error("refusing corrupt or mismatched codexPendingThread launcher recovery state");
  }
  return { version: 1, threadId: p.threadId, serverUrl: newServerUrl, marker: newMarker };
}

export function requirePromotedCodexPendingThread(value: unknown, pendingThreadId: string): string {
  const cfg = value as { codexThreadId?: unknown; codexPendingThread?: unknown } | null;
  if (!THREAD_ID.test(pendingThreadId) || !cfg || cfg.codexThreadId !== pendingThreadId
    || cfg.codexPendingThread !== undefined) {
    throw new Error("bridge reported ready without atomically promoting the exact pending Codex thread");
  }
  return pendingThreadId;
}

export function codexTuiLaunchArgs(remote: string, model: string, threadId?: string, dangerFullAccess = false): string[] {
  if (!LOOPBACK_WS.test(remote) || !model) throw new Error("refusing invalid Codex TUI launch identity");
  const args = threadId
    ? (THREAD_ID.test(threadId) ? ["resume", "--remote", remote, threadId, "-m", model] : [])
    : ["--remote", remote, "-m", model];
  if (args.length === 0) throw new Error("refusing invalid Codex TUI thread identity");
  if (dangerFullAccess) args.push("--dangerously-bypass-approvals-and-sandbox");
  return args;
}

export async function assertPendingServerQuiesced(
  serverUrl: unknown,
  isListening: (port: number) => boolean | Promise<boolean>,
): Promise<void> {
  if (typeof serverUrl !== "string" || !LOOPBACK_WS.test(serverUrl)) {
    throw new Error("invalid previous pending app-server URL");
  }
  const port = Number(new URL(serverUrl).port);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || await isListening(port)) {
    throw new Error("previous pending app-server identity did not quiesce");
  }
}
