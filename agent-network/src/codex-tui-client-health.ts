export function bridgeClientHealthReceipt(remote: string, threadId: string): string {
  if (!remote || !threadId) throw new Error("bridge health receipt requires remote and thread");
  return `[codex-app-server] client-health role=bridge remote=${remote} thread=${threadId}`;
}
