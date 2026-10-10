/** Session id published to the Hub. Mutable runtimes report the id updated
 *  during the process, not the value captured at boot. */
export function reportedSessionId(runtime: string, sessions: {
  grok?: string;
  claude?: string;
  cursor?: string;
  boot?: string;
}): string | undefined {
  if (runtime === "grok") return sessions.grok || undefined;
  if (runtime === "claude") return sessions.claude || undefined;
  if (runtime === "cursor") return sessions.cursor || undefined;
  return sessions.boot || undefined;
}
