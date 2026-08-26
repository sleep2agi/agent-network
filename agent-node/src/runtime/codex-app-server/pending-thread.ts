export interface CodexPendingThread {
  version: 1;
  threadId: string;
  serverUrl: string;
  marker: string;
}

export function validateCodexPendingThread(value: unknown, serverUrl: string | undefined, marker: string | undefined): CodexPendingThread {
  const p = value as Partial<CodexPendingThread> | null;
  if (!p || p.version !== 1 || typeof p.threadId !== "string" || !p.threadId
    || typeof p.serverUrl !== "string" || p.serverUrl !== serverUrl
    || typeof p.marker !== "string" || !marker || p.marker !== marker) {
    throw new Error("refusing corrupt or mismatched codexPendingThread recovery state");
  }
  return p as CodexPendingThread;
}
